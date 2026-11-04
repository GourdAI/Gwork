// app.js — Bootstrap: init API, load sessions/models, wire navigation.

(async function main() {
  await API.init();
  Chat.init();
  Views.init();
  await Views.loadModels();
  await loadSessions();
  API.connectWs('');

  document.getElementById('newChatBtn').onclick = () => {
    Chat.newSession();
    highlightSession('');
  };

  // Auto-resize textarea
  const input = document.getElementById('chatInput');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  });

  // Periodically refresh session list
  setInterval(loadSessions, 15000);
})();

async function loadSessions() {
  const resp = await API.get('/web/chat/sessions');
  const box = document.getElementById('sessionList');
  const current = Chat.getSessionId();
  box.innerHTML = '';
  (resp.data || []).slice(0, 50).forEach(s => {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.sessionId === current ? ' active' : '');
    const label = document.createElement('span');
    label.textContent = s.title || s.sessionId;
    label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.onclick = (ev) => {
      ev.stopPropagation();
      API.post('/web/chat/sessions/delete?sessionId=' + encodeURIComponent(s.sessionId)).then(loadSessions);
    };
    item.appendChild(label);
    item.appendChild(del);
    item.onclick = () => {
      Chat.loadSession(s.sessionId);
      Views.switchView('chat');
      highlightSession(s.sessionId);
    };
    box.appendChild(item);
  });
}

function highlightSession(id) {
  document.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
  // Re-mark on next loadSessions; simple approach:
  loadSessions();
}
