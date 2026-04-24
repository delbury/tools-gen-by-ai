const AGENT_URLS = {
  deepseek: 'https://chat.deepseek.com/',
  doubao: 'https://www.doubao.com/',
  kimi: 'https://kimi.com/',
  xiaoyunque: 'https://xyq.jianying.com/'
};

// chrome.storage.local 中用于持久化当前执行状态的 key
// 结构: { taskId, text, imageBase64, imageName, agents, currentIndex, cancelled }
const ACTIVE_TASK_KEY = 'bgActiveTask';

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SUBMIT_TASK') {
    handleSubmitTask(message.payload);
    sendResponse({ success: true });
    return true;
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

// ─── Task Entry Point ──────────────────────────────────────────────────────────

async function handleSubmitTask(payload) {
  const { taskId, text, imageBase64, imageName, agents } = payload;

  // 注意：imageBase64 体积可能很大，不写入 bgActiveTask 以避免超出 storage 配额。
  // popup.js 已将其单独保存在 'imageBase64'/'imageName' key 中，执行时从那里读取。
  const task = {
    taskId,
    text,
    agents,
    currentIndex: 0,
    cancelled: false
  };

  // 持久化到 storage，Service Worker 重启后仍可恢复
  await chrome.storage.local.set({ [ACTIVE_TASK_KEY]: task });

  await executeAgentAtIndex(task, 0);
}

// ─── Core Execution State Machine ─────────────────────────────────────────────

/**
 * 执行 agents[index] 对应的 agent。
 * 若发送成功，函数直接返回，后续由 handleAgentStatus 在收到 done/error 后驱动下一轮。
 * 若发送失败或 tab 异常，直接递推到下一个。
 */
async function executeAgentAtIndex(task, index) {
  const { taskId, text, agents } = task;

  // 从 storage 读取最新状态（SW 可能被重启过，需以 storage 为准）
  const stored = await chrome.storage.local.get(ACTIVE_TASK_KEY);
  const currentTask = stored[ACTIVE_TASK_KEY];

  // 任务已被新任务覆盖
  if (!currentTask || currentTask.taskId !== taskId) {
    console.log(`[Task ${taskId}] Task superseded, stopping.`);
    return;
  }

  // 已取消
  if (currentTask.cancelled) {
    console.log(`[Task ${taskId}] Cancelled, stopping at index ${index}.`);
    await chrome.storage.local.remove(ACTIVE_TASK_KEY);
    return;
  }

  // 所有 agent 已执行完
  if (index >= agents.length) {
    console.log(`[Task ${taskId}] All ${agents.length} agents completed.`);
    await chrome.storage.local.remove(ACTIVE_TASK_KEY);
    return;
  }

  const agentId = agents[index];

  // 更新 currentIndex（让 handleAgentStatus 知道当前在哪一步）
  const updatedTask = { ...currentTask, currentIndex: index };
  await chrome.storage.local.set({ [ACTIVE_TASK_KEY]: updatedTask });

  if (!AGENT_URLS[agentId]) {
    // 未知 agent，跳过
    await executeAgentAtIndex(updatedTask, index + 1);
    return;
  }

  try {
    const tab = await getOrCreateAgentTab(agentId);

    // Tab 加载期间用户可能取消；同时读取图片数据（不存在 bgActiveTask 中以节省配额）
    const stored2 = await chrome.storage.local.get([ACTIVE_TASK_KEY, 'imageBase64', 'imageName']);
    const task2 = stored2[ACTIVE_TASK_KEY];
    if (!task2 || task2.taskId !== taskId || task2.cancelled) {
      console.log(`[Task ${taskId}] Cancelled after tab ready, skipping ${agentId}.`);
      await chrome.storage.local.remove(ACTIVE_TASK_KEY);
      return;
    }
    const imageBase64 = stored2.imageBase64 || null;
    const imageName = stored2.imageName || null;

    // 激活该 agent 对应的标签页
    try {
      await chrome.tabs.update(tab.id, { active: true });
    } catch (e) {
      console.warn(`[${agentId}] Failed to activate tab:`, e);
    }

    // 发送 EXECUTE_AGENT（含重试）
    const sendSuccess = await trySendMessage(tab.id, {
      type: 'EXECUTE_AGENT',
      payload: { taskId, agentId, text, imageBase64, imageName }
    });

    if (!sendSuccess) {
      // 发送失败，上报错误，然后继续下一个
      sendTaskUpdate({
        taskId,
        agent: agentId,
        status: 'error',
        error: '与该页面的连接失败。如果刚安装过插件，请尝试手动刷新 AI 的页面。'
      });
      await executeAgentAtIndex(updatedTask, index + 1);
    }
    // 发送成功：等待 handleAgentStatus 收到 done/error 后驱动下一轮

  } catch (error) {
    console.error(`Failed to handle tab for ${agentId}:`, error);
    sendTaskUpdate({
      taskId,
      agent: agentId,
      status: 'error',
      error: '无法打开或连接标签页。'
    });
    await executeAgentAtIndex(updatedTask, index + 1);
  }
}

// ─── Agent Status Handler ──────────────────────────────────────────────────────

function handleAgentStatus(payload) {
  console.log('Received status from agent:', payload);

  // 转发给 popup（popup 关闭时会 catch 掉，不影响后台流程）
  sendTaskUpdate(payload);

  // agent 完成（done 或 error）→ 驱动下一个 agent
  if (payload.status === 'done' || payload.status === 'error') {
    chrome.storage.local.get(ACTIVE_TASK_KEY).then(stored => {
      const task = stored[ACTIVE_TASK_KEY];
      if (!task || task.taskId !== payload.taskId) return;

      // task.currentIndex 指向刚完成的 agent，下一步是 currentIndex + 1
      executeAgentAtIndex(task, task.currentIndex + 1);
    });
  }
}

// ─── Cancel Handler ────────────────────────────────────────────────────────────

async function handleCancelTask(payload) {
  const { taskId } = payload;

  const stored = await chrome.storage.local.get(ACTIVE_TASK_KEY);
  const task = stored[ACTIVE_TASK_KEY];

  if (task && task.taskId === taskId) {
    // 标记取消；下次 executeAgentAtIndex 或 handleAgentStatus 触发时会读到并停止
    await chrome.storage.local.set({ [ACTIVE_TASK_KEY]: { ...task, cancelled: true } });
    console.log(`[Task ${taskId}] Cancel flag set in storage.`);
  }
}

// ─── Tab Management ────────────────────────────────────────────────────────────

async function getOrCreateAgentTab(agentId) {
  const targetUrl = AGENT_URLS[agentId];
  const urlParams = new URL(targetUrl);
  const host = urlParams.hostname;

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
    const hostParts = host.split('.');
    const baseDomain = hostParts.length >= 2 ? hostParts.slice(-2).join('.') : host;
    matchPatterns = [`*://${host}/*`, `*://*.${baseDomain}/*`];
  }

  const tabs = await chrome.tabs.query({ url: matchPatterns });

  if (tabs.length > 0) {
    let existingTab = tabs.find(t => t.url && new URL(t.url).hostname === host) || tabs[0];

    try {
      const updateProps = {};
      if (existingTab.url !== targetUrl) {
        updateProps.url = targetUrl;
      }
      await chrome.tabs.update(existingTab.id, updateProps);
    } catch (e) {
      console.error(e);
    }

    return new Promise((resolve) => {
      let timeoutId;
      const listener = (tabId, info) => {
        if (tabId === existingTab.id && info.status === 'complete') {
          clearTimeout(timeoutId);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(existingTab);
        }
      };

      timeoutId = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(existingTab);
      }, 2500);

      chrome.tabs.onUpdated.addListener(listener);
    });
  } else {
    const newTab = await chrome.tabs.create({ url: targetUrl, active: false });

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

// ─── Utilities ─────────────────────────────────────────────────────────────────

/**
 * 带重试的消息发送，返回 true/false 表示是否最终发送成功
 */
function trySendMessage(tabId, message, maxRetries = 5) {
  return new Promise((resolve) => {
    const attempt = (retryCount) => {
      chrome.tabs.sendMessage(tabId, message)
        .then(() => resolve(true))
        .catch(err => {
          if (retryCount < maxRetries) {
            console.warn(`Send message failed, retrying (${retryCount + 1}/${maxRetries})...`, err);
            setTimeout(() => attempt(retryCount + 1), 1000);
          } else {
            console.error(`Send message failed after ${maxRetries} retries:`, err);
            resolve(false);
          }
        });
    };
    // 首次尝试前等 1s，给页面时间加载 content script
    setTimeout(() => attempt(0), 1000);
  });
}

function sendTaskUpdate(payload) {
  // 同步将结果持久化到 currentTaskState，以便 popup 关闭后重新打开时恢复
  persistAgentStatusToStorage(payload);

  chrome.runtime.sendMessage({
    type: 'TASK_UPDATE',
    payload: payload
  }).catch(() => {
    // popup 已关闭，忽略；popup 打开时会从 currentTaskState 恢复 UI
  });
}

/**
 * 将单个 agent 的状态更新合并写入 currentTaskState，
 * 确保 popup 重新打开时可读到最终结果。
 */
async function persistAgentStatusToStorage(payload) {
  const { taskId, agent, status, result, resultImages, error } = payload;
  if (!taskId || !agent) return;

  const AgentNames = {
    deepseek: 'DeepSeek',
    doubao: '豆包',
    kimi: 'Kimi',
    xiaoyunque: '小云雀'
  };

  try {
    const stored = await chrome.storage.local.get('currentTaskState');
    const taskState = stored.currentTaskState || { taskId, statuses: {} };

    // 若 storage 里已有更新的任务，不覆盖
    if (taskState.taskId !== taskId) return;

    // 根据 status 构造与 popup saveTaskState 格式一致的 content/rawResult
    let content = '';
    let rawResult = taskState.statuses[agent]?.rawResult || '';

    switch (status) {
      case 'running':
        content = 'Agent 正在思考并生成回复...';
        break;
      case 'done':
        rawResult = result || '';
        content = buildContentHTML(result, resultImages);
        break;
      case 'error':
        rawResult = result || '';
        content = error || '执行过程中发生未知错误';
        break;
      default:
        content = taskState.statuses[agent]?.content || '等待建立连接...';
    }

    taskState.statuses[agent] = { status, content, rawResult };

    await chrome.storage.local.set({ currentTaskState: taskState });
  } catch (e) {
    console.warn('[persistAgentStatusToStorage] Failed:', e);
  }
}

/** 简易 HTML 构建，与 popup.js 的 formatContent 保持基本一致 */
function buildContentHTML(text, images) {
  if (!text && (!images || images.length === 0)) return '没有返回文本内容';

  let html = '';
  if (text) {
    let escaped = text.replace(/[<>&]/g, c => {
      switch (c) { case '<': return '&lt;'; case '>': return '&gt;'; case '&': return '&amp;'; }
    });
    escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    const lines = escaped.split('\n');
    let inList = false;
    let inParagraph = false;

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      let isListItem = /^[*-]\s/.test(line) || /^\d+\.\s/.test(line);

      if (isListItem) {
        if (inParagraph) { html += '</p>'; inParagraph = false; }
        if (!inList) { html += '<ul class="result-list">'; inList = true; }
        html += '<li>' + line.replace(/^[*-]\s/, '').replace(/^\d+\.\s/, '') + '</li>';
      } else {
        if (inList) { html += '</ul>'; inList = false; }
        if (line === '') {
          if (inParagraph) { html += '</p>'; inParagraph = false; }
        } else {
          if (!inParagraph) { html += '<p class="result-paragraph">'; inParagraph = true; }
          else { html += '<br>'; }
          html += line;
        }
      }
    }

    if (inParagraph) html += '</p>';
    if (inList) html += '</ul>';
  }

  if (images && images.length > 0) {
    const validImages = images.filter(src => src && !src.includes('.svg') && !src.startsWith('data:image/svg+xml'));
    if (validImages.length > 0) {
      html += '<div class="result-image-container">';
      validImages.forEach(imgSrc => {
        html += `<img class="result-image" src="${imgSrc}" />`;
      });
      html += '</div>';
    }
  }

  return html;
}
