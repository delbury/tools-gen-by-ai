const AGENT_URLS = {
  deepseek: 'https://chat.deepseek.com/',
  doubao: 'https://www.doubao.com/',
  kimi: 'https://kimi.com/'
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

  if (message.type === 'CANCEL_TASK') {
    handleCancelTask(message.payload);
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
          if (retryCount < 5) {
            console.warn(`[${agentId}] Send message failed, retrying (${retryCount + 1}/5)...`, err);
            setTimeout(() => trySendMessage(retryCount + 1), 1000); // just wait and retry
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
  const targetUrl = AGENT_URLS[agentId];
  const urlParams = new URL(targetUrl);
  const host = urlParams.hostname;
  
  // Match both exact host and subdomains, plus kimi.com if it's kimi
  let matchPatterns;
  if (agentId === 'kimi') {
    matchPatterns = [
      `*://${host}/*`, 
      `*://*.moonshot.cn/*`,
      `*://kimi.com/*`,
      `*://*.kimi.com/*`,
      `*://kimi.ai/*`,
      `*://*.kimi.ai/*`
    ];
  } else {
    // For doubao and deepseek, we might also want to catch subdomains just in case
    const hostParts = host.split('.');
    const baseDomain = hostParts.length >= 2 ? hostParts.slice(-2).join('.') : host;
    matchPatterns = [`*://${host}/*`, `*://*.${baseDomain}/*`];
  }
  
  // Find existing tab
  const tabs = await chrome.tabs.query({ url: matchPatterns });
  
  if (tabs.length > 0) {
    const existingTab = tabs[0];
    
    // Navigate strictly to the root chat URL to force a new conversation
    // Important: DO NOT setActive or focus the window, otherwise popup closes!
    try {
      const updateProps = { active: false };
      if (existingTab.url !== targetUrl) {
        updateProps.url = targetUrl;
      }
      await chrome.tabs.update(existingTab.id, updateProps);
    } catch(e) {
      console.error(e);
    }
    
    // Wait for the forced navigation to complete
    return new Promise((resolve) => {
      let timeoutId;
      const listener = (tabId, info) => {
        if (tabId === existingTab.id && info.status === 'complete') {
          clearTimeout(timeoutId);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(existingTab);
        }
      };
      
      // Fallback in case of SPA fast navigation without triggering 'complete'
      timeoutId = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(existingTab);
      }, 2500);

      chrome.tabs.onUpdated.addListener(listener);
    });
  } else {
    // Create new tab but do not make it active so the popup stays open
    const newTab = await chrome.tabs.create({ url: targetUrl, active: false });
    
    // In MV3, we wait for complete load
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

function handleCancelTask(payload) {
  // simplest & cleanest way to fully abort any active execution inside content scripts
  // is to force-reload the chat tab.
  for (const agentId of Object.keys(AGENT_URLS)) {
    const targetUrl = AGENT_URLS[agentId];
    const urlParams = new URL(targetUrl);
    chrome.tabs.query({ url: `*://${urlParams.hostname}/*` }, (tabs) => {
      tabs.forEach(tab => chrome.tabs.reload(tab.id));
    });
  }
}
