// Background Service Worker - 核心调度中心

// 监听插件图标点击
chrome.action.onClicked.addListener(async (tab) => {
  // 注入 content script 和样式
  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ['content.css'],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
  } catch (err) {
    console.error('Failed to inject content script:', err);
  }
});

// 监听来自 content script 和 offscreen 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'captureArea') {
    handleCaptureArea(message, sender);
    // 不需要 sendResponse，结果通过另一条消息发回
    return false;
  }

  if (message.action === 'decodeResult') {
    // 从 offscreen 收到解码结果，转发给 content script
    handleDecodeResult(message);
    return false;
  }
});

// 处理截图 + 裁剪请求
async function handleCaptureArea(message, sender) {
  const tabId = sender.tab.id;
  try {
    // 1. 截取当前可见页面
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: 'png',
    });

    // 2. 创建或复用 offscreen document
    await ensureOffscreenDocument();

    // 3. 发送裁剪 + 解码请求到 offscreen
    chrome.runtime.sendMessage({
      action: 'cropAndDecode',
      dataUrl: dataUrl,
      rect: message.rect,
      dpr: message.dpr,
      tabId: tabId,
    });
  } catch (err) {
    console.error('Capture failed:', err);
    // 通知 content script 出错
    chrome.tabs.sendMessage(tabId, {
      action: 'showResult',
      success: false,
      error: '截图失败：' + err.message,
    });
  }
}

// 处理来自 offscreen 的解码结果
function handleDecodeResult(message) {
  chrome.tabs.sendMessage(message.tabId, {
    action: 'showResult',
    success: message.success,
    qrData: message.qrData,
    croppedImage: message.croppedImage,
    error: message.error,
  });
}

// 确保 offscreen document 存在
async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });

  if (existingContexts.length > 0) {
    return; // 已存在
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Canvas image cropping and QR code decoding',
  });
}
