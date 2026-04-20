// Content Script - 负责页面截图框选和结果展示

(function() {
  // 防止多次注入导致变量重复声明或多次绑定事件
  if (window.__qrScannerInjected) {
    if (typeof window.__qrScannerInitUI === 'function') {
      window.__qrScannerInitUI();
    }
    return;
  }
  window.__qrScannerInjected = true;

  let overlay = null;
  let selectionBox = null;
  let startX = 0, startY = 0;
  let isDragging = false;

  // 阻止事件冒泡和默认行为的辅助函数
  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  // 初始化框选 UI
  function initScannerUI() {
    if (document.getElementById('qr-scanner-overlay')) return;

    // 1. 创建全屏遮罩
    overlay = document.createElement('div');
    overlay.id = 'qr-scanner-overlay';
    overlay.className = 'qr-scanner-overlay';
    // 移除 overlay 的背景色，因为我们将用 selectionBox 的 box-shadow 来实现遮罩效果
    overlay.style.backgroundColor = 'transparent'; 

    // 2. 创建选区框
    selectionBox = document.createElement('div');
    selectionBox.id = 'qr-scanner-selection';
    selectionBox.className = 'qr-scanner-selection';
    
    // 加上初始的暗色遮罩
    selectionBox.style.display = 'block';
    selectionBox.style.left = '0px';
    selectionBox.style.top = '0px';
    selectionBox.style.width = '100vw';
    selectionBox.style.height = '100vh';
    selectionBox.style.border = 'none';

    document.body.appendChild(overlay);
    document.body.appendChild(selectionBox);

    // 3. 绑定事件
    overlay.addEventListener('mousedown', handleMouseDown, true);
    window.addEventListener('mousemove', handleMouseMove, true);
    window.addEventListener('mouseup', handleMouseUp, true);
    window.addEventListener('keydown', handleKeyDown, true);
    
    // 禁用页面上的选择和右键菜单，防止干扰
    document.addEventListener('selectstart', preventDefaults, true);
    document.addEventListener('contextmenu', preventDefaults, true);
    
    // 设置光标
    document.body.style.cursor = 'crosshair';
  }
  
  // 将启动 UI 的函数挂载到全局，供后续重新点击时调用
  window.__qrScannerInitUI = initScannerUI;

  function handleMouseDown(e) {
    if (e.button !== 0) return; // 只响应左键
    preventDefaults(e);

    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;

    selectionBox.style.border = '2px solid #4F8EF7'; // 恢复边框
    updateSelection(startX, startY);
  }

  function handleMouseMove(e) {
    if (!isDragging) return;
    preventDefaults(e);
    updateSelection(e.clientX, e.clientY);
  }

  function handleMouseUp(e) {
    if (!isDragging) return;
    preventDefaults(e);
    isDragging = false;

    const endX = e.clientX;
    const endY = e.clientY;

    const rect = getRect(startX, startY, endX, endY);
    
    // 清理 UI 和事件
    cleanupUI();

    // 如果选区太小，则视为误触
    if (rect.width > 10 && rect.height > 10) {
      // 发送截图请求给 Background，附带当前设备的 dpr
      chrome.runtime.sendMessage({
        action: 'captureArea',
        rect: rect,
        dpr: window.devicePixelRatio || 1
      });
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      cleanupUI();
    }
  }

  // 根据起点和当前点计算矩形
  function getRect(x1, y1, x2, y2) {
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1)
    };
  }

  // 更新选区框位置
  function updateSelection(currentX, currentY) {
    const rect = getRect(startX, startY, currentX, currentY);
    selectionBox.style.left = rect.x + 'px';
    selectionBox.style.top = rect.y + 'px';
    selectionBox.style.width = rect.width + 'px';
    selectionBox.style.height = rect.height + 'px';
  }

  // 清理页面上的 UI 元素和事件
  function cleanupUI() {
    if (overlay) overlay.remove();
    if (selectionBox) selectionBox.remove();
    overlay = null;
    selectionBox = null;
    isDragging = false;
    
    window.removeEventListener('mousemove', handleMouseMove, true);
    window.removeEventListener('mouseup', handleMouseUp, true);
    window.removeEventListener('keydown', handleKeyDown, true);
    document.removeEventListener('selectstart', preventDefaults, true);
    document.removeEventListener('contextmenu', preventDefaults, true);
    
    document.body.style.cursor = ''; // 恢复光标
  }

  // -----------------------------------------------------
  // 结果展示部分
  // -----------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'showResult') {
      showResultModal(message);
    }
  });

  function showResultModal(result) {
    // 移除可能已存在的弹窗
    const existingModal = document.getElementById('qr-scanner-modal-container');
    if (existingModal) existingModal.remove();

    const container = document.createElement('div');
    container.id = 'qr-scanner-modal-container';
    container.className = 'qr-scanner-modal-container';

    // Modal HTML 结构
    let contentHtml = '';
    
    if (result.success) {
      // 尝试复制到剪贴板，使用 Clipboard API
      navigator.clipboard.writeText(result.qrData).then(() => {
          const copyBtn = document.getElementById('qr-copy-btn');
          if(copyBtn) {
              copyBtn.textContent = '已自动复制';
              copyBtn.style.backgroundColor = '#28a745';
          }
      }).catch(err => {
          console.error('自动复制失败:', err);
      });

      const isUrl = /^(http|https):\/\/[^ "]+$/.test(result.qrData);
      
      contentHtml = `
        <div class="qr-scanner-success">识别成功！已将其复制到剪贴板</div>
        <div class="qr-scanner-result">${escapeHtml(result.qrData)}</div>
        <div class="qr-scanner-actions">
          ${isUrl ? '<button class="qr-scanner-btn qr-scanner-btn-primary" id="qr-open-btn">在新标签页打开</button>' : ''}
          <button class="qr-scanner-btn qr-scanner-btn-secondary" id="qr-copy-btn">复制文本</button>
        </div>
      `;
    } else {
      contentHtml = `
        <div class="qr-scanner-error">识别失败</div>
        <div class="qr-scanner-result">${escapeHtml(result.error || '无法识别该区域中的二维码')}</div>
        <div class="qr-scanner-actions">
          <button class="qr-scanner-btn qr-scanner-btn-secondary" id="qr-retry-btn">重新扫描</button>
        </div>
      `;
    }

    container.innerHTML = `
      <div class="qr-scanner-modal">
        <div class="qr-scanner-modal-header">
          <h3>扫描结果</h3>
          <button class="qr-scanner-close-btn" id="qr-close-btn">&times;</button>
        </div>
        <div class="qr-scanner-preview">
          <img src="${result.croppedImage}" alt="截图预览" />
        </div>
        ${contentHtml}
      </div>
    `;

    document.body.appendChild(container);

    // 绑定弹窗事件
    document.getElementById('qr-close-btn').addEventListener('click', () => container.remove());
    
    // 点击容器背景关闭弹窗
    container.addEventListener('click', (e) => {
      if (e.target === container) {
        container.remove();
      }
    });

    if (result.success) {
      const copyBtn = document.getElementById('qr-copy-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(result.qrData).then(() => {
            const originalText = copyBtn.textContent;
            copyBtn.textContent = '复制成功!';
            setTimeout(() => copyBtn.textContent = originalText, 2000);
          });
        });
      }

      const openBtn = document.getElementById('qr-open-btn');
      if (openBtn) {
        openBtn.addEventListener('click', () => {
          window.open(result.qrData, '_blank');
          container.remove(); // 打开链接后关闭弹窗
        });
      }
    } else {
      const retryBtn = document.getElementById('qr-retry-btn');
      if (retryBtn) {
        retryBtn.addEventListener('click', () => {
          container.remove();
          initScannerUI(); // 重新触发扫描 UI
        });
      }
    }
  }

  // 简单的 XSS 防御
  function escapeHtml(unsafe) {
    return (unsafe || '').toString()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // 首此注入时立刻启动 UI
  initScannerUI();
})();
