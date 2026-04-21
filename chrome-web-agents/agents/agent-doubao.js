const DOUBAO_SELECTORS = {
  // 查找唯一的或者最大的 textarea 作为输入框，Doubao 中通常是一个 ID 为 chat-input 或者是唯一的 textarea 或者 contenteditable div
  textarea: '#chat-input, textarea.semi-input-textarea, textarea[placeholder*="发消息"], textarea, div[contenteditable="true"]',
  fileInput: 'input[type="file"]',
  // 只计算机器人的回复（或者文本内容部分），避免取到用户的消息导致提前结束
  messageContainer: '[data-testid="bot_message_content"], [class*="markdown-body"], .flow-markdown-body, div[class*="bot-interactive-message"], [class*="message-content"], [data-testid*="message_content"]',
};

class DoubaoAgent extends BaseAgent {
  constructor() {
    super('doubao');
  }

  async pasteImageToElement(element, imageBase64, filename) {
    if (!imageBase64) return;
    try {
      element.focus();
      const file = this.base64ToFile(imageBase64, filename || 'upload.png');
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const event = new ClipboardEvent('paste', {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true
      });
      element.dispatchEvent(event);
      console.log('[Doubao] Image pasted via ClipboardEvent');
    } catch(e) {
      console.error('[Doubao] Paste image error:', e);
    }
  }

  getBotMessages() {
    const allMessages = document.querySelectorAll(DOUBAO_SELECTORS.messageContainer);
    return Array.from(allMessages).filter(el => {
      // 明确排除带有 user 标识的元素
      if (el.getAttribute('data-testid')?.includes('user')) return false;
      if (el.closest('[class*="user"], [data-testid*="user"], [class*="User"]')) return false;
      // 排除输入框区域可能被误判的元素
      if (el.closest('#chat-input, textarea, div[contenteditable="true"], [class*="input-container"], [class*="chat-input"]')) return false;
      return true;
    });
  }

  async runFlow(text, imageBase64, imageName) {
    console.log('[Doubao] Starting flow...');
    
    // 强制每次新开对话
    await this.clickNewChat();
    
    // We get all textareas and assume the active one is for chat input (usually at the bottom)
    const textareas = await this.waitForElements(DOUBAO_SELECTORS.textarea, 15000);
    const textarea = Array.from(textareas).find(t => t.id === 'chat-input' || (t.placeholder && t.placeholder.includes('消息'))) || textareas[textareas.length - 1]; // typically the last one
    
    if (!textarea) throw new Error('Cannot find chat input textarea');
    console.log('[Doubao] Found textarea');

    if (imageBase64) {
      console.log('[Doubao] Uploading image...');
      // 豆包上传图片通常也是一个隐藏的 file input，可能会限制 accept
      let fileInputs = Array.from(document.querySelectorAll(DOUBAO_SELECTORS.fileInput));
      
      // usually the one with accept="image/*" or similar, or just the first one
      const fileInput = fileInputs.find(i => !i.disabled && i.accept && i.accept.includes('image')) || fileInputs.find(i => !i.disabled) || fileInputs[0];
      
      if (fileInput) {
        await this.uploadImageToFileSelector(fileInput, imageBase64, imageName);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        console.warn('[Doubao] File input not found, falling back to pasting directly.');
        await this.pasteImageToElement(textarea, imageBase64, imageName);
        await new Promise(r => setTimeout(r, 2500));
      }
    }

    if (text) {
      console.log('[Doubao] Inputting text...');
      await this.inputText(textarea, text);
      await new Promise(r => setTimeout(r, 800));
    }

    const initialMsgs = this.getBotMessages();
    const initialMessages = initialMsgs.length;
    const initialLastText = initialMsgs.length > 0 ? (initialMsgs[initialMsgs.length - 1].innerText || initialMsgs[initialMsgs.length - 1].textContent) : '';

    console.log('[Doubao] Submitting...');
    const enterEventOptions = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true
    };
    textarea.dispatchEvent(new KeyboardEvent('keydown', enterEventOptions));
    textarea.dispatchEvent(new KeyboardEvent('keypress', enterEventOptions));
    textarea.dispatchEvent(new KeyboardEvent('keyup', enterEventOptions));
    
    await new Promise(r => setTimeout(r, 1000));
    // Fallback: look for a button with SVG
    const currentValue = textarea.value !== undefined ? textarea.value : textarea.textContent;
    if (currentValue && currentValue.trim().length > 0 && currentValue.includes(text.substring(0, Math.min(5, text.length)))) {
      const parent = textarea.closest('div[class*="input"], div[class*="chat"]') || document.body;
      const buttons = parent.querySelectorAll('button:not([disabled])');
      for (const btn of Array.from(buttons).reverse()) {
        if (btn.querySelector('svg') || btn.textContent.includes('发送')) {
          btn.click();
          break;
        }
      }
    }

    console.log('[Doubao] Waiting for response...');
    return await this.waitForResponse(initialMessages, initialLastText);
  }

  async waitForElements(selector, timeout) {
    const startTime = Date.now();
    return new Promise((resolve, reject) => {
      let elements = document.querySelectorAll(selector);
      if (elements.length > 0) return resolve(elements);

      const interval = setInterval(() => {
        elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          clearInterval(interval);
          resolve(elements);
        } else if (Date.now() - startTime > timeout) {
          clearInterval(interval);
          reject(`Timeout finding ${selector}`);
        }
      }, 500);
    });
  }

  async waitForResponse(initialMessageCount, initialLastText) {
    return new Promise((resolve, reject) => {
      let timeoutId;
      let prevTextLength = -1;
      let unchangedTime = 0;
      let generationStarted = false;
      
      const checkInterval = setInterval(() => {
        const messages = this.getBotMessages();
        if (messages.length === 0) return;

        const lastMessage = messages[messages.length - 1];
        const currentText = lastMessage.innerText || lastMessage.textContent;
        const currentLength = currentText.trim().length;

        if (messages.length > initialMessageCount || (currentText !== initialLastText && currentLength > 0)) {
          generationStarted = true;
        }

        if (generationStarted) {
          if (currentLength > 0) {
            // "Loading" text heuristics or just general text
            if (Math.abs(currentLength - prevTextLength) <= 2) {
              // Only start counting idle time if it's likely not the initial "thinking..." placeholder
              // Or if we wait long enough
              unchangedTime += 1000;
            } else {
              unchangedTime = 0;
              prevTextLength = currentLength;
            }

            // If text has stayed exactly the same length for 4 seconds, we consider it done
            if (unchangedTime >= 4000) {
              clearInterval(checkInterval);
              if (timeoutId) clearTimeout(timeoutId);
              console.log('[Doubao] Generation complete');
              
              const images = Array.from(lastMessage.querySelectorAll('img')).map(img => img.src);
              resolve({
                text: currentText,
                images: images
              });
            }
          }
        }
      }, 1000);

      timeoutId = setTimeout(() => {
        clearInterval(checkInterval);
        
        const messages = this.getBotMessages();
        if (messages.length > initialMessageCount) {
          const lastMessage = messages[messages.length - 1];
          resolve({
            text: (lastMessage.innerText || lastMessage.textContent) + '\n[超时截止]',
            images: []
          });
        } else {
          reject('Wait for response timed out after 120 seconds');
        }
      }, 120000);
    });
  }
}

new DoubaoAgent();
