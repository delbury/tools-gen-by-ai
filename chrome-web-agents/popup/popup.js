// DOM Elements
const promptInput = document.getElementById('prompt-input');
const imageUpload = document.getElementById('image-upload');
const imagePreviewContainer = document.getElementById('image-preview-container');
const imagePreview = document.getElementById('image-preview');
const removeImageBtn = document.getElementById('remove-image-btn');
const submitBtn = document.getElementById('submit-btn');
const resultsContainer = document.getElementById('results-container');

// State
let selectedImageBase64 = null;
let selectedImageName = null;
let currentTaskId = null;

// Event Listeners
imageUpload.addEventListener('change', handleImageUpload);
removeImageBtn.addEventListener('click', removeImage);
submitBtn.addEventListener('click', handleSubmit);

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
  };
  reader.readAsDataURL(file);
}

function removeImage() {
  selectedImageBase64 = null;
  selectedImageName = null;
  imageUpload.value = '';
  imagePreview.src = '';
  imagePreviewContainer.classList.add('hidden');
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

  submitBtn.disabled = true;
  submitBtn.textContent = '执行中...';

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
      submitBtn.disabled = false;
      submitBtn.textContent = '提交到选中 Agent';
    }
  } catch (error) {
    console.error("Error sending message to background:", error);
    alert('与后台服务通信失败，请刷新重试');
    submitBtn.disabled = false;
    submitBtn.textContent = '提交到选中 Agent';
  }
}

const AgentNames = {
  deepseek: 'DeepSeek',
  doubao: '豆包',
  kimi: 'Kimi'
};

function createResultCard(agentId) {
  const card = document.createElement('div');
  card.className = 'result-card';
  card.id = `result-${agentId}`;
  card.setAttribute('data-status', 'pending');
  
  card.innerHTML = `
    <div class="result-header">
      <span class="result-agent-name">${AgentNames[agentId] || agentId}</span>
      <span class="result-status">准备中</span>
    </div>
    <div class="result-content">等待建立连接...</div>
  `;
  
  resultsContainer.appendChild(card);
}

function updateResultCard(payload) {
  const { agent, status, result, error } = payload;
  const card = document.getElementById(`result-${agent}`);
  if (!card) return;

  card.setAttribute('data-status', status);
  
  const statusEl = card.querySelector('.result-status');
  const contentEl = card.querySelector('.result-content');

  switch (status) {
    case 'running':
      statusEl.textContent = '生成中...';
      contentEl.textContent = 'Agent 正在思考并生成回复...';
      break;
    case 'done':
      statusEl.textContent = '已完成';
      contentEl.textContent = result || '没有返回文本内容';
      checkAllDone();
      break;
    case 'error':
      statusEl.textContent = '失败';
      contentEl.textContent = error || '执行过程中发生未知错误';
      checkAllDone();
      break;
  }
}

function checkAllDone() {
  const pendingOrRunning = document.querySelectorAll('.result-card[data-status="pending"], .result-card[data-status="running"]');
  if (pendingOrRunning.length === 0) {
    submitBtn.disabled = false;
    submitBtn.textContent = '提交到选中 Agent';
  }
}
