const DEEPSEEK_SELECTORS = {
  textarea: '#chat-input',
  fileInput: 'input[type="file"]',
  // Send button in deepseek is usually a div/button adjacent to the input.
  // We can look for a button or just dispatch Enter. Let's try Enter first, but also provide a fallback.
  sendButton: 'div[role="button"][style*="cursor: pointer"], button',
  messageContainer: '.ds-markdown', 
  loadingClass: 'loading', // Heuristics
  // A typical way to know deepseek is generating is observing the presence of stop button 
  // or observing mutations in the latest message container until they stop for a while.
};

class DeepSeekAgent extends BaseAgent {
  constructor() {
    super('deepseek');
  }

  async runFlow(text, imageBase64, imageName) {
    console.log('[DeepSeek] Starting flow...');
    
    // 强制每次新开对话
    await this.clickNewChat();
    
    // 1. 等待页面加载完成，获取输入框 (id="chat-input")
    const textarea = await this.waitForElement(DEEPSEEK_SELECTORS.textarea, 15000);
    console.log('[DeepSeek] Found textarea');

    // 2. 如果有图片，先上传图片
    if (imageBase64) {
      console.log('[DeepSeek] Uploading image...');
      // 找 file input
      const fileInput = await this.waitForElement(DEEPSEEK_SELECTORS.fileInput, 5000)
                              .catch(() => document.querySelector(DEEPSEEK_SELECTORS.fileInput));
      
      if (fileInput) {
        await this.uploadImageToFileSelector(fileInput, imageBase64, imageName);
        // Wait for image thumbnail to appear (heuristic delay)
        await new Promise(r => setTimeout(r, 2000));
      } else {
        console.warn('[DeepSeek] File input not found, skipping image upload.');
      }
    }

    // 3. 填入文本
    if (text) {
      console.log('[DeepSeek] Inputting text...');
      await this.inputText(textarea, text);
      await new Promise(r => setTimeout(r, 500));
    }

    // 4. 获取提交前的所有消息数量，以便找到新增的消息
    const initialMessages = document.querySelectorAll(DEEPSEEK_SELECTORS.messageContainer).length;

    // 5. 提交 (DeepSeek 支持回车发送，但保险起见尝试寻找发送按钮，或者模拟回车)
    console.log('[DeepSeek] Submitting...');
    
    // Simulate Enter key press on textarea
    textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    }));
    
    // As a fallback, if text wasn't cleared, we might need a button click
    await new Promise(r => setTimeout(r, 1000));
    if (textarea.value === text || textarea.textContent === text) {
      console.log('[DeepSeek] Enter didn\'t clear input, trying to find send button');
      // Look for the send button - it usually becomes solid or changes class when active
      // Since it's hard to get a static selector, we find all clickable elements near textarea
      const parent = textarea.parentElement.parentElement;
      if (parent) {
        const buttons = parent.querySelectorAll('div[role="button"], button');
        // The last one is usually the send button
        if (buttons.length > 0) {
          buttons[buttons.length - 1].click();
        }
      }
    }

    // 6. 等待新消息出现并且回答完成
    console.log('[DeepSeek] Waiting for response...');
    return await this.waitForResponse(initialMessages);
  }

  async waitForResponse(initialMessageCount) {
    return new Promise((resolve, reject) => {
      let timeoutId;
      let lastChangeTime = Date.now();
      
      // We look for a new message container
      const checkInterval = setInterval(() => {
        const messages = document.querySelectorAll(DEEPSEEK_SELECTORS.messageContainer);
        // If a new message appeared
        if (messages.length > initialMessageCount) {
          const lastMessage = messages[messages.length - 1];
          const textLength = lastMessage.textContent.length;
          
          // Deepseek generates text chunk by chunk. We monitor if text stops growing.
          // Wait 3 seconds without changes to consider it done.
          if (Date.now() - lastChangeTime > 3000 && textLength > 0) {
            clearInterval(checkInterval);
            if (timeoutId) clearTimeout(timeoutId);
            
            console.log('[DeepSeek] Generation complete');
            
            // Extract images if any were generated (rare for deepseek text chat, but possible)
            const images = Array.from(lastMessage.querySelectorAll('img')).map(img => img.src);
            
            resolve({
              text: lastMessage.innerText || lastMessage.textContent,
              images: images
            });
          }
        }
      }, 1000);

      // Listen to DOM mutations to reset the lastChangeTime
      const observer = new MutationObserver(() => {
        const messages = document.querySelectorAll(DEEPSEEK_SELECTORS.messageContainer);
        if (messages.length > initialMessageCount) {
          lastChangeTime = Date.now();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });

      // Timeout after 120s
      timeoutId = setTimeout(() => {
        clearInterval(checkInterval);
        observer.disconnect();
        
        const messages = document.querySelectorAll(DEEPSEEK_SELECTORS.messageContainer);
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

// Instantiate to register listener
new DeepSeekAgent();
