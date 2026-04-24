// DOM Elements
const promptInput = document.getElementById('prompt-input');
const imageUpload = document.getElementById('image-upload');
const imagePreviewContainer = document.getElementById('image-preview-container');
const imagePreview = document.getElementById('image-preview');
const removeImageBtn = document.getElementById('remove-image-btn');
const submitBtn = document.getElementById('submit-btn');
const stopBtn = document.getElementById('stop-btn');
const resultsContainer = document.getElementById('results-container');

// State
let selectedImageBase64 = null;
let selectedImageName = null;
let currentTaskId = null;

const reloadBtn = document.getElementById('reload-btn');
const clearHistoryBtn = document.getElementById('clear-history-btn');
const copyAllBtn = document.getElementById('copy-all-btn');

// Event Listeners
imageUpload.addEventListener('change', handleImageUpload);
removeImageBtn.addEventListener('click', removeImage);
submitBtn.addEventListener('click', handleSubmit);

clearHistoryBtn.addEventListener('click', () => {
  currentTaskId = null;
  resultsContainer.innerHTML = '';
  chrome.storage.local.remove('currentTaskState');
  submitBtn.classList.remove('hidden');
  stopBtn.classList.add('hidden');
});

reloadBtn.addEventListener('click', () => {
  chrome.runtime.reload();
});

copyAllBtn.addEventListener('click', () => {
  const cards = document.querySelectorAll('.result-card');
  let allText = '';
  cards.forEach((card) => {
    const rawText = card.dataset.rawResult;
    if (rawText && rawText.trim() !== '') {
       if (allText !== '') {
           allText += '\n\n------------------------\n\n';
       }
       allText += rawText.trim();
    }
  });
  
  if (allText) {
    navigator.clipboard.writeText(allText).then(() => {
      const originalText = copyAllBtn.textContent;
      copyAllBtn.textContent = '已复制所有!';
      copyAllBtn.classList.add('success');
      setTimeout(() => {
        copyAllBtn.textContent = originalText;
        copyAllBtn.classList.remove('success');
      }, 2000);
    }).catch(err => {
      console.error('Copy all failed:', err);
      alert('复制失败');
    });
  }
});

stopBtn.addEventListener('click', handleStop);

resultsContainer.addEventListener('click', (e) => {
  if (e.target.classList.contains('copy-btn')) {
    const card = e.target.closest('.result-card');
    if (card) {
      const rawText = card.dataset.rawResult;
      if (rawText) {
        navigator.clipboard.writeText(rawText).then(() => {
          const originalText = e.target.textContent;
          e.target.textContent = '已复制!';
          e.target.classList.add('success');
          setTimeout(() => {
            e.target.textContent = originalText;
            e.target.classList.remove('success');
          }, 2000);
        }).catch(err => {
          console.error('Copy failed:', err);
          alert('复制失败');
        });
      }
    }
  }
});

function handleStop() {
  if (!currentTaskId) return;
  chrome.runtime.sendMessage({
    type: 'CANCEL_TASK',
    payload: { taskId: currentTaskId }
  });
  
  document.querySelectorAll('.result-card[data-status="pending"], .result-card[data-status="running"]').forEach(card => {
    card.setAttribute('data-status', 'error');
    card.querySelector('.result-status').textContent = '已终止';
    card.querySelector('.result-content').textContent = '任务已由用户手动终止';
  });
  saveTaskState();
  checkAllDone();
}

promptInput.addEventListener('input', () => {
  chrome.storage.local.set({ inputText: promptInput.value });
});

// Restore and save agent checkbox states, text input, and image
const agentCheckboxes = document.querySelectorAll('.agent-item input[type="checkbox"]');
chrome.storage.local.get(['agentStates', 'inputText', 'imageBase64', 'imageName', 'currentTaskState'], (result) => {
  let states = result.agentStates;
  // If no saved state, use default (all checked)
  if (!states) {
    states = { deepseek: true, doubao: true, kimi: true, xiaoyunque: true };
  }
  
  agentCheckboxes.forEach(cb => {
    if (states[cb.value] !== undefined) {
      cb.checked = states[cb.value];
    }
    
    // Listen for changes and save to storage
    cb.addEventListener('change', () => {
      states[cb.value] = cb.checked;
      chrome.storage.local.set({ agentStates: states });
    });
  });

  if (result.inputText) {
    promptInput.value = result.inputText;
  }
  
  if (result.imageBase64) {
    selectedImageBase64 = result.imageBase64;
    selectedImageName = result.imageName;
    imagePreview.src = selectedImageBase64;
    imagePreviewContainer.classList.remove('hidden');
  }

  if (result.currentTaskState) {
    currentTaskId = result.currentTaskState.taskId;
    const statuses = result.currentTaskState.statuses;
    for (const agentId in statuses) {
      createResultCard(agentId);
      const card = document.getElementById(`result-${agentId}`);
      const state = statuses[agentId];
        if (card) {
          card.setAttribute('data-status', state.status);
          if (state.rawResult !== undefined) {
            card.dataset.rawResult = state.rawResult;
          }
          const statusEl = card.querySelector('.result-status');
          const contentEl = card.querySelector('.result-content');
          const copyBtn = card.querySelector('.copy-btn');
          
          contentEl.innerHTML = state.content;
          
          switch (state.status) {
          case 'pending': statusEl.textContent = '准备中'; break;
          case 'running': statusEl.textContent = '生成中...'; break;
          case 'done': 
            statusEl.textContent = '已完成'; 
            if (state.rawResult && state.rawResult.trim() !== '') {
              copyBtn.classList.remove('hidden');
            }
            break;
          case 'error': 
            statusEl.textContent = '失败';
            if (state.rawResult && state.rawResult.trim() !== '') {
              copyBtn.classList.remove('hidden');
            }
            break;
        }
      }
    }
    checkAllDone();
  }

  // Enable transitions after a short delay to prevent initial animation
  setTimeout(() => {
    document.body.classList.remove('no-transition');
  }, 50);
});

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TASK_UPDATE' && message.payload.taskId === currentTaskId) {
    updateResultCard(message.payload);
  }
});

function handleImageUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  selectedImageName = file.name;
  
  const reader = new FileReader();
  reader.onload = (event) => {
    selectedImageBase64 = event.target.result;
    imagePreview.src = selectedImageBase64;
    imagePreviewContainer.classList.remove('hidden');
    chrome.storage.local.set({ 
      imageBase64: selectedImageBase64, 
      imageName: selectedImageName 
    });
  };
  reader.readAsDataURL(file);
}

function removeImage() {
  selectedImageBase64 = null;
  selectedImageName = null;
  imageUpload.value = '';
  imagePreview.src = '';
  imagePreviewContainer.classList.add('hidden');
  chrome.storage.local.remove(['imageBase64', 'imageName']);
}

function getSelectedAgents() {
  const agents = [];
  document.querySelectorAll('.agent-item input[type="checkbox"]:checked').forEach(checkbox => {
    agents.push(checkbox.value);
  });
  return agents;
}

async function handleSubmit() {
  const text = promptInput.value.trim();
  const agents = getSelectedAgents();

  if (!text && !selectedImageBase64) {
    alert('请输入提示词或上传图片');
    return;
  }

  if (agents.length === 0) {
    alert('请至少选择一个 Agent');
    return;
  }

  // Generate unique task ID
  currentTaskId = 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  
  // Clear previous results
  resultsContainer.innerHTML = '';
  
  // Create initial result cards
  agents.forEach(agent => {
    createResultCard(agent);
  });

  saveTaskState();
  checkAllDone();

  const payload = {
    taskId: currentTaskId,
    text: text,
    imageBase64: selectedImageBase64,
    imageName: selectedImageName,
    agents: agents
  };

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'SUBMIT_TASK',
      payload: payload
    });
    
    if (response && response.error) {
      alert('提交失败: ' + response.error);
      checkAllDone();
    }
  } catch (error) {
    console.error("Error sending message to background:", error);
    alert('与后台服务通信失败，请刷新重试');
    checkAllDone();
  }
}

const AgentNames = {
  deepseek: 'DeepSeek',
  doubao: '豆包',
  kimi: 'Kimi',
  xiaoyunque: '小云雀'
};

function createResultCard(agentId) {
  const card = document.createElement('div');
  card.className = 'result-card';
  card.id = `result-${agentId}`;
  card.setAttribute('data-status', 'pending');
  
  card.innerHTML = `
    <div class="result-header">
      <span class="result-agent-name">${AgentNames[agentId] || agentId}</span>
      <div class="result-header-actions">
        <button class="copy-btn hidden" title="复制返回文本">📋 复制</button>
        <span class="result-status">准备中</span>
      </div>
    </div>
    <div class="result-content">等待建立连接...</div>
  `;
  
  resultsContainer.appendChild(card);
}

function updateResultCard(payload) {
  const { agent, status, result, resultImages, error } = payload;
  const card = document.getElementById(`result-${agent}`);
  if (!card) return;

  // 如果任务已由用户手动终止，不再接收后续的状态更新
  if (card.querySelector('.result-status').textContent === '已终止') return;

  card.setAttribute('data-status', status);
  if (result !== undefined) {
    card.dataset.rawResult = result;
  }
  
  const statusEl = card.querySelector('.result-status');
  const contentEl = card.querySelector('.result-content');
  const copyBtn = card.querySelector('.copy-btn');

  if ((status === 'done' || status === 'error') && result && result.trim() !== '') {
    copyBtn.classList.remove('hidden');
  } else {
    copyBtn.classList.add('hidden');
  }

  switch (status) {
    case 'running':
      statusEl.textContent = '生成中...';
      contentEl.textContent = 'Agent 正在思考并生成回复...';
      break;
    case 'done':
      statusEl.textContent = '已完成';
      contentEl.innerHTML = formatContent(result, resultImages);
      checkAllDone();
      break;
    case 'error':
      statusEl.textContent = '失败';
      contentEl.textContent = error || '执行过程中发生未知错误';
      checkAllDone();
      break;
  }
  
  saveTaskState();
}

function saveTaskState() {
  if (!currentTaskId) return;
  const agentStatuses = {};
  document.querySelectorAll('.result-card').forEach(card => {
    const agentId = card.id.replace('result-', '');
    const status = card.getAttribute('data-status');
    const content = card.querySelector('.result-content').innerHTML;
    const rawResult = card.dataset.rawResult || '';
    agentStatuses[agentId] = { status, content, rawResult };
  });
  
  chrome.storage.local.set({
    currentTaskState: {
      taskId: currentTaskId,
      statuses: agentStatuses
    }
  });
}

function checkAllDone() {
  const pendingOrRunning = document.querySelectorAll('.result-card[data-status="pending"], .result-card[data-status="running"]');
  if (pendingOrRunning.length > 0) {
    submitBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
  } else {
    submitBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
  }

  const hasResults = Array.from(document.querySelectorAll('.result-card')).some(card => {
    return card.dataset.rawResult && card.dataset.rawResult.trim() !== '';
  });
  if (hasResults && copyAllBtn) {
    copyAllBtn.classList.remove('hidden');
  } else if (copyAllBtn) {
    copyAllBtn.classList.add('hidden');
  }
}

function formatContent(text, images) {
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
