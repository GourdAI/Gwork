// views.js — Non-chat views: automation, memory, skills, channels, files, terminal, usage, settings.

const Views = (() => {
  // ── Automation (Loop) ──
  async function loadLoops() {
    const resp = await API.get('/web/chat/loop/list', { sessionId: Chat.getSessionId() || 'global' });
    const box = document.getElementById('loopList');
    box.innerHTML = '';
    (resp.data || []).forEach(t => {
      const card = document.createElement('div');
      card.className = 'card';
      const title = document.createElement('div');
      title.className = 'card-title';
      title.textContent = (t.name || t.prompt.slice(0, 40)) + (t.enabled ? '' : '（已停用）');
      const meta = document.createElement('div');
      meta.className = 'card-meta';
      const sched = t.cron ? `cron: ${t.cron}` : `每 ${t.intervalMinutes} 分钟`;
      meta.textContent = `${sched} · 已执行 ${t.currentIteration} 次${t.lastResult ? ' · 上次: ' + String(t.lastResult).slice(0, 60) : ''}`;
      const actions = document.createElement('div');
      actions.className = 'card-actions';
      const trig = document.createElement('button');
      trig.className = 'btn-primary'; trig.textContent = '立即执行';
      trig.onclick = () => API.post('/web/chat/loop/trigger', { sessionId: Chat.getSessionId() || 'global', taskId: t.id });
      const tog = document.createElement('button');
      tog.className = 'btn-primary'; tog.textContent = t.enabled ? '停用' : '启用';
      tog.onclick = () => API.post('/web/chat/loop/toggle', { sessionId: Chat.getSessionId() || 'global', taskId: t.id }).then(loadLoops);
      const del = document.createElement('button');
      del.className = 'btn-danger'; del.textContent = '删除';
      del.onclick = () => API.post('/web/chat/loop/remove', { sessionId: Chat.getSessionId() || 'global', taskId: t.id }).then(loadLoops);
      actions.appendChild(trig); actions.appendChild(tog); actions.appendChild(del);
      card.appendChild(title); card.appendChild(meta); card.appendChild(actions);
      box.appendChild(card);
    });
  }

  function showAddLoop() {
    openModal('新建自动化任务', `
      <div class="form-row"><label>任务名称</label><input id="loopName" /></div>
      <div class="form-row"><label>提示词（必填）</label><textarea id="loopPrompt" rows="3"></textarea></div>
      <div class="form-row"><label>间隔分钟</label><input id="loopInterval" type="number" value="5" /></div>
      <div class="form-row"><label>Cron 表达式（可选，优先于间隔）</label><input id="loopCron" placeholder="0 */5 * * * *" /></div>
      <div class="form-row"><label>目标条件（可选，达成后自动停止）</label><input id="loopGoal" /></div>
    `, () => {
      const body = {
        sessionId: Chat.getSessionId() || 'global',
        name: document.getElementById('loopName').value,
        prompt: document.getElementById('loopPrompt').value,
        intervalMinutes: parseInt(document.getElementById('loopInterval').value) || 5,
      };
      const cron = document.getElementById('loopCron').value.trim();
      if (cron) body.cron = cron;
      const goal = document.getElementById('loopGoal').value.trim();
      if (goal) body.goalCondition = goal;
      API.post('/web/chat/loop/add', body).then(() => { closeModal(); loadLoops(); });
    });
  }

  // ── Memory ──
  async function loadMemory() {
    const resp = await API.get('/web/chat/memory/list', { scope: 'global' });
    const box = document.getElementById('memoryList');
    box.innerHTML = '';
    (resp.data || []).forEach(m => {
      const card = document.createElement('div');
      card.className = 'card';
      const title = document.createElement('div');
      title.className = 'card-title';
      title.textContent = `${m.title}（权重 ${m.importance}）`;
      const fact = document.createElement('div');
      fact.className = 'card-meta';
      fact.style.whiteSpace = 'pre-wrap';
      fact.textContent = String(m.fact).slice(0, 300);
      const actions = document.createElement('div');
      actions.className = 'card-actions';
      const del = document.createElement('button');
      del.className = 'btn-danger'; del.textContent = '删除';
      del.onclick = () => API.post('/web/chat/memory/delete', { key: m.key }).then(loadMemory);
      actions.appendChild(del);
      card.appendChild(title); card.appendChild(fact); card.appendChild(actions);
      box.appendChild(card);
    });
  }

  // ── Skills ──
  async function loadSkills() {
    const resp = await API.get('/web/settings/skills/installed');
    const box = document.getElementById('skillList');
    box.innerHTML = '';
    (resp.data || []).forEach(s => {
      const card = document.createElement('div');
      card.className = 'card';
      const title = document.createElement('div');
      title.className = 'card-title';
      title.textContent = s.title || s.name;
      const meta = document.createElement('div');
      meta.className = 'card-meta';
      meta.textContent = s.description || '';
      const actions = document.createElement('div');
      actions.className = 'card-actions';
      const un = document.createElement('button');
      un.className = 'btn-danger'; un.textContent = '卸载';
      un.onclick = () => API.post('/web/settings/skills/uninstall', { skillName: s.name }).then(loadSkills);
      actions.appendChild(un);
      card.appendChild(title); card.appendChild(meta); card.appendChild(actions);
      box.appendChild(card);
    });
  }

  // ── Channels ──
  async function loadChannels() {
    const resp = await API.get('/chat/channel/status');
    const box = document.getElementById('channelList');
    box.innerHTML = '';
    const names = { wechat: '微信', feishu: '飞书', dingtalk: '钉钉' };
    const data = resp.data || {};
    Object.keys(names).forEach(ch => {
      const st = data[ch] || {};
      const card = document.createElement('div');
      card.className = 'card';
      const title = document.createElement('div');
      title.className = 'card-title';
      title.textContent = names[ch];
      const badge = document.createElement('span');
      badge.className = 'badge ' + (st.connected ? 'on' : 'off');
      badge.textContent = st.connected ? '已连接' : '未连接';
      badge.style.marginLeft = '8px';
      title.appendChild(badge);
      const meta = document.createElement('div');
      meta.className = 'card-meta';
      meta.textContent = st.activeSessionId ? `活跃会话: ${st.activeSessionId}` : '未绑定会话';
      card.appendChild(title); card.appendChild(meta);
      box.appendChild(card);
    });
  }

  // ── Files ──
  async function loadFileTree() {
    const resp = await API.get('/web/chat/filer/tree', { path: '', depth: 3 });
    const box = document.getElementById('fileTree');
    box.innerHTML = '';
    if (resp.data && resp.data.children) renderTreeNodes(resp.data.children, box);
  }

  function renderTreeNodes(nodes, parent) {
    nodes.forEach(n => {
      const div = document.createElement('div');
      div.className = 'node';
      div.textContent = (n.type === 'dir' ? '📁 ' : '📄 ') + n.name;
      div.onclick = () => {
        if (n.type === 'file') openFile(n.path);
      };
      parent.appendChild(div);
      if (n.type === 'dir' && n.children && n.children.length) {
        const kids = document.createElement('div');
        kids.className = 'children';
        renderTreeNodes(n.children, kids);
        parent.appendChild(kids);
      }
    });
  }

  async function openFile(path) {
    document.getElementById('filePath').textContent = path;
    const resp = await API.get('/web/chat/filer/read', { path });
    document.getElementById('fileContent').textContent = (resp.data && resp.data.content) || '';
  }

  // ── Terminal ──
  let termWs = null;
  function connectTerminal() {
    const out = document.getElementById('terminalOutput');
    const base = API.getBase().replace(/^http/, 'ws');
    termWs = new WebSocket(`${base}/web/terminal?sessionId=ui-term`);
    termWs.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'output') { out.textContent += msg.data + '\n'; out.scrollTop = out.scrollHeight; }
      } catch (e) {}
    };
    document.getElementById('terminalInput').onkeydown = (ev) => {
      if (ev.key === 'Enter') {
        const line = ev.target.value;
        ev.target.value = '';
        out.textContent += '$ ' + line + '\n';
        if (termWs && termWs.readyState === 1) termWs.send(JSON.stringify({ type: 'input', data: line }));
      }
    };
  }

  // ── Usage ──
  async function loadUsage() {
    const resp = await API.get('/web/chat/usage/stats', { days: 30 });
    const d = resp.data || {};
    const stats = document.getElementById('usageStats');
    stats.innerHTML = `
      <div class="stat-card"><div class="num">${d.totalRuns || 0}</div><div class="label">总运行次数</div></div>
      <div class="stat-card"><div class="num">${(d.totalInputTokens || 0).toLocaleString()}</div><div class="label">输入 Tokens</div></div>
      <div class="stat-card"><div class="num">${(d.totalOutputTokens || 0).toLocaleString()}</div><div class="label">输出 Tokens</div></div>
      <div class="stat-card"><div class="num">${d.sessionCount || 0}</div><div class="label">会话数</div></div>
    `;
    const heat = document.getElementById('usageHeatmap');
    heat.innerHTML = '';
    (d.heatmap || []).forEach(day => {
      const cell = document.createElement('div');
      cell.className = 'heat-cell';
      const intensity = Math.min(1, (day.runs || 0) / 10);
      cell.style.background = intensity === 0 ? 'var(--bg-hover)' : `rgba(79,140,255,${0.2 + intensity * 0.8})`;
      cell.title = `${day.date}: ${day.runs} 次`;
      heat.appendChild(cell);
    });
  }

  // ── Settings ──
  async function loadSettings() {
    // General
    const gen = await API.get('/web/settings/general');
    const g = gen.data || {};
    document.getElementById('settings-general').innerHTML = `
      <div class="form-row"><label>历史窗口大小</label><input id="setHistory" type="number" value="${g.historyWindowSize || 30}" /></div>
      <div class="form-row"><label>API 重试次数</label><input id="setRetries" type="number" value="${g.apiRetries || 3}" /></div>
      <div class="form-row"><label>最大轮次</label><input id="setTurns" type="number" value="${g.maxTurns || 20}" /></div>
      <div class="form-row"><label><input id="setMemory" type="checkbox" ${g.memoryEnabled ? 'checked' : ''} /> 启用记忆</label></div>
      <button class="btn-primary" id="saveGeneralBtn">保存</button>
    `;
    document.getElementById('saveGeneralBtn').onclick = () => {
      API.post('/web/settings/general/save', {
        historyWindowSize: document.getElementById('setHistory').value,
        apiRetries: document.getElementById('setRetries').value,
        maxTurns: document.getElementById('setTurns').value,
        memoryEnabled: document.getElementById('setMemory').checked,
      });
    };

    // Models
    const models = await API.get('/web/settings/llm/models');
    const mbox = document.getElementById('settings-models');
    mbox.innerHTML = '<div class="form-row"><label>已配置模型</label></div>';
    (models.data || []).forEach(m => {
      const row = document.createElement('div');
      row.className = 'model-row';
      row.innerHTML = `<span class="name">${m.name} <span class="badge ${m.enabled ? 'on' : 'off'}">${m.enabled ? '启用' : '停用'}</span></span>`;
      const def = document.createElement('button');
      def.className = 'btn-primary'; def.textContent = '设为默认'; def.style.padding = '3px 8px';
      def.onclick = () => API.post('/web/settings/llm/models/default', { name: m.name }).then(loadModels);
      const tog = document.createElement('button');
      tog.className = 'btn-primary'; tog.textContent = m.enabled ? '停用' : '启用'; tog.style.padding = '3px 8px';
      tog.onclick = () => API.post('/web/settings/llm/models/toggle', { name: m.name }).then(loadModels);
      row.appendChild(def); row.appendChild(tog);
      mbox.appendChild(row);
    });

    // Permission
    const perm = await API.get('/web/settings/permission');
    const p = perm.data || {};
    document.getElementById('settings-permission').innerHTML = `
      <div class="form-row"><label>允许的工具（逗号分隔，** 为全部）</label><input id="permTools" value="${(p.tools || []).join(',')}" /></div>
      <div class="form-row"><label>禁用的工具（逗号分隔）</label><input id="permDisallowed" value="${(p.disallowedTools || []).join(',')}" /></div>
      <button class="btn-primary" id="savePermBtn">保存</button>
    `;
    document.getElementById('savePermBtn').onclick = () => {
      API.post('/web/settings/permission/save', {
        tools: document.getElementById('permTools').value,
        disallowedTools: document.getElementById('permDisallowed').value,
      });
    };

    // ACP
    const acp = await API.get('/web/settings/acp/info');
    const a = acp.data || {};
    document.getElementById('settings-acp').innerHTML = `
      <div class="form-row"><label>编辑器接入方式</label>
        <div class="card-meta">编辑器（Zed/VSCode）将 <code>gwork acp</code> 作为子进程拉起，通过标准输入输出通信。</div>
      </div>
      <div class="form-row"><label>启动器路径</label><input value="${a.command || ''}" readonly /></div>
      <div class="form-row"><label>状态</label><div class="card-meta">${a.launcherReady ? '✅ 启动器就绪' : '⚠ 启动器未找到'}</div></div>
      <div class="form-row"><label>ACP 模型</label><input id="acpModel" value="${a.acpModel || ''}" placeholder="留空使用默认模型" /></div>
      <button class="btn-primary" id="saveAcpBtn">保存</button>
    `;
    document.getElementById('saveAcpBtn').onclick = () => {
      API.post('/web/settings/acp/model/save', { acpModel: document.getElementById('acpModel').value });
    };
  }

  async function loadModels() {
    const resp = await API.get('/web/chat/models');
    const sel = document.getElementById('modelSelect');
    sel.innerHTML = '';
    const d = resp.data || {};
    (d.models || []).forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.name; opt.textContent = m.name;
      if (m.name === d.selected) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  // ── Modal helpers ──
  function openModal(title, bodyHtml, onOk) {
    const overlay = document.getElementById('modalOverlay');
    const box = document.getElementById('modalBox');
    box.innerHTML = `<h3>${title}</h3>${bodyHtml}
      <div class="modal-actions">
        <button class="btn-primary" id="modalOk">确定</button>
        <button class="btn-danger" id="modalCancel">取消</button>
      </div>`;
    overlay.style.display = 'flex';
    document.getElementById('modalOk').onclick = onOk;
    document.getElementById('modalCancel').onclick = closeModal;
  }
  function closeModal() { document.getElementById('modalOverlay').style.display = 'none'; }

  // ── View switching ──
  const loaders = {
    chat: () => {},
    automation: loadLoops,
    memory: loadMemory,
    skills: loadSkills,
    channels: loadChannels,
    files: loadFileTree,
    terminal: connectTerminal,
    usage: loadUsage,
    settings: loadSettings,
  };

  function switchView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const view = document.getElementById('view-' + name);
    if (view) view.classList.add('active');
    const nav = document.querySelector(`.nav-item[data-view="${name}"]`);
    if (nav) nav.classList.add('active');
    if (loaders[name]) loaders[name]();
  }

  function init() {
    document.querySelectorAll('.nav-item').forEach(n => {
      n.onclick = () => switchView(n.dataset.view);
    });
    document.getElementById('addLoopBtn').onclick = showAddLoop;
    document.getElementById('clearMemoryBtn').onclick = () => API.post('/web/chat/memory/clear').then(loadMemory);
    document.querySelectorAll('.settings-tabs .tab').forEach(t => {
      t.onclick = () => {
        document.querySelectorAll('.settings-tabs .tab').forEach(x => x.classList.remove('active'));
        document.querySelectorAll('.settings-panel').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        document.getElementById('settings-' + t.dataset.tab).classList.add('active');
      };
    });
  }

  return { init, switchView, loadModels };
})();
