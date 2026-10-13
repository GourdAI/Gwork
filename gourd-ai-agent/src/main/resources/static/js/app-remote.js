/* app-remote.js — 远程工作区（P1 SSH + P2 WSL + P3 CLI 预装）：连接向导 + 状态管理。
   对应《远程工作区方案.md》方案 A：桌面端经 SSH 隧道 / WSL localhost 直连访问远端 GWork 后端，
   文件/终端/Git/Agent 全部在远端执行；本地工作区零改动。

   ┌─ 数据面（P0 修复后的架构） ──────────────────────────────────────┐
   │ 前端始终同源请求本地 UI 服务器 http://127.0.0.1:{uiPort}/web/**     │
   │ Rust 侧按工作区分流（server.rs REMOTE_ROUTE）：选中远端工作区时     │
   │ 经 remote_bind_scope 登记归属，/web/** 与 WS 升级代理把该工作区的请 │
   │ 求切到隧道端口并注入 Authorization 头；本地工作区与设置面恒回本地。 │
   │ 为什么不能前端改写请求地址（P1 原方案，已废弃）：                      │
   │  1) 跨源（uiPort→tunnelPort）+ Authorization 头必触发 CORS 预检，     │
   │     远端 jar 不回 Access-Control-Allow-*，WebView 全灭；             │
   │  2) 浏览器 WebSocket API 无法带自定义 Authorization 头，远端         │
   │     WebAuthFilter 会把 /web/gate 升级全 401。                         │
   │ 同源+服务端切换两个问题同时消失，前端零地址感知。                      │
   │ 前端的职责只剩两件：声明工作区归属（bind_scope）+ 跨环境时重建长连接。│
   └─────────────────────────────────────────────────────────────────────┘

   三通道（P2/P3）：
   - ssh          远程 Linux/macOS 主机（russh 隧道）
   - wsl          Windows 本机 WSL2 发行版（仅 win32 宿主；distro 下拉自动拉取）
    - preinstalled 已装 gwork CLI 的服务器（探测命中跳过部署，回退标准部署链）
      ※ 入口当前被 PREINSTALLED_CHANNEL_ENABLED=false 屏蔽（2026-10-08 用户拍板），
        后端链路保留，仅向导 tab 不渲染；历史保存条目按 ssh 形态打开。

   状态持久化：localStorage（远程主机配置不含密码/口令——仅 host/port/user/
   authType/keyPath/channel；敏感字段只在连接向导会话内存中存活，OS 凭据库由
   Rust 侧 keyring 承载（P4 记住密码）。*/
(function () {
    var LS_HOSTS = 'gourdai-remote-hosts';        // 已保存主机列表（非敏感字段）
    /* 在线连接 id 数组（JSON）。旧版为单值字符串（「同时只有一台」的前端根因之一），
       读取时自动迁移为 [旧值]——多远端并发（方案B，用户 2026-10-10 拍板）。 */
    var LS_ACTIVE = 'gourdai-remote-active';

    /* CLI 预装通道（P3）入口屏蔽开关（2026-10-08 用户拍板「CLI 预装先屏蔽掉」）。
       false = 向导不渲染该 tab、也不允许切到该通道；Rust 侧 connect_preinstalled /
       detect_preinstalled 全保留（后端能力不动，纯前端入口屏蔽），恢复时改 true 即可。
       为什么用开关而不是删代码：P3 链路（探测命中跳过部署/回退标准部署）已验收，
       删掉再恢复要重走全部验证；屏蔽期间入口不可达即等于不存在。 */
    var PREINSTALLED_CHANNEL_ENABLED = false;

    /* 已保存主机的生效通道：屏蔽期间 channel==='preinstalled' 的历史条目
       降级按 'ssh' 打开（preinstalled 本就是 ssh 传输 + 部署策略差异，字段全兼容），
       避免 wizardChannel 落到被屏蔽通道后向导渲染出不可达形态。 */
    function effectiveChannel(h) {
        var ch = (h && h.channel) || 'ssh';
        if (ch === 'preinstalled' && !PREINSTALLED_CHANNEL_ENABLED) return 'ssh';
        return ch;
    }

    /* ================= 状态 =================
       【连接注册表（方案B）】connectionsById 是在线连接的唯一真相源：
       旧版单变量 activeConnection 在连第二台时把第一台对象覆盖丢失（用户投诉
       「同时只有一个」的前端根因），且旧连接永久失去断开入口→远端进程泄漏。
       现改为 id→条目 map + activeId 单值（语义=当前选中环境，与 Rust 侧
       RemoteRoute.active 对齐：由工作区选择经 setActiveId 置位）。 */
    var connectionsById = Object.create(null);
    var activeIdStored = null;      // 用户选中环境对应的 connectionId（null=本地/未选）
    var connChangeListeners = [];
    var activeConnection = null;   // 【兼容别名】恒等于 connectionsById[activeId()]，供未迁移调用方读
    var connecting = false;
    var connectingId = null;       // 进行中的连接流程预期 connectionId（进度事件按它过滤防串流）
    var wizardChannel = 'ssh';     // 向导当前通道：ssh | wsl（| preinstalled，受 PREINSTALLED_CHANNEL_ENABLED 屏蔽）
    /* WSL 发行版缓存（P2-D 注释修正）：null = 尚未拉取（首次切到 WSL 页签时去拉），
       [] = 拉过了但没可用发行版——此时**不是隐藏 WSL 页签**（页签可见性只由
       win32 决定），而是下拉里展示「未发现 WSL 发行版」并让连接前的必填校验拦住。
       原先注释写「隐藏通道」与实际行为不符，会误导后续改动去加隐藏逻辑。 */
    var wslDistros = null;
    /* layui select 会把原生 <select> 隐藏（.layui-form select{display:none}）并另建面板，
       选中值以本镜像为准：异步填充/已保存主机回填先写这里再 render，连接取值也读这里
       （与 app-automation.js 的 formState.channel 同范式，避免读隐藏原生 select 的时序坑）。 */
    var pendingDistro = '';

    function esc(s) {
        var d = document.createElement('div');
        d.textContent = (s == null ? '' : String(s));
        return d.innerHTML.replace(/"/g, '&quot;');
    }

    function savedHosts() {
        try { return JSON.parse(localStorage.getItem(LS_HOSTS) || '[]') || []; } catch (e) { return []; }
    }
    function saveHosts(list) {
        try { localStorage.setItem(LS_HOSTS, JSON.stringify(list)); } catch (e) {}
    }
    /* 读在线 id 数组（含旧单值字符串迁移） */
    function readActiveIds() {
        try {
            var raw = localStorage.getItem(LS_ACTIVE);
            if (!raw) return [];
            var v = JSON.parse(raw);
            if (Object.prototype.toString.call(v) === '[object Array]') {
                return v.filter(function (x) { return typeof x === 'string' && x; });
            }
            /* 旧版若存 JSON.stringify(单值)（带引号字符串）：parse 成功但不进 catch。
               原注释声称「解出字符串→迁移为单元素数组」，但该形态根本走不到 catch 分支，
               落进下方 return [] 直接丢——两种历史形态都必须迁出，否则升级即丢连接记录。 */
            if (typeof v === 'string' && v) return [v];
            return [];
        } catch (e) {
            /* 旧版裸单值字符串（无引号）：JSON.parse 抛错——迁移为单元素数组 */
            try {
                var raw2 = localStorage.getItem(LS_ACTIVE);
                if (raw2 && typeof raw2 === 'string' && raw2.charAt(0) !== '[') return [raw2];
            } catch (e2) {}
            return [];
        }
    }
    function persistActiveIds(ids) {
        try {
            if (ids && ids.length) localStorage.setItem(LS_ACTIVE, JSON.stringify(ids));
            else localStorage.removeItem(LS_ACTIVE);
        } catch (e) {}
    }
    function persistActive(id) { /* 兼容旧调用点：单值语义已废弃，转写数组 */
        persistActiveIds(id ? [id] : []);
    }

    /* 连接 → 主机展示名映射（对标 ZCode 的 formatRemoteWorkspaceDisplayLabel：
       远端条目带 `[SSH: alias]` 后缀）。

       为什么需要：列表条目只知道自己的 _scope（就是 connectionId），但 connectionId
       是 `rc-<host:port:user>` 形态的内部键——直接展示它用户认不出是哪台机器。
       而主机名只有本模块知道（activeConnection / remoteState 回传）。
       不能拿 savedHosts()[0] 充数：那是「最近连过的那台」，多机场景下会报错主机
       （与徽标同根，P2-C 已修过一次）。 */
    var hostLabelByConnection = Object.create(null);

    /* 展示名口径与徽标一致（refreshRemoteBadge L659）：user@host，无 user 则只 host。
       WSL 通道 host 字段存的是发行版名，同样成立。 */
    function hostLabelOf(outcome) {
        if (!outcome) return '';
        var h = outcome.host || '';
        var u = outcome.user || '';
        return u ? (u + '@' + h) : h;
    }

    /* 按 connectionId 查主机展示名；查不到返回空串（调用方自行回退到通用文案，
       绝不把 connectionId 当主机名展示给用户）。 */
    window.__remoteHostLabel = function (connectionId) {
        if (!connectionId) return '';
        return hostLabelByConnection[connectionId] || '';
    };

    /* ================= 连接状态（代理切换由 Rust 侧完成，见头部注释） =================

       前端不再改写任何请求地址：本地 UI 服务器（同源）在 Rust 侧按工作区分流，
       把命中远端绑定的请求切到隧道端口并注入 Authorization。前端职责：
       - 记录激活连接（徽标/菜单/重连入口）
       - 选中工作区时声明它的归属（remote_bind_scope，见 app-workspace）
       - 跨环境切换/连接状态变化时重建长连接（WS 指向旧上游已失效） */

    /* ================= 多连接读口（契约 §2.2，全站唯一） =================
       各模块（workspace/history/code/streaming）一律经 window.__GOURD_REMOTE__
       读连接表，禁止再私读 activeConnection——单值读口正是「非 active 连接的
       工作区不可见/不可管」的根因。 */
    function connEntries() {
        var out = [];
        for (var id in connectionsById) {
            if (!Object.prototype.hasOwnProperty.call(connectionsById, id)) continue;
            var c = connectionsById[id];
            out.push({
                connectionId: id,
                host: c.host || '', user: c.user || '', channel: c.channel || 'ssh',
                state: c.state || 'connected', refs: c.refs || 1,
                localPort: c.localPort || 0, remotePort: c.remotePort || 0,
                label: hostLabelByConnection[id] || hostLabelOf(c)
            });
        }
        return out;
    }
    function notifyConnectionsChanged() {
        var ids = connEntries().map(function (c) { return c.connectionId; });
        var detail = { ids: ids, connections: connEntries() };
        for (var i = 0; i < connChangeListeners.length; i++) {
            try { connChangeListeners[i](detail); } catch (e) {}
        }
        window.dispatchEvent(new CustomEvent('remote:connections-changed', { detail: detail }));
        if (typeof window.refreshRemoteBadge === 'function') window.refreshRemoteBadge();
    }
    function setActiveId(id) {
        activeIdStored = id || null;
        activeConnection = id ? (connectionsById[id] || null) : null;
    }
    /* activeId 的用户置位入口（2026-10-11 自查 P2 修复）：selectChatWorkspace /
       selectProject 在绑定远端 scope 成功的那一刻调它，让前端这份「当前环境」
       与 Rust 侧 RemoteRoute.active（bind_scope 置位）保持同步。
       【修复前的问题】setActiveId 是模块私有函数，用户选中远端工作区后
       activeIdStored 恒为启动恢复时的旧值——remoteActiveOutcome() 返回 null、
       旧壳降级分支（pickRemoteConn/loadProjects 的 ACTIVE_ID 兜底）拿到错误答案、
       徽标 multi 时 primary 的选取与真实选中环境脱节。注释一直声称「由工作区
       选择经 setActiveId 置位」但从未接线 = 注释撒谎（与上轮 P1-2 同款病灶）。
       WHY 经 window 暴露而非事件：app-workspace/app-code 是同级模块（闭包隔离），
       且调用点需要「同步完成」——事件监听存在注册时序与异步派发的窗口。
       传不存在的 id 静默忽略（不置 null：那是断开路径 doDisconnect 的职责）。 */
    window.__GOURD_REMOTE_SET_ACTIVE__ = function (id) {
        if (id && !connectionsById[id]) return;
        if (activeIdStored === (id || null)) return;   // 幂等：本地选择重复声明不触发重渲染
        setActiveId(id || null);
        notifyConnectionsChanged();
    };

    /* 当前选中工作区归属的连接 id（断开/探活失败时判断要不要回退选择）。
       优先读 app-workspace 暴露的精确入口（契约补充条款）；壳/模块未升级时
       回退旧语义「有远端选择记忆即视为归属本次被断连接」（保守：多连接下
       可能误清另一台的选择，但仅在 __currentChatWorkspaceScope 缺失窗口期）。 */
    function currentSelectionScope(fallbackId) {
        if (typeof window.__currentChatWorkspaceScope === 'function') {
            try { return window.__currentChatWorkspaceScope(); } catch (e) { return null; }
        }
        return window.__lastRemoteWorkspace ? (fallbackId || activeIdStored) : null;
    }
    window.__GOURD_REMOTE__ = {
        list: connEntries,
        activeId: function () { return activeIdStored; },
        isActive: function (id) { return !!id && id === activeIdStored; },
        get: function (id) {
            var c = id ? connectionsById[id] : null;
            if (!c) return null;
            var e = connEntries().filter(function (x) { return x.connectionId === id; });
            return e.length ? e[0] : null;
        },
        onConnectionsChanged: function (cb) {
            if (typeof cb !== 'function') return function () {};
            connChangeListeners.push(cb);
            return function () {
                var i = connChangeListeners.indexOf(cb);
                if (i >= 0) connChangeListeners.splice(i, 1);
            };
        },
        /* 连接选择器（契约 §2.8/4.4）：list 仅 1 条直返不弹层；多条弹 .remote-conn-pick；
           rid=null = 用户取消。浮层 DOM/CSS 由 app-history 主题子代理提供（契约 §5.5），
           本函数自建 DOM 但只用契约 class，CSS 缺失时仍可用（inline 定位兑底）。 */
        pickConnection: function (cb) {
            var list = connEntries();
            if (!list.length) { cb(null); return; }
            if (list.length === 1) { cb(list[0].connectionId); return; }
            openConnPicker(list, cb);
        }
    };

    /* 连接选择浮层（多条在线时「打开远程目录/登记远程工作区」先选哪台）。
       outside 关闭 handler 存模块变量：点击 item 关闭时不自摘的话，每次开关
       都会在 document 上累积一个僵尸 mousedown 监听（功能上 no-op 但永久泄漏）。 */
    var connPickerAwayHandler = null;
    function openConnPicker(list, cb) {
        closeConnPicker();
        var box = document.createElement('div');
        box.className = 'remote-conn-pick';
        box.id = 'remoteConnPick';
        var html = '<div class="rcp-title">' + esc(GourdI18n.t('remote.pick_connection')) + '</div>';
        for (var i = 0; i < list.length; i++) {
            html += '<button type="button" class="rcp-item" data-rid="' + esc(list[i].connectionId) + '">'
                + '<span class="rbm-state-dot" data-state="' + esc(list[i].state === 'connected' ? 'connected' : 'down') + '"></span>'
                + '<span class="rcp-label">' + esc(list[i].label) + '</span></button>';
        }
        html += '<button type="button" class="rcp-item rcp-cancel" data-rid="">' + esc(GourdI18n.t('common.cancel')) + '</button>';
        box.innerHTML = html;
        /* 定位：视口居中兑底（CSS 段提供时由 CSS 接管） */
        box.style.position = 'fixed';
        box.style.top = '50%';
        box.style.left = '50%';
        box.style.transform = 'translate(-50%, -50%)';
        box.style.zIndex = '9600';
        document.body.appendChild(box);
        box.addEventListener('click', function (e) {
            var t = e.target.closest ? e.target.closest('.rcp-item') : null;
            if (!t) return;
            var rid = t.getAttribute('data-rid') || null;
            closeConnPicker();
            cb(rid);
        });
        connPickerAwayHandler = function (ev) {
            var el = document.getElementById('remoteConnPick');
            if (el && !el.contains(ev.target)) {
                closeConnPicker();
                cb(null);
            }
        };
        setTimeout(function () {
            document.addEventListener('mousedown', connPickerAwayHandler);
        }, 0);
    }
    function closeConnPicker() {
        var el = document.getElementById('remoteConnPick');
        if (el) el.remove();
        /* 关闭时统一摘除 outside handler（所有关闭路径——item 命中/点外部/再次打开——
           都经过本函数，监听零残留） */
        if (connPickerAwayHandler) {
            document.removeEventListener('mousedown', connPickerAwayHandler);
            connPickerAwayHandler = null;
        }
    }

    window.__GOURD_REMOTE_ACTIVE__ = function () { return connEntries().length > 0; };

    /* 当前激活环境的 connectionId（按工作区分流用）：null = 本地。
       启动恢复路径下 activeConnection 由 remoteState 组装，同样带 connectionId；
       本函数只读前端自己那份，不反查路由表（避免为一次选择多一个异步点）。 */
    window.__GOURD_REMOTE_ACTIVE_ID__ = function () {
        return activeIdStored;
    };

    /* ================= 连接流程 ================= */

    function logLine(text) {
        var box = document.getElementById('remoteConnectLog');
        if (!box) return;
        var line = document.createElement('div');
        line.className = 'remote-log-line';
        line.textContent = text;
        box.appendChild(line);
        box.scrollTop = box.scrollHeight;
    }

    /* 通道切换后的“上下文刷新”（仅刷新列表与视图，不动用户选择）。

       为什么改成不动选择：连接 ≠ 切换环境（ZCode 语义，用户 2026-10-07 拍板）。
       连上远端只是「多出一个可选环境」，用户此刻选着的本地工作区/项目继续有效
       ——拉取的列表会合并本地+远端两份，选择落在哪边就按哪边路由。
       若在此处清空选择，用户正在本地工作区里干活的上下文就被连一个远端的动作
       无端打断（正是「远程覆盖本地」投诉的根因之一）。 */
    /* 远端选择记忆统一落在 window.__lastRemoteWorkspace（由 app-workspace.selectChatWorkspace
       维护）：app-remote 关包内变量读不到别的模块，而本模块旧版另写了一个局部
       lastRemoteWorkspace 却从无读取点——只写不读的死变量会误导维护者「断开后还能
       从这里拿回上次选择」。真实状态只有一个入口。 */
       
    function refreshContextForChannel() {
        /* 合并列表重拉（本地+远端两份，选择两边都能看到）；失败静默（列表保持旧值） */
        if (typeof window.notifyProjectsChanged === 'function') {
            try { window.notifyProjectsChanged(); } catch (e) {}
        }
        if (typeof loadSessionHistory === 'function') {
            try { loadSessionHistory(); } catch (e) {}
        }
    }

    function applyConnection(outcome) {
        /* 注册表追加（不再覆盖）：第二台连上时第一台条目保留，
           其工作区/会话/断开入口全部继续可用（方案B 多连接并列）。 */
        var id = outcome.connectionId;
        connectionsById[id] = outcome;
        hostLabelByConnection[id] = hostLabelOf(outcome);
        /* 新连接不抢 active（连接 ≠ 切换环境，ZCode 语义）：activeId 保持原值；
           若原本无 active 且这是第一条连接，仍不自动置位（选中工作区才置位）。 */
        setActiveId(activeIdStored);
        persistActiveIds(Object.keys(connectionsById));
        document.dispatchEvent(new CustomEvent('remote:connected', { detail: outcome }));
        notifyConnectionsChanged();
        /* 【连接 ≠ 切换环境】不再重建长连接、不清选择：
           - WebGate WS 带 ?cwd= 按工作区分流（app-streaming），当前选择未变则
             旧连接的上游本就正确，无需重连；
           - 用户选着的本地工作区继续有效（远程只是多了可选条目）；
           - 选择远端工作区时 selectChatWorkspace 会自行重建 WS 并 bind_scope。 */
        /* 列表双拉合并（本地+远端），选择保留 */
        refreshContextForChannel();
    }

    /* 指纹拒绝识别锚：Rust 侧 ssh.rs KeyRejection::message 的固定开头短语（错误
       串来自 Rust 不经 GourdI18n，识别只能靠常量；两端一致性由
       test/js/remote-forget-host.test.js 锁定）。改动前先同步 ssh.rs。 */
    var KEY_REJECT_MARKER = '主机密钥校验失败';

    /* 指纹拒绝后的「忘记该主机」一键入口：清 known_hosts 该 host:port 全部记录
       （各算法 + 旧两段线），随后用相同参数重连——回到首连自动信任流程。
       仅在错误文案命中指纹拒绝锚时出现；失败（清库失败）时恢复按钮可重试。 */
    function appendForgetHostAction(cfg) {
        var logBox = document.getElementById('remoteConnectLog');
        var ipc = window.__GOURD_IPC__;
        if (!logBox || !ipc || typeof ipc.remoteForgetHost !== 'function') return;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'remote-forget-btn';
        btn.textContent = GourdI18n.t('remote.forget_host_btn');
        btn.addEventListener('click', function () {
            if (btn.disabled) return;
            btn.disabled = true;
            Promise.resolve(ipc.remoteForgetHost(cfg.host, cfg.port || 22)).then(function () {
                /* 清库成功 → 相同参数重连（doConnect 会重置日志区与按钮） */
                doConnect(cfg);
            }, function (e) {
                btn.disabled = false;
                logLine(GourdI18n.t('remote.forget_failed') + ((e && e.message) ? e.message : String(e)));
            });
        });
        var row = document.createElement('div');
        row.className = 'remote-forget-row';
        row.appendChild(btn);
        logBox.appendChild(row);
        logBox.scrollTop = logBox.scrollHeight;
    }

    function doConnect(cfg) {
        if (connecting) {
            /* 连接流程保持串行（向导单实例、日志区单实例），但拒绝必须可感知：
               第一台还在连接中（部署链可达数十秒）时再点「连接」被静默吞掉，
               用户会以为按钮坏了——这正是「随意连多台」诉求下最精糕的反馈形态。 */
            if (typeof showToast === 'function') showToast(GourdI18n.t('remote.connect_in_progress'), 'info');
            return;
        }
        var ipc = window.__GOURD_IPC__;
        if (!ipc || typeof ipc.remoteConnect !== 'function') {
            if (typeof showToast === 'function') showToast(GourdI18n.t('remote.unsupported'), 'error');
            return;
        }
        connecting = true;
        var logBox = document.getElementById('remoteConnectLog');
        if (logBox) logBox.innerHTML = '';
        var isWsl = cfg.channel === 'wsl';
        logLine(isWsl
            ? GourdI18n.t('remote.connecting_wsl', { distro: cfg.host, user: cfg.user })
            : GourdI18n.t('remote.connecting_to', { host: cfg.host, port: cfg.port || 22 }));
        logLine('──────────────────────────────');
        ipc.remoteConnect(cfg).then(function (outcome) {
            connecting = false;
            connectingId = null;
            logLine('──────────────────────────────');
            logLine(GourdI18n.t('remote.connected_ok'));
            /* 保存非敏感字段供下次快选 */
            var hosts = savedHosts().filter(function (h) {
                return !(h.channel === (cfg.channel || 'ssh') && h.host === cfg.host && h.port === (cfg.port || 22) && h.user === cfg.user);
            });
            hosts.unshift({
                channel: cfg.channel || 'ssh',
                host: cfg.host, port: cfg.port || 22, user: cfg.user,
                authType: cfg.authType || 'password', keyPath: cfg.keyPath || ''
            });
            saveHosts(hosts.slice(0, 8));
            applyConnection(outcome);
            closeWizard();
        }, function (err) {
            connecting = false;
            connectingId = null;
            logLine('──────────────────────────────');
            logLine(GourdI18n.t('remote.connect_failed'));
            var msg = (err && err.message) ? err.message : String(err);
            logLine(msg);
            /* 主机密钥校验失败（服务器换钥/中间人防御拒绝）：给出「忘记该主机」
               入口（wsl 通道无主机密钥校验，不会出现该错误形态） */
            if (cfg && cfg.channel !== 'wsl' && String(msg).indexOf(KEY_REJECT_MARKER) >= 0) {
                appendForgetHostAction(cfg);
            }
        });
    }

    function doDisconnect(id) {
        /* 参数化（契约 §2.7）：默认断 active（兼容旧调用点无参形态） */
        var target = id || activeIdStored || (function () {
            var ks = Object.keys(connectionsById);
            return ks.length ? ks[ks.length - 1] : null;
        })();
        if (!target || !connectionsById[target]) return;
        var ipc = window.__GOURD_IPC__;
        if (ipc && typeof ipc.remoteDisconnect === 'function') {
            /* releaseAll=true：UI「断开」的语义是「断开这台主机」。同一台远端开多个
               工作区时引用计数会 >1（connect 里复用 +1），只减 1 的话远端后端仍常驻，
               而徽标已消失——用户既无提示也无入口重试，只能重启应用才能收尾远端进程。 */
            Promise.resolve(ipc.remoteDisconnect(target, true))['catch'](function (e) {
                console.warn('[remote] disconnect failed', e);
            });
        }
        delete connectionsById[target];
        delete hostLabelByConnection[target];
        clearReconnectFor(target);
        if (activeIdStored === target) setActiveId(null);
        else setActiveId(activeIdStored);
        persistActiveIds(Object.keys(connectionsById));
        document.dispatchEvent(new CustomEvent('remote:disconnected', { detail: { connectionId: target } }));
        /* 断开：若用户此刻选着的工作区归属这台连接，则该选择已不可用（远端目录不可达）——
           回退到空选择（全局区，走本地），并把长连接重建到本地；选的是本地或另一台，
           什么都不动（那些环境从未变化，这正是并存语义）。
           【codereview 2026-10-09 P2】旧判定 `!!(x !== null && x !== undefined)`
           是恒真式（undefined !== null 为 true）：选本地工作区时断开也会误清
           用户选择并重建 WS。与 onRemoteState 同口径用 truthy 判定。
           【方案B】归属判定改为「选中工作区的 _scope === 被断 id」，不再用
           「有远端选择记忆就清」——多连接下选着 A 的工作区时断 B 不得误清 A。 */
        var selectedScope = currentSelectionScope(id);
        var selectedRemote = !!selectedScope && selectedScope === target;
        if (selectedRemote && typeof window.applyChatWorkspace === 'function') {
            try { window.applyChatWorkspace('', true); } catch (e) {}
            window.__lastRemoteWorkspace = null;
        }
        if (selectedRemote) {
            /* 只有归属被断连接的远端选择才需要重建：WS 的 ?cwd=/__scope 指向该隧道；
               另一台连接的 WS（per-scope 池）不受影响，由 connections-changed 事件自行回收。 */
            if (typeof window.connectWebGate === 'function') {
                try { window.connectWebGate(); } catch (e) {}
            }
            /* code 模式选中远端项目时同样需要复位（文件树/已开文件指向远端磁盘）；
               参数化：只复位归属该连接的项目（契约 §4.5，子代理W 实现签名） */
            if (typeof window.resetCodeProjectForChannel === 'function') {
                try { window.resetCodeProjectForChannel(target); } catch (e) {}
            }
        }
        /* 列表重拉（该连接的远端条目随连接销毁而消失；其它连接条目保留） */
        refreshContextForChannel();
    }

    /* ================= WSL 发行版拉取（P2） ================= */

    function loadWslDistros(cb) {
        if (wslDistros !== null) { cb(wslDistros); return; }
        var ipc = window.__GOURD_IPC__;
        if (!ipc || typeof ipc.remoteWslList !== 'function') { wslDistros = []; cb(wslDistros); return; }
        ipc.remoteWslList().then(function (list) {
            wslDistros = Array.isArray(list) ? list : [];
            cb(wslDistros);
        }, function () {
            wslDistros = [];
            cb(wslDistros);
        });
    }

    /* Docker Desktop 的内部 WSL 发行版（docker-desktop / docker-desktop-data）：
       musl + busybox ash、无 bash、无 java、ephemeral（重启即重置），官方定位
       "not intended to be run by users"——连上必然失败（ash 解析、glibc 门禁、
       部署物重启即丢），在下拉里直接不出现，避免用户误选后撞墙。 */
    function isInternalWslDistro(name) {
        return /^docker-desktop(-data)?$/i.test(String(name || '').trim());
    }

    /* ================= 向导 UI ================= */

    function wizardEl() { return document.getElementById('remoteWizard'); }

    /* 「点背景关闭」判据（纯函数，可脱离 DOM 单测）：按下点必须就是遮罩本体。
       绝不能用 target.closest('.remote-wizard-backdrop')——closest 是沿祖先链上溯，
       而遮罩正是面板 .remote-wizard-panel 的祖先：面板里每个元素（输入框、勾选框、
       跳板机开关、私钥 tab、连接按钮）都会命中它，点哪都等于「点了背景」，
       整个向导当场消失。 */
    function isWizardMaskHit(target, backdrop) {
        return !!target && !!backdrop && target === backdrop;
    }

    function closeWizard() {
        var el = wizardEl();
        if (el) el.classList.remove('open');
    }

    function openWizard() {
        var el = wizardEl();
        if (!el) return;
        el.classList.add('open');
        renderWizard();
    }

    function channelTabLabel(key) {
        if (key === 'wsl') return GourdI18n.t('remote.channel_wsl');
        if (key === 'preinstalled') return GourdI18n.t('remote.channel_preinstalled');
        return GourdI18n.t('remote.channel_ssh');
    }

    /* ===== layui select 托管（WSL 发行版下拉，与定时任务「推送通道」同范式） =====
       原生 <select> 的展开面板由系统绘制（暗色下灰底系统菜单），与全站自绘面板不统一；
       layui 面板样式已由 settings.css「全局 layui 组件主题适配」明暗两套接管。
       三件事：包层 .layui-form + lay-filter、每次改 option 后 form.render('select')、
       选中值镜像 pendingDistro（layui 隐藏原生 select 后 .value 读取不可靠）。 */
    function renderDistroSelect() {
        if (typeof layui === 'undefined' || !layui.form) return;
        layui.form.render('select', 'remoteDistroForm');
    }

    function bindDistroSelectOnce() {
        if (bindDistroSelectOnce.bound) return;
        if (typeof layui === 'undefined' || !layui.form) return;
        bindDistroSelectOnce.bound = true;
        /* 面板 DOM 每次 renderWizard 重建，但 layui.form.on 按 filter 名全局注册，
           重复 bind 会叠加回调——与 app-automation.js 的 layuiFormBound 同一纪律。 */
        layui.form.on('select(remoteDistro)', function (data) {
            pendingDistro = data.value || '';
        });
    }

    /* 已保存主机回填用：等异步填充落地后选中指定发行版（layui 面板随 render 同步刷新） */
    function pickDistroWhenReady(name) {
        var sel = document.getElementById('remoteDistro');
        if (!sel) return;
        var trySelect = setInterval(function () {
            if (!sel.isConnected) { clearInterval(trySelect); return; }
            if (sel.options.length > 0 && sel.options[0].value) {
                sel.value = name;
                pendingDistro = name;
                renderDistroSelect();
                clearInterval(trySelect);
            }
        }, 100);
        setTimeout(function () { clearInterval(trySelect); }, 5000);
    }

    function renderWizard() {
        var hosts = savedHosts();
        var hostHtml = '';
        for (var i = 0; i < hosts.length; i++) {
            var h = hosts[i];
            var ch = effectiveChannel(h);
            var nameText = ch === 'wsl'
                ? (GourdI18n.t('remote.channel_wsl') + ' · ' + h.user + '@' + h.host)
                : (h.user + '@' + h.host + (ch === 'preinstalled' ? ' · ' + GourdI18n.t('remote.channel_preinstalled') : ''));
            var metaText = ch === 'wsl'
                ? GourdI18n.t('remote.channel_wsl')
                : (':' + (h.port || 22) + ' · ' + (h.authType === 'key' ? GourdI18n.t('remote.auth_key') : GourdI18n.t('remote.auth_password')));
            hostHtml += '<div class="remote-host-item" data-i="' + i + '">'
                + '<div class="remote-host-info"><div class="remote-host-name">' + esc(nameText) + '</div>'
                + '<div class="remote-host-meta">' + esc(metaText) + '</div></div>'
                + '<button class="remote-host-remove" data-i="' + i + '" title="' + esc(GourdI18n.t('remote.remove_host')) + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
                + '</div>';
        }
        if (!hostHtml) hostHtml = '<div class="remote-host-empty">' + esc(GourdI18n.t('remote.no_saved_hosts')) + '</div>';

        var el = wizardEl();
        if (!el) return;

        /* 宿主判定（WSL 通道可见性）分两层：
           1) 桌面壳（Tauri/Electron）经 electronAPI.platform 精确判定；
           2) 无桌面壳（浏览器直开，开发调试常见）时用 UA 兜底 Windows——
              否则 Windows 浏览器里 WSL tab 会静默消失（用户实测反馈
              「怎么 wsl 都没有入口」，排查确认为此闸门误伤）。
           macOS/Linux 的桌面壳与浏览器都判 false（WSL 通道只存在于 Windows 宿主）。 */
        var desktopShell = window.__GOURD_IPC__;
        var hasDesktop = !!(desktopShell && typeof desktopShell.remoteConnect === 'function');
        var isWinHost = (window.electronAPI && window.electronAPI.platform === 'win32')
            || (!window.electronAPI && /Windows/i.test(navigator.userAgent || ''));
        var tabsHtml = '<div class="remote-channel-switch">'
            + '<button type="button" class="remote-channel-tab' + (wizardChannel === 'ssh' ? ' active' : '') + '" data-ch="ssh">' + esc(channelTabLabel('ssh')) + '</button>'
            + (isWinHost ? '<button type="button" class="remote-channel-tab' + (wizardChannel === 'wsl' ? ' active' : '') + '" data-ch="wsl">' + esc(channelTabLabel('wsl')) + '</button>' : '')
            /* CLI 预装 tab 受开关屏蔽（见 PREINSTALLED_CHANNEL_ENABLED）：
               屏蔽期不渲染，向导只剩 ssh(+wsl)。 */
            + (PREINSTALLED_CHANNEL_ENABLED
                ? '<button type="button" class="remote-channel-tab' + (wizardChannel === 'preinstalled' ? ' active' : '') + '" data-ch="preinstalled">' + esc(channelTabLabel('preinstalled')) + '</button>'
                : '')
            + '</div>'
            /* 无桌面能力（浏览器直开）时给一行明确说明：不是漏了 WSL 入口，
               而是当前环境无法建立任何远程连接（remoteConnect 经桌面壳 IPC 调用）。 */
            + (hasDesktop ? '' : '<div class="remote-form-row remote-wsl-hint remote-need-desktop">' + esc(GourdI18n.t('remote.unsupported')) + '</div>');

        var bodyHtml = '';
        if (wizardChannel === 'wsl') {
            /* WSL 通道：distro 下拉 + 用户名（无主机地址/端口/认证——本机通道） */
            bodyHtml =
                '<div class="remote-form-row"><div class="layui-form remote-select-wrap" lay-filter="remoteDistroForm"><select id="remoteDistro" lay-filter="remoteDistro"></select></div></div>'
                + '<div class="remote-form-row"><input type="text" id="remoteUser" placeholder="' + esc(GourdI18n.t('remote.wsl_user_placeholder')) + '" autocomplete="off" /></div>'
                + '<div class="remote-form-row remote-wsl-hint">' + esc(GourdI18n.t('remote.wsl_hint')) + '</div>'
                + '<button class="remote-connect-btn" id="remoteConnectBtn">' + esc(GourdI18n.t('remote.connect_btn')) + '</button>';
        } else {
            var preHint = wizardChannel === 'preinstalled'
                ? '<div class="remote-form-row remote-wsl-hint">' + esc(GourdI18n.t('remote.preinstalled_hint')) + '</div>'
                : '';
            bodyHtml =
                '<div class="remote-form-row"><input type="text" id="remoteHost" placeholder="' + esc(GourdI18n.t('remote.host_placeholder')) + '" autocomplete="off" spellcheck="false" /></div>'
                + '<div class="remote-form-row remote-form-grid2">'
                + '<input type="text" id="remoteUser" placeholder="' + esc(GourdI18n.t('remote.user_placeholder')) + '" autocomplete="off" />'
                + '<input type="text" id="remotePort" placeholder="22" autocomplete="off" />'
                + '</div>'
                + preHint
                + '<div class="remote-form-row">'
                + '<div class="remote-auth-switch">'
                + '<button type="button" class="remote-auth-tab active" data-auth="password">' + esc(GourdI18n.t('remote.auth_password')) + '</button>'
                + '<button type="button" class="remote-auth-tab" data-auth="key">' + esc(GourdI18n.t('remote.auth_key')) + '</button>'
                + '</div></div>'
                + '<div class="remote-form-row" id="remotePasswordRow"><input type="password" id="remotePassword" placeholder="' + esc(GourdI18n.t('remote.password_placeholder')) + '" autocomplete="new-password" /></div>'
                + '<div class="remote-form-row remote-remember-row" id="remoteRememberRow"><label class="remote-remember"><input type="checkbox" id="remoteRemember" /> <span>' + esc(GourdI18n.t('remote.remember_secret')) + '</span></label></div>'
                /* 离线运行时包（可选，离线/内网改造一期 L3b）：内网/气隙远端无 Java 时
                   优先上传该本地 tar.gz；留空则用安装包内置运行时（L1），再缺回退
                   远端自装（L4）。与私钥浏览同款 pickFile 接线，非桌面环境静默降级手填。 */
                /* 视觉形态（2026-10-08 用户反馈「好丑」后重排）：输入框与浏览按钮
                   并排成组（与「用户名+端口」同款 grid 语言），说明文字降级为
                   11px 次要色 hint；整行是「可选」能力，用 .remote-optional-row
                   减权（次要色 placeholder + 更淡 hint），不再与必填输入框同权重
                   抢视觉。旧形态是按钮独占一行 + 说明与输入同字号，三行堆叠。 */
                + '<div class="remote-form-row remote-optional-row" id="remoteRuntimeRow">'
                + '<div class="remote-file-row">'
                + '<input type="text" id="remoteRuntimePkg" placeholder="' + esc(GourdI18n.t('remote.runtime_pkg_label')) + '" autocomplete="off" spellcheck="false" />'
                + '<button type="button" class="remote-key-browse" id="remoteRuntimeBrowse">' + esc(GourdI18n.t('remote.browse')) + '</button>'
                + '</div>'
                + '<div class="remote-optional-hint">' + esc(GourdI18n.t('remote.runtime_pkg_hint')) + '</div>'
                + '</div>'
                + '<div class="remote-form-row"><button type="button" class="remote-jump-toggle" id="remoteJumpToggle">' + esc(GourdI18n.t('remote.jump_add')) + '</button></div>'
                + '<div class="remote-form-row remote-jump-box" id="remoteJumpBox" style="display:none">'
                + '<div class="remote-jump-title">' + esc(GourdI18n.t('remote.jump_title')) + '</div>'
                + '<input type="text" id="remoteJumpHost" placeholder="' + esc(GourdI18n.t('remote.jump_host_placeholder')) + '" autocomplete="off" spellcheck="false" />'
                + '<div class="remote-form-grid2">'
                + '<input type="text" id="remoteJumpUser" placeholder="' + esc(GourdI18n.t('remote.user_placeholder')) + '" autocomplete="off" />'
                + '<input type="text" id="remoteJumpPort" placeholder="22" autocomplete="off" />'
                + '</div>'
                + '<input type="password" id="remoteJumpPassword" placeholder="' + esc(GourdI18n.t('remote.jump_password_placeholder')) + '" autocomplete="new-password" />'
                + '</div>'
                + '<div class="remote-form-row" id="remoteKeyRow" style="display:none">'
                + '<div class="remote-file-row">'
                + '<input type="text" id="remoteKeyPath" placeholder="' + esc(GourdI18n.t('remote.keypath_placeholder')) + '" autocomplete="off" spellcheck="false" />'
                + '<button type="button" class="remote-key-browse" id="remoteKeyBrowse">' + esc(GourdI18n.t('remote.browse')) + '</button>'
                + '</div>'
                + '<input type="password" id="remotePassphrase" placeholder="' + esc(GourdI18n.t('remote.passphrase_placeholder')) + '" autocomplete="new-password" style="margin-top:6px" />'
                + '</div>'
                + '<button class="remote-connect-btn" id="remoteConnectBtn">' + esc(GourdI18n.t('remote.connect_btn')) + '</button>';
        }

        el.innerHTML =
            '<div class="remote-wizard-panel">'
            + '<div class="remote-wizard-head"><span>' + esc(GourdI18n.t('remote.title')) + '</span>'
            + '<button class="remote-wizard-close" title="' + esc(GourdI18n.t('app.close')) + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>'
            + '<div class="remote-wizard-body">'
            + (hostHtml ? '<div class="remote-section-label">' + esc(GourdI18n.t('remote.saved_hosts')) + '</div><div class="remote-host-list">' + hostHtml + '</div>' : '')
            + '<div class="remote-section-label">' + esc(GourdI18n.t('remote.new_connection')) + '</div>'
            + tabsHtml
            + '<div id="remoteChannelBody">' + bodyHtml + '</div>'
            + '</div>'
            + '<div class="remote-connect-log" id="remoteConnectLog" style="display:none"></div>'
            + '</div>';

        /* 通道切换 */
        el.querySelectorAll('.remote-channel-tab').forEach(function (tab) {
            tab.addEventListener('click', function () {
                wizardChannel = tab.getAttribute('data-ch');
                renderWizard();
            });
        });

        /* WSL distro 下拉填充（layui select 托管：改 option 后必须 renderDistroSelect 刷新面板） */
        if (wizardChannel === 'wsl') {
            bindDistroSelectOnce();
            var sel = el.querySelector('#remoteDistro');
            /* 无桌面能力（浏览器直开）时不能显示「正在获取…」——查询根本没发出，
               随后的「未发现发行版」文案会把「环境不支持」误导成「机器没装 WSL」。 */
            if (sel && !hasDesktop) {
                sel.innerHTML = '<option value="">' + esc(GourdI18n.t('remote.unsupported')) + '</option>';
                pendingDistro = '';
                renderDistroSelect();
            } else if (sel) {
                sel.innerHTML = '<option value="">' + esc(GourdI18n.t('remote.wsl_loading')) + '</option>';
                pendingDistro = '';
                renderDistroSelect();
                loadWslDistros(function (list) {
                    if (!sel.isConnected) return; // 向导已关/已重渲染
                    if (!list.length) {
                        sel.innerHTML = '<option value="">' + esc(GourdI18n.t('remote.wsl_none')) + '</option>';
                        pendingDistro = '';
                        renderDistroSelect();
                        return;
                    }
                    var html = '';
                    var firstUsable = '';
                    for (var k = 0; k < list.length; k++) {
                        var d = list[k];
                        /* 只放行 WSL2（version=2）：WSL1 无 localhostForwarding，数据面不通（方案 P2 边界） */
                        if (d.version !== 2) continue;
                        /* Docker Desktop 内部发行版不可用作远程工作区（见 isInternalWslDistro） */
                        if (isInternalWslDistro(d.name)) continue;
                        if (!firstUsable) firstUsable = d.name;
                        html += '<option value="' + esc(d.name) + '"' + (d.default ? ' selected' : '') + '>'
                            + esc(d.name) + ' · WSL2</option>';
                    }
                    sel.innerHTML = html || ('<option value="">' + esc(GourdI18n.t('remote.wsl_none_v2')) + '</option>');
                    /* P4：注册表探测到默认用户（root）则预填；普通用户无规律仍手填 */
                    var usable = list.filter(function (d) { return d.version === 2 && !isInternalWslDistro(d.name); });
                    var picked = usable.filter(function (d) { return d.default; })[0] || usable[0];
                    pendingDistro = picked ? picked.name : '';
                    renderDistroSelect();
                    if (picked && picked.defaultUser) {
                        var userEl = document.getElementById('remoteUser');
                        if (userEl && !userEl.value) userEl.value = picked.defaultUser;
                        if (picked.defaultUser === 'root' && typeof showToast === 'function') {
                            showToast(GourdI18n.t('remote.wsl_root_warn'), 'info');
                        }
                    }
                });
            }
        }

        /* 跳板机折叠开关（P4 ProxyJump） */
        var jumpToggle = el.querySelector('#remoteJumpToggle');
        if (jumpToggle) {
            jumpToggle.addEventListener('click', function () {
                var box = document.getElementById('remoteJumpBox');
                if (!box) return;
                var open = box.style.display !== 'none';
                box.style.display = open ? 'none' : '';
                jumpToggle.textContent = open ? GourdI18n.t('remote.jump_add') : GourdI18n.t('remote.jump_remove');
            });
        }

        /* 认证方式切换（仅 ssh/preinstalled 有） */
        el.querySelectorAll('.remote-auth-tab').forEach(function (tab) {
            tab.addEventListener('click', function () {
                el.querySelectorAll('.remote-auth-tab').forEach(function (t) { t.classList.remove('active'); });
                tab.classList.add('active');
                var isKey = tab.getAttribute('data-auth') === 'key';
                document.getElementById('remotePasswordRow').style.display = isKey ? 'none' : '';
                document.getElementById('remoteKeyRow').style.display = isKey ? '' : 'none';
            });
        });

        /* 私钥文件选择（P2-A 修复：原来这里只有一句「P1 先手填路径，后续做 pickFile」
           的注释，而按钮已经渲染在界面上——用户点「浏览」什么都不会发生，是死 UI。
           Rust 侧 pick_file 命令已补齐四层注册（命令/桥/build.rs/capabilities），
           非桌面环境（ipc 不可用）静默降级为「依旧手填」，不报错打扰。 */
        var keyBrowse = el.querySelector('#remoteKeyBrowse');
        if (keyBrowse) {
            keyBrowse.addEventListener('click', function () {
                var ipc = window.__GOURD_IPC__;
                if (!ipc || typeof ipc.pickFile !== 'function') return;
                Promise.resolve(ipc.pickFile()).then(function (p) {
                    if (typeof p !== 'string' || !p) return; // 取消：静默
                    var input = document.getElementById('remoteKeyPath');
                    if (input) input.value = p;
                }, function () { /* IPC 异常：静默，用户仍可手填 */ });
            });
        }

        /* 离线运行时包浏览（与私钥同款接线） */
        var rtBrowse = el.querySelector('#remoteRuntimeBrowse');
        if (rtBrowse) {
            rtBrowse.addEventListener('click', function () {
                var ipc = window.__GOURD_IPC__;
                if (!ipc || typeof ipc.pickFile !== 'function') return;
                Promise.resolve(ipc.pickFile()).then(function (p) {
                    if (typeof p !== 'string' || !p) return;
                    var input = document.getElementById('remoteRuntimePkg');
                    if (input) input.value = p;
                }, function () { /* 静默降级手填 */ });
            });
        }

        el.querySelector('.remote-wizard-close').addEventListener('click', closeWizard);
        el.querySelector('#remoteConnectBtn').addEventListener('click', function () {
            if (wizardChannel === 'wsl') {
                var distro = pendingDistro || ((el.querySelector('#remoteDistro') && el.querySelector('#remoteDistro').value) || '').trim();
                var wuser = (document.getElementById('remoteUser').value || '').trim();
                if (!distro || !wuser) {
                    if (typeof showToast === 'function') showToast(GourdI18n.t('remote.host_user_required'), 'error');
                    return;
                }
                document.getElementById('remoteConnectLog').style.display = 'block';
                doConnect({ channel: 'wsl', host: distro, user: wuser });
                return;
            }
            var host = (document.getElementById('remoteHost').value || '').trim();
            var user = (document.getElementById('remoteUser').value || '').trim();
            var portRaw = (document.getElementById('remotePort').value || '').trim();
            if (!host || !user) {
                if (typeof showToast === 'function') showToast(GourdI18n.t('remote.host_user_required'), 'error');
                return;
            }
            var port = /^\d+$/.test(portRaw) ? parseInt(portRaw, 10) : 22;
            var authType = el.querySelector('.remote-auth-tab.active') ? el.querySelector('.remote-auth-tab.active').getAttribute('data-auth') : 'password';
            var rememberBox = document.getElementById('remoteRemember');
            /* 跳板机（展开且填了主机才生效） */
            var jumpBox = document.getElementById('remoteJumpBox');
            var jumpCfg = null;
            if (jumpBox && jumpBox.style.display !== 'none') {
                var jh = (document.getElementById('remoteJumpHost').value || '').trim();
                var ju = (document.getElementById('remoteJumpUser').value || '').trim();
                var jpRaw = (document.getElementById('remoteJumpPort').value || '').trim();
                if (jh) {
                    if (!ju) {
                        if (typeof showToast === 'function') showToast(GourdI18n.t('remote.jump_user_required'), 'error');
                        return;
                    }
                    jumpCfg = {
                        host: jh, user: ju,
                        port: /^\d+$/.test(jpRaw) ? parseInt(jpRaw, 10) : 22,
                        password: (document.getElementById('remoteJumpPassword').value || '')
                    };
                }
            }
            document.getElementById('remoteConnectLog').style.display = 'block';
            doConnect({
                channel: wizardChannel, host: host, user: user, port: port, authType: authType,
                password: authType === 'password' ? (document.getElementById('remotePassword').value || '') : '',
                keyPath: authType === 'key' ? (document.getElementById('remoteKeyPath').value || '').trim() : '',
                passphrase: authType === 'key' ? (document.getElementById('remotePassphrase').value || '') : '',
                rememberSecret: rememberBox ? !!rememberBox.checked : false,
                jumpHost: jumpCfg ? jumpCfg.host : '',
                jumpPort: jumpCfg ? jumpCfg.port : null,
                jumpUser: jumpCfg ? jumpCfg.user : '',
                jumpPassword: jumpCfg ? jumpCfg.password : '',
                runtimePkgPath: (document.getElementById('remoteRuntimePkg') ? (document.getElementById('remoteRuntimePkg').value || '').trim() : '')
            });
        });

        /* 已保存主机快选 */
        el.querySelectorAll('.remote-host-item').forEach(function (item) {
            item.addEventListener('click', function (e) {
                if (e.target.closest('.remote-host-remove')) return;
                var h = savedHosts()[parseInt(item.getAttribute('data-i'), 10)];
                if (!h) return;
                wizardChannel = effectiveChannel(h);
                renderWizard();
                /* 渲染后回填（renderWizard 重建了 DOM） */
                if (wizardChannel === 'wsl') {
                    /* 异步填充完成后再选中（layui 面板随 render 同步刷新） */
                    pickDistroWhenReady(h.host);
                    document.getElementById('remoteUser').value = h.user;
                } else {
                    document.getElementById('remoteHost').value = h.host;
                    document.getElementById('remoteUser').value = h.user;
                    document.getElementById('remotePort').value = h.port || '';
                    if (h.authType === 'key') {
                        var tab = document.querySelector('.remote-auth-tab[data-auth="key"]');
                        if (tab) tab.click();
                        document.getElementById('remoteKeyPath').value = h.keyPath || '';
                    }
                }
            });
        });
        el.querySelectorAll('.remote-host-remove').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var i = parseInt(btn.getAttribute('data-i'), 10);
                var hosts2 = savedHosts();
                hosts2.splice(i, 1);
                saveHosts(hosts2);
                renderWizard();
            });
        });
    }

    /* 连接进度事件（Rust 推送）：方案B 起载荷带 connectionId（契约 §1.3），
       并发连两台时只把属于本次连接流程的行写进日志框（旧版单日志混流）；
       无 id 的旧壳事件回退全收（兼容未升级壳）。 */
    if (window.__GOURD_IPC__ && typeof window.__GOURD_IPC__.onRemoteProgress === 'function') {
        window.__GOURD_IPC__.onRemoteProgress(function (payload) {
            if (!payload || !payload.line) return;
            if (payload.connectionId && connectingId && payload.connectionId !== connectingId) return;
            if (payload.connectionId && !connectingId && connecting) connectingId = payload.connectionId;
            logLine(payload.line);
        });
    }
    /* 探活掉线事件（契约 §2.5）：守卫从「只认 active」改为「注册表内存在该 id」——
       旧版非 active 连接掉线前端完全静默（用户下次请求才拿到 502）。 */
    if (window.__GOURD_IPC__ && typeof window.__GOURD_IPC__.onRemoteState === 'function') {
        window.__GOURD_IPC__.onRemoteState(function (payload) {
            var id = payload && payload.connectionId;
            if (!payload || payload.state !== 'disconnected' || !id) return;
            if (!connectionsById[id]) return;   // 不在注册表（已主动断开/从未连过）→ 忽略
            delete connectionsById[id];
            delete hostLabelByConnection[id];
            if (activeIdStored === id) setActiveId(null);
            persistActiveIds(Object.keys(connectionsById));
            document.dispatchEvent(new CustomEvent('remote:disconnected', { detail: payload }));
            notifyConnectionsChanged();
            /* 探活失败：若用户选着的工作区归属该连接，立即回退空选择（远端目录已不可达，
               继续留在该选择上发消息只会得到一串 502）；重连成功后列表里还能
               再选回来（_scope 缓存仍在，重拉后绑定自愈）。选本地/另一台则不动。 */
            var selScope = currentSelectionScope(id);
            if (selScope === id) {
                if (typeof window.applyChatWorkspace === 'function') {
                    try { window.applyChatWorkspace('', true); } catch (e) {}
                }
                window.__lastRemoteWorkspace = null;
                if (typeof window.connectWebGate === 'function') {
                    try { window.connectWebGate(); } catch (e) {}
                }
            }
            scheduleAutoReconnect(id);
        });
    }

    /* 模型镜像结果提示（P1-B 前端侧）：连接建立后 Rust 自动推镜像，而镜像推送
       发生在向导已关闭之后——当时它只能写 tracing 日志，UI 上完全静默。现在经
       remote-mirror-state 事件回收：成功静默（每次连接都弹“同步成功”是噪声），
       失败必须打扰并指向可排查的位置——徽标菜单里的「同步模型配置」可手动重推。
       【方案B】守卫改为「注册表内存在该 id」：任一在线连接镜像失败都要报，
       否则非 active 连接「远端跑的不是我配的模型」被静默吞掉。*/
    if (window.__GOURD_IPC__ && typeof window.__GOURD_IPC__.onRemoteMirror === 'function') {
        window.__GOURD_IPC__.onRemoteMirror(function (payload) {
            if (!payload || !payload.done) return;
            if (!payload.connectionId || !connectionsById[payload.connectionId]) return;
            if (payload.synced) return;
            /* 用 error 而非 info：「远端跑的不是我配的模型」是会被静默吞掉的重要偏差，
               而 showToast 只实现了 success/error/info 三色（toast-item.warning 无样式），
               本仓约定里 warning 一律走 error 口径。 */
            if (typeof showToast === 'function') {
                showToast(GourdI18n.t('remote.mirror_auto_failed'), 'error');
            }
        });
    }

    /* ================= 断线自动重连（P4，方案B 按 id 分账） =================
       探活失败（SSH 断/远端进程死）→ 每连接独立 3 次指数退避（2s/4s/8s）；
       全部失败转手动（toast 提示，用户点徽标菜单/重开向导）。重连成功后
       远端进程由 connect 链重启、模型镜像自动重推（register_connection 尾段）。
       【方案B】旧版单例退避状态机在两台同时掉线时第二台永不重连
       （`if (reconnectTimer) return`），现改 per-id map。 */

    var reconnectStates = Object.create(null);  // id → {timer, attempt}
    var RECONNECT_MAX = 3;

    function clearReconnectFor(id) {
        var st = reconnectStates[id];
        if (st) {
            if (st.timer) clearTimeout(st.timer);
            delete reconnectStates[id];
        }
    }

    function scheduleAutoReconnect(id) {
        if (!id) return;
        var st = reconnectStates[id] || (reconnectStates[id] = { timer: null, attempt: 0 });
        if (st.timer) return; // 该连接已在退避队列
        if (st.attempt >= RECONNECT_MAX) {
            if (typeof showToast === 'function') {
                showToast(GourdI18n.t('remote.reconnect_giveup'), 'error');
            }
            return;
        }
        var delay = 2000 * Math.pow(2, st.attempt); // 2s → 4s → 8s
        st.attempt++;
        if (typeof showToast === 'function') {
            showToast(GourdI18n.t('remote.reconnecting', { attempt: st.attempt, max: RECONNECT_MAX }), 'info');
        }
        st.timer = setTimeout(function () {
            st.timer = null;
            var ipc = window.__GOURD_IPC__;
            if (!ipc || typeof ipc.remoteReconnect !== 'function') { scheduleAutoReconnect(id); return; }
            /* 带 id 重连（契约 §1.2）：旧壳无参版本回退为「重连最后一台」，
               多连接下可能重错目标——壳升级后自动精确。 */
            var p;
            try { p = ipc.remoteReconnect(id); } catch (e) { p = Promise.reject(e); }
            Promise.resolve(p).then(function (outcome) {
                clearReconnectFor(id);
                applyConnection(outcome);
                if (typeof showToast === 'function') showToast(GourdI18n.t('remote.reconnected'), 'success');
            }, function () {
                scheduleAutoReconnect(id); // 失败 → 继续退避（直至 3 次）
            });
        }, delay);
    }

    /* 手动重连入口（徽标菜单/用户主动）：清空该连接退避计数重新开始 */
    window.remoteManualReconnect = function (id) {
        var target = id || activeIdStored;
        if (target) clearReconnectFor(target);
        var ipc = window.__GOURD_IPC__;
        if (!ipc || typeof ipc.remoteReconnect !== 'function') {
            return Promise.reject(new Error(GourdI18n.t('remote.unsupported')));
        }
        return Promise.resolve(ipc.remoteReconnect(target)).then(function (outcome) {
            applyConnection(outcome);
            return outcome;
        });
    };

    /* 用户主动断开时不自动重连：doDisconnect 本体在摘除注册表前已调
       clearReconnectFor(target)（见其函数体），旧版在此处另包一层 wrap 重复同一调用，
       属纯冗余（wrap 与直接调用不可区分），已删除。 */

    /* ================= 远程状态徽标（P4 补齐 P1 缺口） =================
       P1 只在 app-remote.js 里调 refreshRemoteBadge(o) 却从未定义它（DOM 注入器
       不存在，CSS 类闲置）——徽标从未真正渲染过。本轮补全。

       注入位置（P2-B 修正）：侧栏头部右侧（.sidebar-header-top，就是 logo 行右边
       那个 space-between 的空槽）。为什么不是输入框托盘（composer-tray）：
       1) 托盘只存在于欢迎页，进入对话后（消息视图）徒子都没；
       2) 托盘在 code 模式整体隐藏，而远程连接对 code 模式同样生效；
       3) 侧栏头部是两种模式、两种页面都常驻的 chrome 区，与“当前运行环境”这种
          全局状态的语义对齐。 */

    /* 徽标多连接化（契约 §2.4）：1 条在线 = 现状文案「远程 · label」；
       ≥2 条 = 「远程 · N」+ data-multi，点击展开按连接分组的菜单。
       无参调用 = 按注册表全量重渲染（connections-changed 事件驱动）。 */
    window.refreshRemoteBadge = function (outcome) {
        var old = document.getElementById('remoteStateBadge');
        var list = connEntries();
        if (!list.length) {
            if (old) old.remove();
            return;
        }
        var anchor = document.querySelector('.sidebar-header-top');
        if (!old && !anchor) {
            /* 侧栏头部还没装配（启动早期/片段加载失败）：本次不渲染，不静默失败——
               下一个 remote:connected / 启动恢复会重试。挂 body 上的旧写法就是
               这样“渲染了但看不见”的根因。 */
            return;
        }
        if (!old) {
            old = document.createElement('button');
            old.id = 'remoteStateBadge';
            old.type = 'button';
            old.className = 'remote-badge';
            anchor.appendChild(old);
        }
        var multi = list.length > 1;
        if (multi) old.setAttribute('data-multi', 'true');
        else old.removeAttribute('data-multi');
        var primary = (activeIdStored && connectionsById[activeIdStored]) ? connectionsById[activeIdStored] : connectionsById[list[0].connectionId];
        var host = hostLabelByConnection[primary.connectionId] || hostLabelOf(primary);
        var text;
        if (multi) {
            text = GourdI18n.t('remote.badge') + ' · ' + GourdI18n.t('remote.badge_count', { n: list.length });
        } else {
            text = GourdI18n.t('remote.badge') + ' · ' + host;
        }
        old.innerHTML = '<span class="remote-badge-dot"></span><span class="remote-badge-text"></span>'
            + (multi ? '<span class="remote-badge-count">' + esc(String(list.length)) + '</span>' : '');
        old.querySelector('.remote-badge-text').textContent = text;
        old.title = multi
            ? list.map(function (c) { return c.label; }).join(' / ')
            : GourdI18n.t('remote.badge_title', { host: host });
        if (!old._menuBound) {
            old._menuBound = true;
            old.addEventListener('click', function (e) {
                e.stopPropagation();
                toggleRemoteMenu(old);
            });
        }
    };

    function ensureRemoteMenu() {
        var m = document.getElementById('remoteMenu');
        if (!m) {
            m = document.createElement('div');
            m.id = 'remoteMenu';
            m.className = 'remote-menu';
            document.body.appendChild(m);
        }
        return m;
    }

    var remoteMenuAwayHandler = null;

    function closeRemoteMenu() {
        var m = document.getElementById('remoteMenu');
        if (m) m.remove();
        /* 与 closeConnPicker 同款：菜单所有关闭路径（item 命中/点外部/toggle 再点徽标/
           remote:disconnected 事件）都经过本函数，outside handler 在此统一摘除，
           防止每次开关菜单都在 document 上累积一个僵尸 click 监听。 */
        if (remoteMenuAwayHandler) {
            document.removeEventListener('click', remoteMenuAwayHandler);
            remoteMenuAwayHandler = null;
        }
    }

    /* 菜单按连接分组（契约 §2.4）：每连接一段（状态点 + label + 三动作带 data-conn-id）。
       单连接时退化为旧平铺三按钮形态（视觉零变化，仍带 data-conn-id）。 */
    function toggleRemoteMenu(badge) {
        var existing = document.getElementById('remoteMenu');
        if (existing) { closeRemoteMenu(); return; }
        var list = connEntries();
        if (!list.length) return;
        var m = ensureRemoteMenu();
        var html = '';
        for (var i = 0; i < list.length; i++) {
            var c = list[i];
            var st = (c.state === 'connected') ? 'connected' : 'down';
            if (list.length > 1) {
                html += '<div class="rbm-conn" data-conn-id="' + esc(c.connectionId) + '">'
                    + '<div class="rbm-conn-head"><span class="rbm-state-dot" data-state="' + st + '"></span>'
                    + '<span class="rbm-conn-label">' + esc(c.label) + '</span></div>'
                    + '<div class="rbm-conn-acts">'
                    + menuActsHtml()
                    + '</div></div>';
            } else {
                html += '<div class="rbm-conn" data-conn-id="' + esc(c.connectionId) + '">' + menuActsHtml() + '</div>';
            }
        }
        m.innerHTML = html;
        var rect = badge.getBoundingClientRect();
        m.style.top = (rect.bottom + 6) + 'px';
        m.style.left = Math.max(8, rect.right - 200) + 'px';
        m.addEventListener('click', function (e) {
            var t = e.target.closest('.remote-menu-item');
            if (!t) return;
            var connBox = t.closest('.rbm-conn');
            var cid = connBox ? connBox.getAttribute('data-conn-id') : null;
            closeRemoteMenu();
            var act = t.getAttribute('data-act');
            if (act === 'mirror') {
                window.remoteMirrorSync(cid).then(function (r) {
                    if (typeof showToast === 'function') {
                        showToast(r && r.synced ? GourdI18n.t('remote.mirror_synced') : GourdI18n.t('remote.mirror_sync_failed'), r && r.synced ? 'success' : 'error');
                    }
                });
            } else if (act === 'reconnect') {
                if (typeof showToast === 'function') showToast(GourdI18n.t('remote.reconnecting', { attempt: 1, max: 1 }), 'info');
                window.remoteManualReconnect(cid).then(function () {
                    if (typeof showToast === 'function') showToast(GourdI18n.t('remote.reconnected'), 'success');
                }, function () {
                    if (typeof showToast === 'function') showToast(GourdI18n.t('remote.reconnect_giveup'), 'error');
                });
            } else if (act === 'disconnect') {
                doDisconnect(cid);
            }
        });
        remoteMenuAwayHandler = function onAway(ev) {
            var menu = document.getElementById('remoteMenu');
            if (menu && !menu.contains(ev.target)) {
                closeRemoteMenu();
            }
        };
        setTimeout(function () {
            document.addEventListener('click', remoteMenuAwayHandler);
        }, 0);
    }

    function menuActsHtml() {
        return '<button type="button" class="remote-menu-item" data-act="mirror">' + esc(GourdI18n.t('remote.mirror_sync_menu')) + '</button>'
            + '<button type="button" class="remote-menu-item" data-act="reconnect">' + esc(GourdI18n.t('remote.reconnect_menu')) + '</button>'
            + '<button type="button" class="remote-menu-item remote-menu-danger" data-act="disconnect">' + esc(GourdI18n.t('remote.disconnect_menu')) + '</button>';
    }

    document.addEventListener('remote:disconnected', closeRemoteMenu);

    /* ================= 入口绑定 ================= */

    document.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.closest) return;
        var btn = t.closest('.workspace-remote-btn');
        if (btn) {
            e.stopPropagation();
            openWizard();
            return;
        }
    });

    /* 点遮罩空白关闭：用 mousedown 而非 click，且判据是「按下点 === 遮罩本体」。
       为什么不能用 click：在面板内按下、拖到遮罩上松开（选文字后松手很常见），
       click 的 target 是两次落点的最近共同祖先＝遮罩，照样误关。 */
    document.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        var el = wizardEl();
        if (!el || !el.classList.contains('open')) return;
        if (isWizardMaskHit(e.target, el)) closeWizard();
    });

    /* Esc 关闭（模态浮层通用预期）。输入法组字时 Esc 的语义是取消候选词，
       不能当作关闭——否则在中文输入法里按一下 Esc，向导就没了。 */
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape' || e.isComposing) return;
        var el = wizardEl();
        if (!el || !el.classList.contains('open')) return;
        closeWizard();
    });

    /* 远程状态徽标（chat 头部）：connected 事件后渲染，disconnected 移除 */
    document.addEventListener('remote:connected', function (e) {
        var o = e.detail || {};
        if (typeof showToast === 'function') showToast(GourdI18n.t('remote.connected_ok'), 'success');
        if (typeof window.refreshRemoteBadge === 'function') window.refreshRemoteBadge(o);
    });
    document.addEventListener('remote:disconnected', function () {
        if (typeof window.refreshRemoteBadge === 'function') window.refreshRemoteBadge(null);
    });

    /* 供外部（workspace 按钮）打开向导 */
    window.openRemoteWizard = openWizard;
    window.disconnectRemote = doDisconnect;
    window.remoteActiveOutcome = function () { return activeConnection; };

    /* 启动恢复（P2 修复：LS_ACTIVE 原来只写不读，页面重载后远程态丢失）：
       Rust 侧连接注册表存活于桌面进程（页面重载不影响连接与 REMOTE_OVERRIDE），
       前端用 remoteState 查询上次激活的 connectionId：仍连接则恢复徽标与
       activeConnection；已断开则清掉残留标记（下次重连走向导/退避链）。 */
    /* 旧壳回退链（单 id 查询）：抽出为函数——它不只是「无 remoteList 桥」时的路径，
       还是 remoteList 拿到空列表时的核实步骤（见下方调用点）：ipc_bridge 把
       invoke 失败（旧壳无命令/ACL 未授予）降级成 resolve([])，空列表 ≠ 断言
       「Rust 无连接」；无条件清 LS 会把旧壳用户「连接还活着、页面一刷新远程态全丢」。
       有保存 id 时用 remoteState 核实：新壳真没连接时同样查不到（行为不变）；
       旧壳查得到即恢复。无保存 id 时才清残留。 */
    function tryRestoreViaStateChain(savedIds) {
        var savedId = savedIds && savedIds.length ? savedIds[0] : null;
        if (!savedId) { persistActiveIds([]); return; }
        var ipc = window.__GOURD_IPC__;
        if (!ipc || typeof ipc.remoteState !== 'function') return;
        ipc.remoteState(savedId).then(function (st) {
            if (st && st.state === 'connected') {
                /* 主机展示名用 Rust 回传的真实 host/user（P2-C 修复）：原先取
                    savedHosts()[0]——那是“最近一次连过的主机”，与“当前这条连接”
                    不是同一个概念：用户在 A/B 两台间切换过、或删过列表顶项，
                    徽标就会把活报到错误的主机上（用户靠它判断“我正在哪台机器上干活”，
                    报错误导比不报更糟）。state_of 现在带 host/user，直接取。 */
                connectionsById[savedId] = {
                    connectionId: savedId,
                    host: (st && st.host) || '',
                    user: (st && st.user) || ''
                };
                /* 启动恢复路径同样要登记展示名：否则重载后列表条目的主机名全丢
                    （回落通用文案，多机时用户无法区分条目属于哪台）。 */
                hostLabelByConnection[savedId] = hostLabelOf(connectionsById[savedId]);
                setActiveId(savedId);
                notifyConnectionsChanged();
                refreshContextForChannel();
            } else {
                persistActiveIds([]);
            }
        }, function () {
            /* 查询失败（桌面壳不支持/壳已重启）：清残留，避免误导 */
            persistActiveIds([]);
        });
    }
        
    (function restoreOnBoot() {
        var savedIds = readActiveIds();
        var ipc = window.__GOURD_IPC__;
        if (!ipc || typeof ipc.remoteState !== 'function') return;
        /* 多连接恢复（方案B）：Rust 侧 remote_list 是在线连接的真相源——LS 里
            有但 Rust 没有的 id 丢弃（桌面进程重启后远端后端已销毁）；Rust 有但
            LS 没有的（他端/上次异常退出未落 LS）也补进来，保证注册表完整。 */
        if (typeof ipc.remoteList !== 'function') { tryRestoreViaStateChain(savedIds); return; }
        Promise.resolve(ipc.remoteList()).then(function (list) {
            var alive = (list || []).filter(function (st) { return st && st.state === 'connected'; });
            if (!alive.length) {
                /* 空列表先经 remoteState 核实再决定清 LS（见 tryRestoreViaStateChain
                    注释：ipc_bridge 会把旧壳 invoke 失败降级成空数组，不可当作
                    「无在线连接」的断言直接洗掉 LS） */
                tryRestoreViaStateChain(savedIds);
                return;
            }
            for (var i = 0; i < alive.length; i++) {
                var st = alive[i];
                connectionsById[st.connectionId] = st;
                hostLabelByConnection[st.connectionId] = hostLabelOf(st);
            }
            /* activeId 恢复：LS 数组里仍在线的第一个（保持用户上次选中环境） */
            var restoredActive = null;
            for (var k = 0; k < savedIds.length; k++) {
                if (connectionsById[savedIds[k]]) { restoredActive = savedIds[k]; break; }
            }
            setActiveId(restoredActive);
            persistActiveIds(Object.keys(connectionsById));
            notifyConnectionsChanged();
            /* 【连接 ≠ 切换环境】选择保留：本地持久化的工作区选择此刻仍然有效
                （若选的是远端目录，loadProjects 扇出拉取后能查到它的 _scope 重新绑定；
                若选的是本地，本来就不需要动）。 */
            refreshContextForChannel();
        }, function () {
            tryRestoreViaStateChain(savedIds);
        });
    })();

    /* 手动重推模型镜像（P4 方案 A）：本地改完配置后无需重连。
       入口：远程徽标右键/点击菜单（app-ui.js 渲染处调用）。返回 Promise<{
       synced: boolean, lines: string[] }>；进度行同步走 onRemoteProgress 事件。 */
    window.remoteMirrorSync = function (id) {
        var target = id || activeIdStored;
        var ipc = window.__GOURD_IPC__;
        if (!target || !connectionsById[target] || !ipc || typeof ipc.remoteMirrorSync !== 'function') {
            return Promise.resolve({ synced: false, lines: [GourdI18n.t('remote.mirror_unavailable')] });
        }
        return Promise.resolve(ipc.remoteMirrorSync(target))['catch'](function (e) {
            return { synced: false, lines: [String((e && e.message) || e)] };
        });
    };
})();
