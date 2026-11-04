// chat.js — Chat view logic: streaming render, attachments, HITL/question cards.

const Chat = (() => {
  let sessionId = '';
  let running = false;
  let pendingFiles = []; // {file, type}
  let currentAssistantEl = null;
  let currentTextBuf = '';

  function els() {
    return {
      list: document.getElementById('messageList'),
      input: document.getElementById('chatInput'),
      send: document.getElementById('sendBtn'),
      stop: document.getElementById('stopBtn'),
      attach: document.getElementById('attachBtn'),
      fileInput: document.getElementById('fileInput'),
      pending: document.getElementById('pendingAttachments'),
      model: document.getElementById('modelSelect'),
      access: document.getElementById('accessSelect'),
    };
  }

  function setRunning(r) {
    running = r;
    const e = els();
    e.send.style.display = r ? 'none' : '';
    e.stop.style.display = r ? '' : 'none';
  }

  function addMsg(role, text) {
    const e = els();
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    div.textContent = text;
    e.list.appendChild(div);
    e.list.scrollTop = e.list.scrollHeight;
    return div;
  }

  function startAssistant() {
    currentTextBuf = '';
    currentAssistantEl = addMsg('assistant', '');
  }

  function appendText(delta) {
    currentTextBuf += delta;
    if (currentAssistantEl) {
      currentAssistantEl.textContent = currentTextBuf;
      els().list.scrollTop = els().list.scrollHeight;
    }
  }

  function addToolCall(name, args) {
    if (!currentAssistantEl) startAssistant();
    const div = document.createElement('div');
    div.className = 'tool-call';
    const argStr = args ? JSON.stringify(args).slice(0, 200) : '';
    div.textContent = `⚙ ${name} ${argStr}`;
    currentAssistantEl.appendChild(div);
  }

  function addHitlCard(command, actionId) {
    const e = els();
    const div = document.createElement('div');
    div.className = 'msg assistant';
    div.innerHTML = '';
    const label = document.createElement('div');
    label.textContent = `⚠ 需要审批的命令：\n${command}`;
    label.style.whiteSpace = 'pre-wrap';
    const row = document.createElement('div');
    row.style.marginTop = '10px';
    const ok = document.createElement('button');
    ok.className = 'btn-primary'; ok.textContent = '批准执行';
    const no = document.createElement('button');
    no.className = 'btn-danger'; no.textContent = '拒绝'; no.style.marginLeft = '8px';
    ok.onclick = () => { respondHitl('approve', actionId); div.remove(); };
    no.onclick = () => { respondHitl('deny', actionId); div.remove(); };
    row.appendChild(ok); row.appendChild(no);
    div.appendChild(label); div.appendChild(row);
    e.list.appendChild(div);
    e.list.scrollTop = e.list.scrollHeight;
  }

  function addQuestionCard(payload, actionId) {
    const e = els();
    const div = document.createElement('div');
    div.className = 'msg assistant';
    const questions = (payload && payload.questions) || [];
    const answers = [];
    questions.forEach((q, qi) => {
      const h = document.createElement('div');
      h.textContent = q.header || '';
      h.style.fontWeight = '600';
      div.appendChild(h);
      if (q.detail) {
        const d = document.createElement('div');
        d.textContent = q.detail; d.style.color = 'var(--text-dim)'; d.style.fontSize = '12px';
        div.appendChild(d);
      }
      const opts = q.options || [];
      if (opts.length) {
        opts.forEach(o => {
          const b = document.createElement('button');
          b.className = 'btn-primary'; b.style.margin = '4px 6px 0 0';
          b.textContent = o.label + (o.recommended ? ' ★' : '');
          b.onclick = () => {
            answers[qi] = { text: o.label, skipped: false };
            submitAnswers(actionId, answers, div);
          };
          div.appendChild(b);
        });
      } else {
        const inp = document.createElement('input');
        inp.style.cssText = 'margin-top:6px;width:100%;max-width:360px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px;';
        inp.placeholder = '输入回答后回车';
        inp.onkeydown = (ev) => {
          if (ev.key === 'Enter') {
            answers[qi] = { text: inp.value, skipped: !inp.value };
            submitAnswers(actionId, answers, div);
          }
        };
        div.appendChild(inp);
      }
    });
    e.list.appendChild(div);
    e.list.scrollTop = e.list.scrollHeight;
  }

  function submitAnswers(actionId, answers, cardEl) {
    const payload = { answers: answers.filter(Boolean) };
    API.post('/web/chat/input', {
      sessionId, questionAnswer: JSON.stringify(payload), actionId,
    }).then(() => { if (cardEl) cardEl.remove(); setRunning(true); });
  }

  function respondHitl(action, actionId) {
    API.post('/web/chat/input', { sessionId, hitlAction: action, actionId }).then(() => setRunning(true));
  }

  function handleFrame(frame) {
    if (frame.sessionId && sessionId && frame.sessionId !== sessionId) return;
    switch (frame.type) {
      case 'reason_start': break;
      case 'reason': break; // thinking — could render separately
      case 'text': appendText(frame.text || ''); break;
      case 'action_start': addToolCall(frame.toolName, frame.args); break;
      case 'action_end': break;
      case 'hitl': addHitlCard(frame.command || '', frame.actionId); setRunning(false); break;
      case 'question': addQuestionCard(frame.args || {}, frame.actionId); setRunning(false); break;
      case 'retry': addMsg('error', frame.text || '重试中…'); break;
      case 'error': addMsg('error', frame.text || '发生错误'); setRunning(false); break;
      case 'done':
        if (!frame.suspended) setRunning(false);
        currentAssistantEl = null;
        break;
      case 'user': break;
      default: break;
    }
  }

  async function send() {
    const e = els();
    const text = e.input.value.trim();
    if (!text && pendingFiles.length === 0) return;
    e.input.value = '';
    addMsg('user', text);
    setRunning(true);
    startAssistant();

    const fd = new FormData();
    fd.append('sessionId', sessionId);
    fd.append('input', text);
    fd.append('model', e.model.value);
    fd.append('accessMode', e.access.value);
    pendingFiles.forEach(f => {
      fd.append('attachments', f.file, f.file.name);
      fd.append('attachmentTypes', f.type);
    });
    pendingFiles = [];
    renderPending();

    const resp = await API.postForm('/web/chat/input', fd);
    if (resp.data && resp.data.sessionId) sessionId = resp.data.sessionId;
    if (resp.data === 'busy') { addMsg('error', '当前会话正在运行'); setRunning(false); }
  }

  function stop() {
    API.post('/web/chat/interrupt', { sessionId }).then(() => setRunning(false));
  }

  function renderPending() {
    const box = els().pending;
    box.innerHTML = '';
    pendingFiles.forEach((f, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = `📎 ${f.file.name}`;
      const rm = document.createElement('button');
      rm.textContent = '✕';
      rm.onclick = () => { pendingFiles.splice(i, 1); renderPending(); };
      chip.appendChild(rm);
      box.appendChild(chip);
    });
  }

  async function loadSession(id) {
    sessionId = id;
    const e = els();
    e.list.innerHTML = '';
    currentAssistantEl = null;
    API.connectWs(id);
    // Load history
    const resp = await API.get('/web/chat/messages', { sessionId: id });
    (resp.data || []).forEach(m => {
      if (m.role === 'USER') addMsg('user', m.content);
      else if (m.role === 'ASSISTANT') addMsg('assistant', m.content);
    });
    // Replay running state
    const replay = await API.get('/web/chat/replay', { sessionId: id });
    if (replay.data && replay.data.running) setRunning(true);
  }

  function newSession() {
    sessionId = '';
    els().list.innerHTML = '';
    currentAssistantEl = null;
    API.connectWs('');
  }

  function getSessionId() { return sessionId; }

  function init() {
    const e = els();
    e.send.onclick = send;
    e.stop.onclick = stop;
    e.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
    });
    e.attach.onclick = () => e.fileInput.click();
    e.fileInput.onchange = () => {
      Array.from(e.fileInput.files).forEach(f => {
        const isImg = /^image\//.test(f.type);
        pendingFiles.push({ file: f, type: isImg ? 'image' : 'file' });
      });
      e.fileInput.value = '';
      renderPending();
    };
    e.access.onchange = () => {
      API.post('/web/chat/access/select', { sessionId, accessMode: e.access.value });
    };
    API.onFrame(handleFrame);
  }

  return { init, loadSession, newSession, getSessionId, setRunning };
})();
