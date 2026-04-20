const AGENT_URLS = {
  deepseek: 'https://chat.deepseek.com/',
  doubao: 'https://www.doubao.com/',
  kimi: 'https://kimi.moonshot.cn/'
};

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SUBMIT_TASK') {
    handleSubmitTask(message.payload);
    sendResponse({ success: true });
    return true; // async response
  }
  
  if (message.type === 'AGENT_STATUS') {
    handleAgentStatus(message.payload);
    sendResponse({ success: true });
  }
});

async function handleSubmitTask(payload) {
  const { taskId, text, imageBase64, imageName, agents } = payload;
  
  for (const agentId of agents) {
    if (!AGENT_URLS[agentId]) continue;
    
    try {
      const tab = await getOrCreateAgentTab(agentId);
      
      const trySendMessage = (retryCount = 0) => {
        chrome.tabs.sendMessage(tab.id, {
          type: 'EXECUTE_AGENT',
          payload: {
            taskId,
            agentId,
            text,
            imageBase64,
            imageName
          }
        }).catch(err => {
          if (retryCount === 0) {
            console.warn(`[${agentId}] Send message failed, attempting to reload tab and retry...`, err);
            chrome.tabs.reload(tab.id);
            const listener = (tabId, info) => {
              if (tabId === tab.id && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                setTimeout(() => trySendMessage(1), 1500); // wait a bit more after reload
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
          } else {
            console.error(`Error sending EXECUTE to ${agentId}:`, err);
            // Report error back to popup
            sendTaskUpdate({
              taskId,
              agent: agentId,
              status: 'error',
              error: '与该页面的连接失败。如果刚安装过插件，请尝试手动刷新 AI 的页面。'
            });
          }
        });
      };

      // For newly created tabs or existing ones, wait a bit before first try
      setTimeout(() => trySendMessage(0), 1000);
      
    } catch (error) {
      console.error(`Failed to handle tab for ${agentId}:`, error);
      sendTaskUpdate({
        taskId,
        agent: agentId,
        status: 'error',
        error: '无法打开或连接标签页。'
      });
    }
  }
}

async function getOrCreateAgentTab(agentId) {
  const urlParams = new URL(AGENT_URLS[agentId]);
  const host = urlParams.hostname;
  
  // Find existing tab
  const tabs = await chrome.tabs.query({ url: `*://${host}/*` });
  
  if (tabs.length > 0) {
    // Focus the existing tab
    await chrome.tabs.update(tabs[0].id, { active: true });
    // Also bring the window to front if we can
    chrome.windows.update(tabs[0].windowId, { focused: true });
    return tabs[0];
  } else {
    // Create new tab
    const newTab = await chrome.tabs.create({ url: AGENT_URLS[agentId], active: true });
    
    // In MV3, we wait for complete load using onUpdated listener before sending messages
    return new Promise((resolve) => {
      const listener = (tabId, info) => {
        if (tabId === newTab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(newTab);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }
}

function handleAgentStatus(payload) {
  console.log('Received status from agent:', payload);
  sendTaskUpdate(payload);
}

function sendTaskUpdate(payload) {
  // Broadcast to all extension views (e.g. popups)
  chrome.runtime.sendMessage({
    type: 'TASK_UPDATE',
    payload: payload
  }).catch(() => {
    // Ignore error if popup is closed
  });
}
