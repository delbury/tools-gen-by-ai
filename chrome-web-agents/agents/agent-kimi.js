const KIMI_SELECTORS = {
  // kimi sometimes uses a contenteditable div: div.ProseMirror or similar
  editor: 'div[contenteditable="true"], textarea',
  fileInput: 'input[type="file"]',
  messageContainer: '.message-item, [data-testid*="message"], div[class*="Message"], .chat-content-item',
};

class KimiAgent extends BaseAgent {
  constructor() {
    super('kimi');
  }

  // Override to prevent Kimi from opening a new tab
  async clickNewChat() {
    console.log('[Kimi] Skipping explicit New Chat click to prevent opening a new tab (background.js already handles new chat via URL).');
    return true;
  }

  async runFlow(text, imageBase64, imageName) {
    console.log('[Kimi] Starting flow...');
    
    // 强制每次新开对话
    await this.clickNewChat();

    const editors = await this.waitForElements(KIMI_SELECTORS.editor, 15000);
    // last one is usually the input area
    const editor = editors[editors.length - 1];
    
    if (!editor) throw new Error('Cannot find Kimi input editor');
    console.log('[Kimi] Found editor');

    editor.focus();

    if (imageBase64) {
      console.log('[Kimi] Uploading image via paste...');
      try {
        const file = this.base64ToFile(imageBase64, imageName || 'upload.png');
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        const event = new ClipboardEvent('paste', {
          clipboardData: dataTransfer,
          bubbles: true,
          cancelable: true
        });
        editor.dispatchEvent(event);
        await new Promise(r => setTimeout(r, 2500)); // wait for Kimi to process the image
      } catch(e) {
        console.error('[Kimi] Paste image error:', e);
      }
    }

    if (text) {
      console.log('[Kimi] Inputting text via paste/commands...');
      try {
        const dataTransfer = new DataTransfer();
        dataTransfer.setData('text/plain', text);
        const event = new ClipboardEvent('paste', {
          clipboardData: dataTransfer,
          bubbles: true,
          cancelable: true
        });
        editor.dispatchEvent(event);
        
        // Also use insertText fallback since it strictly mimics user input
        document.execCommand("insertText", false, text);
        
        // Final fallback just in case
        if (!editor.textContent && editor.tagName.toLowerCase() === 'textarea') {
           this.inputText(editor, text);
        }
        await new Promise(r => setTimeout(r, 800));
      } catch(e) {
         console.error('[Kimi] Paste text error:', e);
      }
    }

    const initialMessageElements = document.querySelectorAll(KIMI_SELECTORS.messageContainer);
    const initialMessages = initialMessageElements.length;

    console.log('[Kimi] Submitting...');
    const enterEventOptions = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true
    };
    editor.dispatchEvent(new KeyboardEvent('keydown', enterEventOptions));
    editor.dispatchEvent(new KeyboardEvent('keypress', enterEventOptions));
    editor.dispatchEvent(new KeyboardEvent('keyup', enterEventOptions));
    
    await new Promise(r => setTimeout(r, 1000));
    // If it's a contenteditable, sometimes we need to clear it or click the send button manually
    if (editor.textContent && editor.textContent.trim().length > 0) {
       console.log('[Kimi] Text still in editor, attempting to click send button...');
       const sendBtnContainer = document.querySelector('.send-button-container, .send-button');
       if (sendBtnContainer) {
           console.log('[Kimi] Found specific send button, clicking...');
           sendBtnContainer.click();
           sendBtnContainer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
           sendBtnContainer.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
       } else {
           const parent = editor.closest('div[class*="input"], div[class*="chat"], div.chat-editor-action') || document.body;
           const buttons = parent.querySelectorAll('button, div[class*="send"]');
           for (const btn of Array.from(buttons).reverse()) {
             if (btn.querySelector('svg[name="Send"]') || btn.querySelector('svg.send-icon') || btn.textContent.includes('发送')) {
               btn.click();
               break;
             }
           }
       }
    }

    console.log('[Kimi] Waiting for response...');
    return await this.waitForResponse(initialMessages);
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

  async waitForResponse(initialMessageCount) {
    return new Promise((resolve, reject) => {
      let timeoutId;
      let lastChangeTime = Date.now();
      
      const checkInterval = setInterval(() => {
        const messages = document.querySelectorAll(KIMI_SELECTORS.messageContainer);
        if (messages.length > initialMessageCount) {
          const lastMessage = messages[messages.length - 1];
          const extractedText = this.extractStructuredContent(lastMessage);
          
          // 必须严格匹配具体的完成按钮（如 Copy 复制按钮），不能只匹配容器，因为容器在生成中就已经存在
          const isDoneByAction = !!lastMessage.querySelector('svg[name="Copy"], svg[name="Refresh"], [aria-label*="复制"]');
          
          if (isDoneByAction || (Date.now() - lastChangeTime > 10000 && extractedText.trim().length > 0)) {
            // 如果没有明确标志，且文本非常短（可能只是提示语或搜索中），且时间还未超过20秒，继续等待
            if (!isDoneByAction && extractedText.trim().length < 10 && Date.now() - lastChangeTime < 20000) {
              return;
            }
            
            clearInterval(checkInterval);
            if (timeoutId) clearTimeout(timeoutId);
            console.log('[Kimi] Generation complete', { isDoneByAction });
            
            resolve({
              text: extractedText,
              images: []
            });
          }
        }
      }, 1000);

      const observer = new MutationObserver(() => {
        const messages = document.querySelectorAll(KIMI_SELECTORS.messageContainer);
        if (messages.length > initialMessageCount) {
          lastChangeTime = Date.now();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });

      timeoutId = setTimeout(() => {
        clearInterval(checkInterval);
        observer.disconnect();
        
        const messages = document.querySelectorAll(KIMI_SELECTORS.messageContainer);
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

new KimiAgent();
