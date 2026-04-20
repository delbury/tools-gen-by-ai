const DOUBAO_SELECTORS = {
  // 查找唯一的或者最大的 textarea 作为输入框，Doubao 中通常是一个 ID 为 chat-input 或者是唯一的 textarea
  textarea: 'textarea',
  fileInput: 'input[type="file"]',
  // 可以通过发送图标或者回车
  messageContainer: '[data-testid="chat-message"], .message-item, .chat-message', // Heuristic selectors
};

class DoubaoAgent extends BaseAgent {
  constructor() {
    super('doubao');
  }

  async runFlow(text, imageBase64, imageName) {
    console.log('[Doubao] Starting flow...');
    
    // 强制每次新开对话
    await this.clickNewChat();
    
    // We get all textareas and assume the active one is for chat input (usually at the bottom)
    const textareas = await this.waitForElements(DOUBAO_SELECTORS.textarea, 15000);
    const textarea = textareas[textareas.length - 1]; // typically the last one
    
    if (!textarea) throw new Error('Cannot find chat input textarea');
    console.log('[Doubao] Found textarea');

    if (imageBase64) {
      console.log('[Doubao] Uploading image...');
      // 豆包上传图片通常也是一个隐藏的 file input，可能会限制 accept
      const fileInputs = Array.from(document.querySelectorAll(DOUBAO_SELECTORS.fileInput));
      // usually the one with accept="image/*" or similar, or just the first one
      const fileInput = fileInputs.find(input => input.accept && input.accept.includes('image')) || fileInputs[0];
      
      if (fileInput) {
        await this.uploadImageToFileSelector(fileInput, imageBase64, imageName);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        console.warn('[Doubao] File input not found.');
      }
    }

    if (text) {
      console.log('[Doubao] Inputting text...');
      await this.inputText(textarea, text);
      await new Promise(r => setTimeout(r, 500));
    }

    const initialMessages = document.querySelectorAll(DOUBAO_SELECTORS.messageContainer).length;

    console.log('[Doubao] Submitting...');
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    
    await new Promise(r => setTimeout(r, 1000));
    // Fallback: look for a button with SVG
    if (textarea.value === text) {
      const parent = textarea.closest('div[class*="input"], div[class*="chat"]') || document.body;
      const buttons = parent.querySelectorAll('button');
      if (buttons.length > 0) {
        // Assume the last button or the one without text is the send button
        buttons[buttons.length - 1].click();
      }
    }

    console.log('[Doubao] Waiting for response...');
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
        const messages = document.querySelectorAll(DOUBAO_SELECTORS.messageContainer);
        // Sometimes doubao updates DOM drastically, so checking length > initial might be naïve,
        // but works as a heuristic. Use innerText length of the last element.
        if (messages.length > 0 && messages.length >= initialMessageCount) {
          const lastMessage = messages[messages.length - 1];
          const textLength = lastMessage.textContent.length;
          
          if (Date.now() - lastChangeTime > 3000 && textLength > 0 && messages.length > initialMessageCount) {
            clearInterval(checkInterval);
            if (timeoutId) clearTimeout(timeoutId);
            console.log('[Doubao] Generation complete');
            
            const images = Array.from(lastMessage.querySelectorAll('img')).map(img => img.src);
            resolve({
              text: lastMessage.innerText || lastMessage.textContent,
              images: images
            });
          }
        }
      }, 1000);

      const observer = new MutationObserver(() => {
        const messages = document.querySelectorAll(DOUBAO_SELECTORS.messageContainer);
        if (messages.length > initialMessageCount) {
          lastChangeTime = Date.now();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });

      timeoutId = setTimeout(() => {
        clearInterval(checkInterval);
        observer.disconnect();
        
        const messages = document.querySelectorAll(DOUBAO_SELECTORS.messageContainer);
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
