const DEEPSEEK_SELECTORS = {
  textarea: '#chat-input, textarea, div[contenteditable="true"]',
  fileInput: 'input[type="file"]',
  sendButton: 'div[role="button"][style*="cursor: pointer"], button',
  messageContainer: '.ds-markdown, .markdown-body, div[class*="message"]', 
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
      console.log('[DeepSeek] DeepSeek currently does not fully support image recognition in the standard interface. Skipping image upload and sending text only.');
      // Deepseek 暂不支持网页端的图像识别，直接忽略图片数据，仅传递并发送文本
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
    
    // Simulate Enter key presses
    const enterEventOptions = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true
    };
    textarea.dispatchEvent(new KeyboardEvent('keydown', enterEventOptions));
    textarea.dispatchEvent(new KeyboardEvent('keypress', enterEventOptions));
    textarea.dispatchEvent(new KeyboardEvent('keyup', enterEventOptions));
    
    // As a fallback, if text wasn't cleared, we might need a button click
    await new Promise(r => setTimeout(r, 1000));
    const currentValue = textarea.value !== undefined ? textarea.value : textarea.textContent;
    if (currentValue && currentValue.trim().length > 0 && currentValue.includes(text.substring(0, Math.min(5, text.length)))) {
      console.log('[DeepSeek] Enter didn\'t clear input, trying to find send button');
      // Find the send button nearby. DeepSeek send button often has a specific SVG or role
      let container = textarea;
      let sendBtn = null;
      for (let i = 0; i < 5; i++) {
        if (container.parentElement) container = container.parentElement;
        const buttons = container.querySelectorAll('div[role="button"]:not([disabled]), button:not([disabled])');
        if (buttons.length > 0) {
          sendBtn = buttons[buttons.length - 1]; // Often the last button is the send button
          break;
        }
      }
      
      if (sendBtn) {
        console.log('[DeepSeek] Found send button via fallback:', sendBtn);
        sendBtn.click();
      } else {
        // Ultimate fallback: heuristics
        const globalBtn = document.querySelector('div[role="button"][style*="cursor: pointer"] svg, .ds-icon-button, button[type="submit"]');
        if (globalBtn) {
            console.log('[DeepSeek] Found global fallback button');
            globalBtn.closest('div[role="button"], button') ? globalBtn.closest('div[role="button"], button').click() : globalBtn.click();
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
            
            // Extract images and text preserving order
            const finalText = this.extractStructuredContent(lastMessage);
            
            resolve({
              text: finalText,
              images: []
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
