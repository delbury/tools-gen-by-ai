const XIAOYUNQUE_SELECTORS = {
  // TipTap ProseMirror 编辑器
  editor: 'div.tiptap.ProseMirror[contenteditable="true"], div.ProseMirror[contenteditable="true"], div[contenteditable="true"]',
  // 图片/视频文件上传
  // 实际 DOM: <input type="file" multiple accept=".png,.jpg,.jpeg,.mp4,.mov,.webp">
  // 用 [multiple] 区分图片上传 input 与 JSON 导入 input（后者无 multiple）
  fileInput: 'input[type="file"][multiple], input[type="file"][accept*=".png"]',
  // 新对话按钮 (侧边栏)
  newChatBtn: 'button.newChatBtn-OHMqsd',
  // 提交按钮 (带箭头图标)
  submitBtn: 'button.createButton-z2MuSL',
  // 助手消息外层容器
  // 实际 DOM: <div class="assistantMessage-xtewpm ag-ui-assistant-message">
  messageContainer: '[class*="assistantMessage"], [class*="assistant-message"]',
  // 消息内容区（markdown 文本所在子容器，排除时间戳等干扰元素）
  // 实际 DOM: <div class="markdownContent-o0w7gu">
  markdownContent: '[class*="markdownContent"], [class*="markdown-content"], [class*="messageContent"], [class*="message-content"]',
  // 需要从消息中过滤掉的无关区域（工具调用、时间戳等）
  // 实际 DOM: <div class="toolCallGroup-jJqCQI">、<div class="messageMeta-lLdj3s">
  noiseSelectors: [
    '[class*="toolCallGroup"], [class*="tool-call-group"]',
    '[class*="messageMeta"], [class*="message-meta"]',
    '[class*="toolCall"], [class*="tool-call"]:not([class*="group"])',
  ],
};

class XiaoyunqueAgent extends BaseAgent {
  constructor() {
    super('xiaoyunque');
  }

  /**
   * 点击新对话按钮
   */
  async clickNewChat() {
    console.log('[Xiaoyunque] Attempting to start a new chat...');

    // 1. 优先查找带 class 的按钮
    let newChatBtn = document.querySelector(XIAOYUNQUE_SELECTORS.newChatBtn);

    // 2. 若 class 被 hash 化导致选择器失效，通过文本匹配
    if (!newChatBtn) {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.innerText || btn.textContent || '').trim();
        if (text.includes('新对话') && btn.offsetHeight > 0) {
          newChatBtn = btn;
          break;
        }
      }
    }

    if (newChatBtn) {
      console.log('[Xiaoyunque] Found New Chat button, clicking...');
      
      // Prevent opening in a new tab if it's a link or contains a link
      if (newChatBtn.tagName.toLowerCase() === 'a' && newChatBtn.hasAttribute('target')) {
        newChatBtn.removeAttribute('target');
      }
      const parentA = newChatBtn.closest('a');
      if (parentA && parentA.hasAttribute('target')) {
        parentA.removeAttribute('target');
      }
      const childA = newChatBtn.querySelector('a[target]');
      if (childA) {
        childA.removeAttribute('target');
      }

      newChatBtn.click();
      await new Promise(r => setTimeout(r, 1500));
      return true;
    }

    console.log('[Xiaoyunque] New Chat button not found, skipping (background.js handles new chat via URL).');
    return false;
  }

  /**
   * 在 ProseMirror 编辑器中输入文本
   * ProseMirror/TipTap 框架不响应直接 innerHTML 修改，
   * 需要通过 insertText 命令或 paste 事件来注入内容
   */
  async inputTextToProseMirror(editor, text) {
    if (!text) return;

    editor.focus();
    await new Promise(r => setTimeout(r, 200));

    // 先清空编辑器中可能存在的 placeholder 段落
    const emptyP = editor.querySelector('p.is-editor-empty');
    if (emptyP) {
      // 选中所有内容
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    // 方式 1: 通过 ClipboardEvent 粘贴文本（最可靠）
    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', text);
      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true
      });
      editor.dispatchEvent(pasteEvent);
      await new Promise(r => setTimeout(r, 300));

      // 检查是否成功
      const currentText = (editor.textContent || '').trim();
      if (currentText.includes(text.substring(0, Math.min(10, text.length)))) {
        console.log('[Xiaoyunque] Text input via paste successful');
        return;
      }
    } catch (e) {
      console.warn('[Xiaoyunque] Paste text failed:', e);
    }

    // 方式 2: document.execCommand insertText
    try {
      editor.focus();
      document.execCommand('insertText', false, text);
      await new Promise(r => setTimeout(r, 300));

      const currentText = (editor.textContent || '').trim();
      if (currentText.includes(text.substring(0, Math.min(10, text.length)))) {
        console.log('[Xiaoyunque] Text input via insertText successful');
        return;
      }
    } catch (e) {
      console.warn('[Xiaoyunque] insertText failed:', e);
    }

    // 方式 3: InputEvent (Tiptap 监听 beforeinput)
    try {
      editor.focus();
      const inputEvent = new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: text,
        bubbles: true,
        cancelable: true,
        composed: true
      });
      editor.dispatchEvent(inputEvent);
      await new Promise(r => setTimeout(r, 300));

      const currentText = (editor.textContent || '').trim();
      if (currentText.includes(text.substring(0, Math.min(10, text.length)))) {
        console.log('[Xiaoyunque] Text input via InputEvent successful');
        return;
      }
    } catch (e) {
      console.warn('[Xiaoyunque] InputEvent failed:', e);
    }

    // 方式 4: 最终兜底 — 直接修改 innerHTML
    console.warn('[Xiaoyunque] All input methods failed, falling back to innerHTML');
    editor.innerHTML = `<p>${text}</p>`;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
  }

  /**
   * 覆写 base-agent 的 uploadImageToFileSelector：
   * 小云雀同时监听了 change 和 input 事件，base-agent 两者都派发会导致同一张图片上传两次。
   * 此处只派发 change 事件，保证上传仅触发一次。
   */
  async uploadImageToFileSelector(fileInput, imageBase64, filename) {
    if (!imageBase64) return;

    const file = this.base64ToFile(imageBase64, filename || 'upload.png');
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    fileInput.files = dataTransfer.files;

    // 只派发 change，不派发 input，防止双次上传。
    // 必须保持 bubbles: true：React/Vue 使用事件委托，监听器挂在父容器，
    // bubbles: false 会导致父级收不到事件，图片完全无法上传。
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    await new Promise(r => setTimeout(r, 500));
  }

  /**
   * 通过 ClipboardEvent 粘贴图片
   */
  async pasteImage(editor, imageBase64, filename) {
    if (!imageBase64) return;

    try {
      editor.focus();
      const file = this.base64ToFile(imageBase64, filename || 'upload.png');
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const event = new ClipboardEvent('paste', {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true
      });
      editor.dispatchEvent(event);
      console.log('[Xiaoyunque] Image pasted via ClipboardEvent');
    } catch (e) {
      console.error('[Xiaoyunque] Paste image error:', e);
    }
  }

  /**
   * 等待图片上传 loading 完成
   * 轮询策略：
   *   1. 先等上传预览区出现（说明组件已受理文件）
   *   2. 再等 loading 指示器消失 且 预览缩略图稳定存在
   *   3. 无论如何至少等待 minWait 毫秒
   * @param {number} timeout - 超时毫秒数，默认 15000
   */
  async waitForImageUploadComplete(timeout = 15000) {
    const startTime = Date.now();
    const minWait = 5000; // 最低等待时间，保证上传有充足时间

    // 判断"上传中"的 loading 指示器是否存在
    const hasLoading = () => !!document.querySelector(
      '[class*="uploading"], [class*="Uploading"], ' +
      '[class*="lv-upload-list-item-uploading"], ' +
      '[class*="upload-loading"], [class*="uploadLoading"], ' +
      '[class*="progress"], [class*="Progress"]'
    );

    // 判断"上传完成"的预览缩略图是否存在
    const hasPreview = () => !!document.querySelector(
      '[class*="lv-upload-list-item"]:not([class*="uploading"]), ' +
      '[class*="uploadItem"]:not([class*="loading"]):not([class*="uploading"]), ' +
      '[class*="filePreview"], [class*="file-preview"], ' +
      '[class*="imagePreview"], [class*="image-preview"], ' +
      '[class*="attachmentThumb"], [class*="attachment-thumb"]'
    );

    return new Promise(resolve => {
      let loadingEverAppeared = false;
      let resolved = false;

      const doResolve = () => {
        if (resolved) return;
        resolved = true;
        clearInterval(timer);
        resolve();
      };

      const timer = setInterval(() => {
        if (this.aborted) {
          return doResolve();
        }

        const loading = hasLoading();
        const preview = hasPreview();

        if (loading) {
          loadingEverAppeared = true;
          console.log('[Xiaoyunque] Image uploading in progress...');
          return; // 继续等待
        }

        // loading 消失后：若预览存在 或 曾出现过 loading 则认为上传完成
        // 但至少要等满 minWait 毫秒
        if (!loading && (preview || loadingEverAppeared)) {
          const elapsed = Date.now() - startTime;
          if (elapsed >= minWait) {
            console.log('[Xiaoyunque] Image upload complete (preview ready)');
            return doResolve();
          }
          // 还没到最低等待时间，继续轮询
        }

        // 超时兜底
        if (Date.now() - startTime >= timeout) {
          console.warn('[Xiaoyunque] Image upload wait timed out, continuing anyway...');
          doResolve();
        }
      }, 500);

      // 至少等待 minWait 毫秒后再 resolve（无论 loading 是否出现）
      setTimeout(() => {
        if (!loadingEverAppeared) {
          console.log('[Xiaoyunque] No loading indicator detected after minWait, continuing...');
        }
        doResolve();
      }, minWait);
    });
  }


  /**
   * 获取 bot 回复消息列表
   */
  getBotMessages() {
    const allMessages = document.querySelectorAll(XIAOYUNQUE_SELECTORS.messageContainer);
    return Array.from(allMessages).filter(el => {
      // 排除输入框区域
      if (el.closest('[class*="promptContainer"], [class*="inputSection"], [class*="inputContainer"], div[contenteditable="true"]')) return false;
      // 排除推荐提示词区域
      if (el.closest('[class*="sugPrompt"], [class*="toolbar"]')) return false;
      return true;
    });
  }

  /**
   * 从消息元素提取纯净文本：
   * 克隆节点后移除工具调用、时间戳等无关区域，
   * 优先只读取 markdownContent 子节点（含 plainContent 开头句），
   * 若无 markdownContent 则读取整个清理后的克隆节点。
   * @param {Element} messageEl - assistantMessage 外层容器
   * @returns {string} 过滤后的纯净文本
   */
  extractMessageText(messageEl) {
    // 克隆节点，避免修改真实 DOM
    const clone = messageEl.cloneNode(true);

    // 移除所有无关区域
    for (const sel of XIAOYUNQUE_SELECTORS.noiseSelectors) {
      clone.querySelectorAll(sel).forEach(el => el.remove());
    }

    // 优先只取 markdownContent 部分（主体回复），同时拼接 plainContent 开头句
    const plainContent = clone.querySelector('[class*="plainContent"], [class*="plain-content"]');
    const markdownContent = clone.querySelector(XIAOYUNQUE_SELECTORS.markdownContent);

    if (markdownContent) {
      const parts = [];
      if (plainContent) {
        const plainText = (plainContent.innerText || plainContent.textContent || '').trim();
        if (plainText) parts.push(plainText);
      }
      parts.push(this.extractStructuredContent(markdownContent));
      return parts.filter(Boolean).join('\n\n');
    }

    // 无 markdownContent 时返回整个已清理节点的文本
    return this.extractStructuredContent(clone);
  }

  /**
   * 获取消息元素中用于提取文本的内容子节点（用于稳定性检测）
   * 优先返回 markdownContent 子元素（排除时间戳等元数据），
   * 若无则返回元素本身
   */
  getMessageContentNode(messageEl) {
    return messageEl.querySelector(XIAOYUNQUE_SELECTORS.markdownContent) || messageEl;
  }

  async runFlow(text, imageBase64, imageName) {
    console.log('[Xiaoyunque] Starting flow...');

    // 1. 强制每次新开对话
    await this.clickNewChat();
    if (this.aborted) return;

    // 2. 等待 ProseMirror 编辑器加载
    const editors = await this.waitForElements(XIAOYUNQUE_SELECTORS.editor, 15000);
    if (this.aborted) return;
    // TipTap ProseMirror 编辑器通常是第一个或唯一的 contenteditable div
    const editor = Array.from(editors).find(el =>
      el.classList.contains('ProseMirror') || el.classList.contains('tiptap')
    ) || editors[editors.length - 1];

    if (!editor) throw new Error('Cannot find Xiaoyunque input editor');
    console.log('[Xiaoyunque] Found editor');

    editor.focus();

    // 3. 如果有图片，先上传图片
    if (imageBase64) {
      console.log('[Xiaoyunque] Uploading image...');
      let uploaded = false;

      // 策略 1: 直接对 file input 赋值（DataTransfer 对 display:none 的元素同样有效）
      // 不点击触发按钮/菜单，避免触发两次 change 事件导致图片重复提交
      // 用 [multiple] 匹配图片上传 input（JSON 导入 input 无 multiple 属性）
      const fileInput = document.querySelector('input[type="file"][multiple]')
        || document.querySelector('input[type="file"][accept*=".png"]');

      if (fileInput) {
        console.log('[Xiaoyunque] Uploading via file input (direct DataTransfer)...');
        await this.uploadImageToFileSelector(fileInput, imageBase64, imageName);

        // 等待上传 loading 完成：轮询直到预览缩略图出现，或超时 15s
        console.log('[Xiaoyunque] Waiting for image upload to complete...');
        await this.waitForImageUploadComplete(15000);
        uploaded = true;
      }

      // 策略 2: 兜底 — 通过粘贴方式上传
      if (!uploaded) {
        console.log('[Xiaoyunque] Falling back to paste image...');
        await this.pasteImage(editor, imageBase64, imageName);
        await new Promise(r => setTimeout(r, 2500));
      }
    }
    if (this.aborted) return;

    // 4. 输入文本
    if (text) {
      console.log('[Xiaoyunque] Inputting text...');
      await this.inputTextToProseMirror(editor, text);
      await new Promise(r => setTimeout(r, 800));
    }
    if (this.aborted) return;

    // 5. 获取提交前的消息数量
    const initialMsgs = this.getBotMessages();
    const initialMessages = initialMsgs.length;
    const initialLastText = initialMsgs.length > 0 
      ? (initialMsgs[initialMsgs.length - 1].innerText || initialMsgs[initialMsgs.length - 1].textContent) 
      : '';

    // 6. 提交
    console.log('[Xiaoyunque] Submitting...');

    // 等待提交按钮变为可点击状态（图片上传完成后按钮才会激活）
    const readyBtn = await this.waitForSubmitButtonEnabled(15000);
    if (this.aborted) return;

    if (readyBtn) {
      // 直接点击已就绪的提交按钮
      readyBtn.click();
      console.log('[Xiaoyunque] Clicked submit button (after waiting for enabled)');
    } else {
      // 兜底：尝试 Enter 键
      console.log('[Xiaoyunque] Submit button not found/enabled, trying Enter key...');
      const enterEventOptions = {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true, composed: true
      };
      editor.dispatchEvent(new KeyboardEvent('keydown', enterEventOptions));
      editor.dispatchEvent(new KeyboardEvent('keypress', enterEventOptions));
      editor.dispatchEvent(new KeyboardEvent('keyup', enterEventOptions));

      await new Promise(r => setTimeout(r, 1000));
      if (this.aborted) return;

      // Enter 仍未提交，再找 toolbar 中的 fallback 按钮
      const currentEditorText = (editor.textContent || '').trim();
      if (currentEditorText.length > 0 && text && currentEditorText.includes(text.substring(0, Math.min(5, text.length)))) {
        console.log('[Xiaoyunque] Enter didn\'t submit, trying fallback toolbar button...');
        const toolbarBtns = document.querySelectorAll('[class*="toolbar"] button, [class*="buttonContainer"] button');
        for (const btn of Array.from(toolbarBtns).reverse()) {
          if (btn.querySelector('svg') && !btn.disabled) {
            const btnText = (btn.innerText || btn.textContent || '').trim();
            if (!btnText.includes('刷新') && !btnText.includes('优化') && !btnText.includes('上传')) {
              btn.click();
              console.log('[Xiaoyunque] Clicked fallback button');
              break;
            }
          }
        }
      }
    }

    // 7. 等待响应
    console.log('[Xiaoyunque] Waiting for response...');
    return await this.waitForResponse(initialMessages, initialLastText);
  }

  /**
   * 轮询等待提交按钮变为可点击状态（非 disabled、非 aria-disabled）
   * 图片上传期间按钮通常处于 disabled 状态，上传完成后才激活
   * @param {number} timeout - 超时毫秒数，默认 15000
   * @returns {HTMLElement|null} 可点击的提交按钮，超时则返回 null
   */
  async waitForSubmitButtonEnabled(timeout = 15000) {
    const startTime = Date.now();
    console.log('[Xiaoyunque] Waiting for submit button to become enabled...');

    // lv-btn 禁用时会设置 HTML disabled 属性 或 追加 lv-btn-disabled class
    const isBtnDisabled = (btn) =>
      btn.disabled ||
      btn.classList.contains('lv-btn-disabled') ||
      btn.getAttribute('aria-disabled') === 'true';

    const findEnabledBtn = () => {
      // 优先精确匹配 createButton class（同时兜底模糊匹配）
      const btn = document.querySelector(XIAOYUNQUE_SELECTORS.submitBtn)
        || document.querySelector('button[class*="createButton"]');
      if (btn && !isBtnDisabled(btn)) {
        return btn;
      }
      // 兜底：在 buttonContainer 中找带 SVG 且未禁用的按钮
      // 排除"一键优化"按钮（aria-label 含"优化"）及上传/刷新按钮
      const containerBtns = document.querySelectorAll('[class*="buttonContainer"] button');
      for (const b of Array.from(containerBtns).reverse()) {
        if (b.querySelector('svg') && !isBtnDisabled(b)) {
          const label = (b.getAttribute('aria-label') || '').trim();
          const text  = (b.innerText || b.textContent || '').trim();
          if (!label.includes('优化') && !text.includes('刷新') && !text.includes('优化') && !text.includes('上传')) {
            return b;
          }
        }
      }
      return null;
    };

    return new Promise(resolve => {
      // 立即检查一次
      const immediate = findEnabledBtn();
      if (immediate) {
        console.log('[Xiaoyunque] Submit button already enabled');
        return resolve(immediate);
      }

      const timer = setInterval(() => {
        if (this.aborted) {
          clearInterval(timer);
          return resolve(null);
        }
        const btn = findEnabledBtn();
        if (btn) {
          clearInterval(timer);
          console.log(`[Xiaoyunque] Submit button enabled after ${Date.now() - startTime}ms`);
          return resolve(btn);
        }
        if (Date.now() - startTime >= timeout) {
          clearInterval(timer);
          console.warn('[Xiaoyunque] Timed out waiting for submit button to be enabled');
          resolve(null);
        }
      }, 300);
    });
  }

  async waitForElements(selector, timeout) {
    const startTime = Date.now();
    return new Promise((resolve, reject) => {
      let elements = document.querySelectorAll(selector);
      if (elements.length > 0) return resolve(elements);

      const interval = setInterval(() => {
        if (this.aborted) {
          clearInterval(interval);
          return reject('Aborted by user');
        }
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
      let unchangedCount = 0;  // 连续稳定的检测次数
      let generationStarted = false;

      // 小云雀结果是一次性返回的，稳定 3 次（约 3s）即可判定完成
      // 避免等满 5s 造成不必要的延迟
      const STABLE_THRESHOLD = 3;

      const checkInterval = setInterval(() => {
        if (this.aborted) {
          clearInterval(checkInterval);
          if (timeoutId) clearTimeout(timeoutId);
          return reject('Aborted by user');
        }
        const messages = this.getBotMessages();
        if (messages.length === 0) return;

        const lastMessage = messages[messages.length - 1];
        // 优先从 markdownContent 子节点提取文本，排除时间戳等元数据干扰
        const contentNode = this.getMessageContentNode(lastMessage);
        const currentText = contentNode.innerText || contentNode.textContent || '';
        const currentLength = currentText.trim().length;

        // 检测是否有新消息出现
        if (messages.length > initialMessageCount || (currentText !== initialLastText && currentLength > 0)) {
          generationStarted = true;
        }

        if (generationStarted) {
          if (currentLength > 0) {
            if (Math.abs(currentLength - prevTextLength) <= 2) {
              unchangedCount++;
            } else {
              unchangedCount = 0;
              prevTextLength = currentLength;
            }

            // 文本连续稳定 STABLE_THRESHOLD 次认为生成完成
            if (unchangedCount >= STABLE_THRESHOLD) {
              clearInterval(checkInterval);
              if (timeoutId) clearTimeout(timeoutId);
              console.log('[Xiaoyunque] Generation complete');

              // 使用 extractMessageText 过滤工具调用等无关区域
              const finalText = this.extractMessageText(lastMessage);
              resolve({
                text: finalText,
                images: []
              });
            }
          }
        }
      }, 1000);

      // 超时 180 秒（小云雀生成内容可能较慢）
      timeoutId = setTimeout(() => {
        clearInterval(checkInterval);

        const messages = this.getBotMessages();
        if (messages.length > initialMessageCount) {
          const lastMessage = messages[messages.length - 1];
          resolve({
            text: this.extractMessageText(lastMessage) + '\n[超时截止]',
            images: []
          });
        } else {
          reject('Wait for response timed out after 180 seconds');
        }
      }, 180000);
    });
  }
}

new XiaoyunqueAgent();
