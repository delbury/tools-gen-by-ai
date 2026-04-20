// Offscreen Document - 图片裁剪 + 二维码解码

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'cropAndDecode') {
    cropAndDecode(message);
  }
});

async function cropAndDecode({ dataUrl, rect, dpr, tabId }) {
  try {
    const img = new Image();

    const loadPromise = new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('图片加载失败'));
    });

    img.src = dataUrl;
    await loadPromise;

    // 使用 DPR 计算实际像素坐标
    const sx = Math.round(rect.x * dpr);
    const sy = Math.round(rect.y * dpr);
    const sw = Math.round(rect.width * dpr);
    const sh = Math.round(rect.height * dpr);

    // 裁剪图片
    const canvas = document.getElementById('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

    // 获取像素数据用于 QR 解码
    const imageData = ctx.getImageData(0, 0, sw, sh);

    // 解码二维码
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'attemptBoth',
    });

    // 获取裁剪后的图片 dataURL（用于预览）
    const croppedImage = canvas.toDataURL('image/png');

    if (code) {
      chrome.runtime.sendMessage({
        action: 'decodeResult',
        success: true,
        qrData: code.data,
        croppedImage: croppedImage,
        tabId: tabId,
      });
    } else {
      chrome.runtime.sendMessage({
        action: 'decodeResult',
        success: false,
        croppedImage: croppedImage,
        error: '未识别到二维码',
        tabId: tabId,
      });
    }
  } catch (err) {
    chrome.runtime.sendMessage({
      action: 'decodeResult',
      success: false,
      error: '处理失败：' + err.message,
      tabId: tabId,
    });
  }
}
