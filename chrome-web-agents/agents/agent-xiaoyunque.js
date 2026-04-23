const XIAOYUNQUE_SELECTORS = {
  // TipTap ProseMirror 编辑器
  editor: 'div.tiptap.ProseMirror[contenteditable="true"], div.ProseMirror[contenteditable="true"], div[contenteditable="true"]',
  // 图片/视频文件上传
  fileInput: 'input[type="file"][accept*=".png"]',
  // 新对话按钮 (侧边栏)
  newChatBtn: 'button.newChatBtn-OHMqsd',
  // 提交按钮 (带箭头图标)
  submitBtn: 'button.createButton-z2MuSL',
  // 响应区域 — 通用选择器，需要实测后微调
  messageContainer: '[class*="messageContent"], [class*="message-content"], [class*="chatMessage"], [class*="assistantMessage"], [class*="bot"], [class*="response"], [class*="result"]',
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
   * 获取 bot 回复消息列表
   */
  getBotMessages() {
    const allMessages = document.querySelectorAll(XIAOYUNQUE_SELECTORS.messageContainer);
    return Array.from(allMessages).filter(el => {
      // 排除用户消息
      if (el.closest('[class*="user"], [class*="User"], [class*="human"], [class*="Human"]')) return false;
      // 排除输入框区域
      if (el.closest('[class*="promptContainer"], [class*="inputSection"], [class*="inputContainer"], div[contenteditable="true"]')) return false;
      // 排除推荐提示词区域
      if (el.closest('[class*="sugPrompt"], [class*="toolbar"]')) return false;
      return true;
    });
  }

  async runFlow(text, imageBase64, imageName) {
    console.log('[Xiaoyunque] Starting flow...');

    // 1. 强制每次新开对话
    await this.clickNewChat();

    // 2. 等待 ProseMirror 编辑器加载
    const editors = await this.waitForElements(XIAOYUNQUE_SELECTORS.editor, 15000);
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
      
      // 优先找隐藏的 file input
      const fileInputs = Array.from(document.querySelectorAll(XIAOYUNQUE_SELECTORS.fileInput));
      const fileInput = fileInputs.find(i => !i.disabled) || fileInputs[0];

      if (fileInput) {
        await this.uploadImageToFileSelector(fileInput, imageBase64, imageName);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        // 通过粘贴方式上传
        await this.pasteImage(editor, imageBase64, imageName);
        await new Promise(r => setTimeout(r, 2500));
      }
    }

    // 4. 输入文本
    if (text) {
      console.log('[Xiaoyunque] Inputting text...');
      await this.inputTextToProseMirror(editor, text);
      await new Promise(r => setTimeout(r, 800));
    }

    // 5. 获取提交前的消息数量
    const initialMsgs = this.getBotMessages();
    const initialMessages = initialMsgs.length;
    const initialLastText = initialMsgs.length > 0 
      ? (initialMsgs[initialMsgs.length - 1].innerText || initialMsgs[initialMsgs.length - 1].textContent) 
      : '';

    // 6. 提交
    console.log('[Xiaoyunque] Submitting...');

    // 先尝试 Enter 键
    const enterEventOptions = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true
    };
    editor.dispatchEvent(new KeyboardEvent('keydown', enterEventOptions));
    editor.dispatchEvent(new KeyboardEvent('keypress', enterEventOptions));
    editor.dispatchEvent(new KeyboardEvent('keyup', enterEventOptions));

    await new Promise(r => setTimeout(r, 1000));

    // 如果编辑器中文本还在，尝试点击提交按钮
    const currentEditorText = (editor.textContent || '').trim();
    if (currentEditorText.length > 0 && text && currentEditorText.includes(text.substring(0, Math.min(5, text.length)))) {
      console.log('[Xiaoyunque] Enter didn\'t submit, trying submit button...');
      
      // 先尝试带特定 class 的按钮
      let submitBtn = document.querySelector(XIAOYUNQUE_SELECTORS.submitBtn);
      
      // 如果有 disabled 属性，可能需要等待按钮激活
      if (submitBtn && submitBtn.disabled) {
        console.log('[Xiaoyunque] Submit button is disabled, waiting...');
        await new Promise(r => setTimeout(r, 1000));
        submitBtn = document.querySelector(XIAOYUNQUE_SELECTORS.submitBtn);
      }
      
      if (submitBtn && !submitBtn.disabled) {
        submitBtn.click();
        console.log('[Xiaoyunque] Clicked submit button');
      } else {
        // 兜底: 找 toolbar 区域中的发送按钮 (带有箭头 SVG 的按钮)
        const toolbarBtns = document.querySelectorAll('[class*="toolbar"] button, [class*="buttonContainer"] button');
        for (const btn of Array.from(toolbarBtns).reverse()) {
          if (btn.querySelector('svg') && !btn.disabled) {
            const btnText = (btn.innerText || btn.textContent || '').trim();
            // 排除明显不是发送按钮的
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

        // 检测是否有新消息出现
        if (messages.length > initialMessageCount || (currentText !== initialLastText && currentLength > 0)) {
          generationStarted = true;
        }

        if (generationStarted) {
          if (currentLength > 0) {
            if (Math.abs(currentLength - prevTextLength) <= 2) {
              unchangedTime += 1000;
            } else {
              unchangedTime = 0;
              prevTextLength = currentLength;
            }

            // 文本稳定 5 秒认为生成完成（小云雀生成视频等可能较慢）
            if (unchangedTime >= 5000) {
              clearInterval(checkInterval);
              if (timeoutId) clearTimeout(timeoutId);
              console.log('[Xiaoyunque] Generation complete');

              const finalText = this.extractStructuredContent(lastMessage);
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
            text: (lastMessage.innerText || lastMessage.textContent) + '\n[超时截止]',
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
