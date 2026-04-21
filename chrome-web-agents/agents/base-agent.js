/**
 * BaseAgent: 提供各 AI 平台适配页面的公共工具类
 */
class BaseAgent {
  constructor(agentId) {
    this.agentId = agentId;
    this.taskId = null;
    this.setupMessageListener();
  }

  setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'EXECUTE_AGENT' && message.payload.agentId === this.agentId) {
        this.taskId = message.payload.taskId;
        const { text, imageBase64, imageName } = message.payload;
        
        // Report we started
        this.reportStatus('running');
        
        // Execute the flow
        this.runFlow(text, imageBase64, imageName)
          .then(result => {
             this.reportStatus('done', result.text, result.images);
          })
          .catch(err => {
             console.error(`[${this.agentId}] Flow error:`, err);
             this.reportStatus('error', null, null, err.toString());
          });
          
        sendResponse({ received: true });
        return true;
      }
    });
  }

  reportStatus(status, text = null, images = null, error = null) {
    if (!this.taskId) return;
    
    chrome.runtime.sendMessage({
      type: 'AGENT_STATUS',
      payload: {
        taskId: this.taskId,
        agent: this.agentId,
        status: status,
        result: text,
        resultImages: images,
        error: error
      }
    });
  }

  // --- Utility Methods for DOM Manipulation ---

  /**
   * 等待元素出现 DOM
   */
  async waitForElement(selector, timeout = 30000) {
    const startTime = Date.now();
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      const observer = new MutationObserver(() => {
        const checkEl = document.querySelector(selector);
        if (checkEl) {
          observer.disconnect();
          resolve(checkEl);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      if (timeout > 0) {
        setTimeout(() => {
          observer.disconnect();
          reject(new Error(`Timeout waiting for element ${selector}`));
        }, timeout);
      }
    });
  }

  /**
   * 等待元素消失 (如 loading 指示器)
   */
  async waitForElementToDisappear(selector, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (!el) return resolve();

      const observer = new MutationObserver(() => {
        const checkEl = document.querySelector(selector);
        if (!checkEl) {
          observer.disconnect();
          resolve();
        }
      });

      observer.observe(document.body, { childList: true, subtree: true, attributes: true });

      setTimeout(() => {
        observer.disconnect();
        resolve(); // Don't reject, just resolve to allow continuing
      }, timeout);
    });
  }

  /**
   * 将文本输入到元素 (支持 textarea 或 contenteditable)
   */
  async inputText(element, text) {
    if (!text) return;
    
    // 聚焦元素
    element.focus();
    
    if (element.tagName.toLowerCase() === 'textarea') {
      // Chrome 原生劫持了 setter，所以需要拿到原生的 setter
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      if (nativeInputValueSetter) nativeInputValueSetter.call(element, text);
      else element.value = text;
    } else if (element.tagName.toLowerCase() === 'input') {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      if (nativeInputValueSetter) nativeInputValueSetter.call(element, text);
      else element.value = text;
    } else {
      element.innerHTML = text; // 对于 contenteditable
    }

    // 派发事件让框架 (React/Vue 等) 知道值变了
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    
    // 微小延迟让框架处理
    await new Promise(r => setTimeout(r, 100));
  }

  /**
   * 将 Data URL 转为 File 对象
   */
  base64ToFile(dataurl, filename) {
    let arr = dataurl.split(','),
        mime = arr[0].match(/:(.*?);/)[1],
        bstr = atob(arr[1]), 
        n = bstr.length, 
        u8arr = new Uint8Array(n);
        
    while(n--){
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], filename, {type:mime});
  }

  /**
   * 使用 DataTransfer API 将图片放入 input[type="file"]
   */
  async uploadImageToFileSelector(fileInput, imageBase64, filename) {
    if (!imageBase64) return;
    
    const file = this.base64ToFile(imageBase64, filename || 'upload.png');
    
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    fileInput.files = dataTransfer.files;
    
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    fileInput.dispatchEvent(new Event('input', { bubbles: true }));
    
    await new Promise(r => setTimeout(r, 500));
  }

  /**
   * 尝试点击“新对话”按钮
   */
  async clickNewChat() {
    console.log(`[${this.agentId}] Attempting to start a new chat...`);
    
    // First try the SPA way by finding the New Chat button
    const newChatKeywords = ['新对话', '新建对话', 'New chat', '开启新对话', '新建'];
    const buttons = document.querySelectorAll('button, div[role="button"], a, div[class*="new"], div[class*="New"]');
    
    for (const btn of buttons) {
      const text = btn.innerText || btn.textContent || '';
      const ariaLabel = btn.getAttribute('aria-label') || '';
      const title = btn.getAttribute('title') || '';
      const dataTooltip = btn.getAttribute('data-tooltip') || '';
      
      const match = newChatKeywords.some(kw => 
          text.includes(kw) || ariaLabel.includes(kw) || 
          title.includes(kw) || dataTooltip.includes(kw)
      );
      
      if (match && btn.offsetHeight > 0 && !btn.closest('nav')) { 
        console.log(`[${this.agentId}] Found New Chat button, clicking...`);
        btn.click();
        await new Promise(r => setTimeout(r, 1500));
        return true;
      }
    }

    // Try finding a plus SVG
    const svgs = document.querySelectorAll('svg');
    for (const svg of svgs) {
      const html = svg.outerHTML.toLowerCase();
      if ((html.includes('plus') || html.includes('new')) && svg.offsetHeight > 0) {
         const clickableParent = svg.closest('div[role="button"], button, a');
         // Make sure it doesn't accidentally click the "Upload Image" plus button
         if (clickableParent && clickableParent.offsetHeight > 0 && !clickableParent.innerText.includes('上传')) {
            console.log(`[${this.agentId}] Found possible New Chat svg, clicking parent...`);
            clickableParent.click();
            await new Promise(r => setTimeout(r, 1500));
            return true;
         }
      }
    }
    
    console.log(`[${this.agentId}] New Chat button not explicitly found in DOM.`);
    return false;
  }

  // --- Abstract Methods to implement in subclasses ---

  /**
   * 执行完整的业务逻辑，子类必须实现
   */
  async runFlow(text, imageBase64, imageName) {
    throw new Error('Not implemented');
  }
}
