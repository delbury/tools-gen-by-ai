const KIMI_SELECTORS = {
  // kimi sometimes uses a contenteditable div: div.ProseMirror or similar
  editor: 'div[contenteditable="true"], textarea',
  fileInput: 'input[type="file"]',
  messageContainer: '.message-item, [data-testid*="message"], div[class*="Message"]',
};

class KimiAgent extends BaseAgent {
  constructor() {
    super('kimi');
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

    if (imageBase64) {
      console.log('[Kimi] Uploading image...');
      // Kimi has File inputs, potentially multiple. Getting the one without disabled attribute
      const fileInputs = Array.from(document.querySelectorAll(KIMI_SELECTORS.fileInput)).reverse();
      const fileInput = fileInputs.find(i => !i.disabled) || fileInputs[0];
      
      if (fileInput) {
        await this.uploadImageToFileSelector(fileInput, imageBase64, imageName);
        await new Promise(r => setTimeout(r, 2500)); // wait for Kimi to process the image
      } else {
        console.warn('[Kimi] File input not found.');
      }
    }

    if (text) {
      console.log('[Kimi] Inputting text...');
      await this.inputText(editor, text);
      await new Promise(r => setTimeout(r, 500));
    }

    const initialMessageElements = document.querySelectorAll(KIMI_SELECTORS.messageContainer);
    const initialMessages = initialMessageElements.length;

    console.log('[Kimi] Submitting...');
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    
    await new Promise(r => setTimeout(r, 1000));
    // If it's a contenteditable, sometimes we need to clear it or click the send button manually
    if (editor.textContent && editor.textContent.includes(text)) {
       // try finding a send button. Usually it's next to the editor
       const parent = editor.closest('div[class*="input"], div[class*="chat"]') || document.body;
       const buttons = parent.querySelectorAll('button');
       for (const btn of Array.from(buttons).reverse()) {
         if (btn.querySelector('svg') || btn.textContent.includes('发送')) {
           btn.click();
           break;
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
          const textLength = lastMessage.textContent.length;
          
          if (Date.now() - lastChangeTime > 3000 && textLength > 0) {
            clearInterval(checkInterval);
            if (timeoutId) clearTimeout(timeoutId);
            console.log('[Kimi] Generation complete');
            
            const images = Array.from(lastMessage.querySelectorAll('img')).map(img => img.src);
            resolve({
              text: lastMessage.innerText || lastMessage.textContent,
              images: images
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
