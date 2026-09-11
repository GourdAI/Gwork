/* ===== app-bootstrap.js =====
   页面装配器：把 chat.html / code.html / settings.html 三个界面片段注入共享外壳（index.html），
   再按固定顺序动态加载全部 app-*.js。取代原 web.html 底部的内联初始化脚本。

   关键约束：
   - 许多 app-*.js 在“解析期”即抓取 DOM（顶层 getElementById / $('#...')），
     因此所有片段必须在这些脚本执行【之前】注入完成。
   - 应用脚本的加载顺序必须与原 web.html 完全一致（app-base 最先，app-code 最后）。
   - 第三方库（layui/marked/mermaid/highlight/monaco）不依赖应用 DOM，
     已在 index.html 中静态按序加载，这里只负责应用脚本。 */
(function () {
    'use strict';

    // 供 app-message.js / app-streaming.js 使用（原为内联全局 var SSE_ENDPOINT）
    window.SSE_ENDPOINT = '/web/chat/input';

    /* ===== 后端就绪门闸 =====
       桌面端（Electron）：UI 外壳由本地 http 服务器秒开，但后端 jar 冷启动需数秒。
       若解析期就发起 /web/** 请求，会被 UI 服务器代理挂起等待，占满浏览器对同源的
       ~6 个并发连接，连静态的 app-code.js 都下载不下来 → 启动遮罩迟迟不消失。
       为此，所有“启动即拉取”的后端请求统一改用 __whenBackendReady 注册，等主进程经
       IPC 通知后端就绪后再一起发出。浏览器端（无 __GOURD_IPC__）立即执行，行为不变。

       兜底：即使 IPC 未触发（异常/旧壳），也在超时后放行，绝不永久挂起。 */
    (function initBackendReadyGate() {
        var ipc = window.__GOURD_IPC__;
        // 浏览器端：无 IPC，视为“已就绪”，回调立即同步执行
        var ready = !ipc;
        var failed = false;
        var queue = [];

        function flush() {
            var cbs = queue.splice(0);
            for (var i = 0; i < cbs.length; i++) {
                try { cbs[i](); } catch (e) { console.error('[bootstrap] backend-ready 回调异常', e); }
            }
        }
        function settle(isFail) {
            // 已放行过：仍允许 failed → ready 的单向复位（后端重启成功）。
            // 不复位的话，__backendReadyState() 会永久停在 'failed'，
            // 而 app-model-settings.js 据此直接清空供应商列表且不再请求接口——
            // 启动期界面已无任何可见提示，看上去一切正常，
            // 但供应商列表会持续空白直到手动刷新页面。
            if (ready) {
                if (!isFail) failed = false;
                return;
            }
            if (isFail) failed = true;
            ready = true;
            flush();
        }

        window.__backendReadyState = function () {
            return failed ? 'failed' : (ready ? 'ready' : 'pending');
        };
        window.__whenBackendReady = function (cb) {
            if (typeof cb !== 'function') return;
            if (ready) { cb(); return; }
            queue.push(cb);
        };

        if (ipc) {
            ipc.onBackendReady(function () {
                // 后端恢复（如自动/手动重启成功）后收起可能残留的提示条
                hideBootError();
                hideBackendFailBar();
                settle(false);
            });
            // 失败必须放行门闸，否则所有启动期请求要白等满 65s 兜底超时才发出去。
            // 【2026-09-06 决策变更】此前按「无感」要求对失败完全不提示，代价是：
            // 覆盖安装导致后端起不来时，用户只看得到「界面能开、接口一直不通」，
            // 既不知道原因也无从自救（只能猜着去杀进程/重装），故障也无法取证。
            // 现改为右下角非阻塞错误条：说清原因 + 给一个「重试」出口。
            // 依旧不用全屏遮罩：首页照常展示、各模块自行降级，不阻塞任何操作。
            ipc.onBackendFailed(function (data) {
                settle(true);
                console.warn('[bootstrap] 后端启动失败：', data && data.message ? data.message : data);
                showBackendFailure(data);
            });
            // 主动查询当前状态：防止“后端就绪事件早于本监听器注册”而错过（冷启动竞态）
            if (typeof ipc.getBackendState === 'function') {
                ipc.getBackendState().then(function (state) {
                    if (state === 'ready') { settle(false); return; }
                    if (state !== 'failed') return;
                    settle(true);
                    // 事件错过时同样要把原因补上：否则界面只静默降级，没人知道后端已挂
                    if (typeof ipc.getBackendDetail === 'function') {
                        ipc.getBackendDetail().then(function (d) {
                            showBackendFailure(d ? { message: d.lastError, status: d.lastProbe && d.lastProbe.status,
                                probeError: d.lastProbe && d.lastProbe.error, logPath: d.logPath,
                                serverLogPath: d.serverLogPath, autoRetryAttempt: d.autoRetryAttempt,
                                autoRetryMax: d.autoRetryMax, retrying: d.restarting } : null);
                        })['catch'](function () { showBackendFailure(null); });
                    } else {
                        showBackendFailure(null);
                    }
                }).catch(function () { /* ignore */ });
            }
            // 安装一致性告警：后端已可用，但 jar 与本安装包不同源（部分覆盖）
            if (typeof ipc.onInstallMismatch === 'function') {
                ipc.onInstallMismatch(function (data) { showInstallMismatch(data); });
            }
            // 兜底超时：与主进程 waitForBackend(60s) 对齐再留些余量，避免壳异常时永久挂起。
            //
            // 【必须先判 ready·勿简化】settle(false) 兼有「放行门闸」与「failed → ready 复位」两重语义。
            // 若无条件调用，已判定 failed 的会话会在第 65 秒被这条兜底把 failed 洗成 ready：
            // 错误条还挂在页面上，__backendReadyState() 却回答 'ready'，
            // app-model-settings.js 据此照常请求接口并渲染空列表——状态与提示自相矛盾。
            // 这里只负责「仍在 pending 时把门闸放开」，不参与任何状态复位。
            setTimeout(function () { if (!ready) settle(false); }, 65000);
        }
    })();

    // 界面片段：按此顺序注入，保证同一挂载点内的源序（chat 的欢迎/对话视图在 code 的编辑器之前）
    var FRAGMENTS = ['/chat.html', '/code.html', '/automation.html', '/skills.html', '/channel.html', '/usage.html', '/settings.html', '/model-settings.html', '/memory.html'];

    // 应用脚本加载顺序（与原 web.html 第 1404-1425 行完全一致）
    var APP_SCRIPTS = [
        '/js/app-base.js',
        '/js/app-tool-presentation.js',
        '/js/message-queue.js',
        '/js/app-ui.js',
        '/js/model-list-order.js',
        '/js/model-dropdown-ui.js',
        '/js/app-history.js',
        '/js/app-workspace.js',
        '/js/app-message.js',
        '/js/app-filer.js',
        '/js/app-monaco.js',
        '/js/app-gitdiff.js',
        '/js/app-file-changes.js',
        '/js/app-streaming.js',
        '/js/app-todos.js',
        '/js/app-memory.js',
        '/js/app-context.js',
        '/js/app-settings.js',
        '/js/app-settings-general.js',
        '/js/app-settings-permission.js',
        '/js/app-settings-mounts.js',
        '/js/app-settings-mcp.js',
        '/js/app-settings-openapi.js',
        '/js/app-settings-lsp.js',
        '/js/app-model-settings.js',
        '/js/app-skills.js',
        '/js/app-automation.js',
        '/js/app-channel-config.js',
        '/js/app-settings-acp.js',
        '/js/app-settings-about.js',
        '/js/app-settings-usage.js',
        '/js/app-code.js',
        '/js/app-terminal.js'
    ];

    // 欢迎语：从 i18n 语言包 app.welcome_greeting.0~19 读取。
    // ⚠️ 必须延迟到 i18n 就绪后再取值：脚本解析期语言包尚在异步 fetch，
    // 此刻取值会得到 key 字面量。故封装成函数，在 whenReady 回调里调用。
    function pickWelcomeTitle(exclude) {
        var arr = [];
        for (var i = 0; i < 20; i++) {
            var v = GourdI18n.t('app.welcome_greeting.' + i);
            if (v && v.indexOf('app.welcome_greeting') !== 0 && v !== exclude) arr.push(v);
        }
        if (!arr.length) return exclude || '';
        return arr[Math.floor(Math.random() * arr.length)];
    }

    /* 启动期的可见反馈：全屏遮罩已移除（打开即首页）。右下角非阻塞错误条有两个：
       1) 本函数 showBootError —— 界面片段装配失败。此时外壳里一个视图都没有
          （连设置入口都缺），若同样静默就只剩一片空白，比留一条提示更难自证。
       2) showBackendFailure —— 后端未启动（见下方），带原因与「重试」按钮。 */
    var BOOT_ERROR_ID = 'appBootErrorBar';

    function showBootError(detail) {
        var bar = document.getElementById(BOOT_ERROR_ID);
        if (!bar) {
            var msg = (window.GourdI18n && typeof GourdI18n.t === 'function')
                ? GourdI18n.t('app.boot_error')
                : '';
            // i18n 尚未就绪时 t() 会返回 key 字面量，退回中文兼底
            if (!msg || msg === 'app.boot_error') msg = '启动失败';
            bar = document.createElement('div');
            bar.id = BOOT_ERROR_ID;
            // 内联样式：异常路径上不能依赖任何可能尚未就绪的样式表
            bar.setAttribute('style', [
                'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483000',
                'max-width:520px', 'max-height:45vh', 'overflow:auto', 'padding:12px 14px',
                'border-radius:6px', 'background:#b42318', 'color:#fff',
                'font:13px/1.6 -apple-system,Segoe UI,Arial,sans-serif',
                'box-shadow:0 6px 20px rgba(0,0,0,.28)', 'white-space:pre-wrap',
                'word-break:break-all'
            ].join(';'));
            document.body.appendChild(bar);
        }
        // 错误原因（含 extraResources 探测报告）比标题更有价值，换行后优先展示
        var title = bar.getAttribute('data-title') || '';
        if (!title) {
            title = (function () {
                var t = (window.GourdI18n && typeof GourdI18n.t === 'function')
                    ? GourdI18n.t('app.boot_error') : '';
                return (t && t !== 'app.boot_error') ? t : '启动失败';
            })();
            bar.setAttribute('data-title', title);
        }
        bar.textContent = detail ? (title + '\n' + detail) : title;
    }

    function hideBootError() {
        var bar = document.getElementById(BOOT_ERROR_ID);
        if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    }

    /* ===== 后端启动失败提示条（非阻塞、带重试出口）=====
       与 showBootError 的区别：那个只管「片段装配失败」（界面已完全不可用）；
       这个管「后端没起来」——界面能用但接口全挂，必须有可见原因与重试按钮，
       否则用户只能靠任务管理器杀进程猜问题。样式全内联：异常路径上不依赖任何
       可能尚未就绪的样式表。 */
    var BACKEND_FAIL_BAR_ID = 'gworkBackendFailBar';

    function hideBackendFailBar() {
        var bar = document.getElementById(BACKEND_FAIL_BAR_ID);
        if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    }

    function mkEl(tag, text, css) {
        var el = document.createElement(tag);
        if (text != null) el.textContent = text;
        if (css) el.setAttribute('style', css);
        return el;
    }

    function showBackendFailure(data) {
        if (!document.body) { setTimeout(function () { showBackendFailure(data); }, 0); return; }
        var d = data || {};
        var bar = document.getElementById(BACKEND_FAIL_BAR_ID);
        if (!bar) {
            bar = mkEl('div', null, [
                'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483000',
                'max-width:560px', 'max-height:60vh', 'overflow:auto', 'padding:12px 14px',
                'border-radius:6px', 'background:#b42318', 'color:#fff',
                'font:13px/1.6 -apple-system,Segoe UI,Arial,sans-serif',
                'box-shadow:0 6px 20px rgba(0,0,0,.28)'
            ].join(';'));
            bar.id = BACKEND_FAIL_BAR_ID;

            var title = mkEl('div', '后台服务未启动', 'font-weight:600;font-size:14px;margin-bottom:6px;');
            title.className = 'gwork-bf-title';
            var detail = mkEl('div', '', 'white-space:pre-wrap;word-break:break-all;opacity:.95;');
            detail.className = 'gwork-bf-detail';
            var btns = mkEl('div', null, 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;');

            var retry = mkEl('button', '重试', 'padding:4px 12px;border-radius:4px;border:1px solid rgba(255,255,255,.7);' +
                'background:rgba(255,255,255,.14);color:#fff;cursor:pointer;font:inherit;');
            retry.type = 'button';
            retry.className = 'gwork-bf-retry';
            retry.onclick = function () {
                var ipc2 = window.__GOURD_IPC__;
                if (!ipc2 || typeof ipc2.restartBackend !== 'function') {
                    detail.textContent = '当前版本不支持界面内重试，请退出应用后重新启动。';
                    return;
                }
                retry.disabled = true;
                retry.textContent = '重试中…';
                Promise.resolve(ipc2.restartBackend()).then(function (res) {
                    retry.disabled = false;
                    retry.textContent = '重试';
                    // 成功时主进程会广播 backend-ready 自动收起本条；这里只处理失败分支
                    if (res && res.ok) return;
                    if (res && res.skipped) { detail.textContent = '重试已在进行中…'; return; }
                    detail.textContent = ((res && res.error) || '重试失败') + '\n\n若为覆盖安装后出现此问题，'
                        + '通常是旧文件被残留进程占用未能替换：请先从托盘右键退出，确认任务管理器里 '
                        + 'GWork.exe / gourd-ai-tauri.exe / javaw.exe 全部结束后重装。';
                })['catch'](function (e) {
                    retry.disabled = false;
                    retry.textContent = '重试';
                    detail.textContent = '重试调用异常：' + (e && e.message ? e.message : e);
                });
            };

            var close = mkEl('button', '知道了', 'padding:4px 12px;border-radius:4px;border:1px solid transparent;'
                + 'background:transparent;color:#fff;cursor:pointer;font:inherit;opacity:.85;');
            close.type = 'button';
            close.onclick = hideBackendFailBar;

            btns.appendChild(retry);
            btns.appendChild(close);
            bar.appendChild(title);
            bar.appendChild(detail);
            bar.appendChild(btns);
            document.body.appendChild(bar);
        }

        var detailEl = bar.querySelector('.gwork-bf-detail');
        var lines = [];
        lines.push(d.message || '后端启动失败（未获取到具体原因）');
        if (d.status) lines.push('健康检查返回：HTTP ' + d.status);
        else if (d.probeError) lines.push('健康检查失败：' + d.probeError);
        if (d.autoRetryMax) {
            lines.push(d.autoRetryAttempt < d.autoRetryMax
                ? ('自动重试：' + d.autoRetryAttempt + '/' + d.autoRetryMax + (d.retrying ? '（进行中）' : '（等待退避）'))
                : '自动重试已停止（' + d.autoRetryMax + ' 次均失败）');
        }
        if (d.serverLogPath) lines.push('后端日志：' + d.serverLogPath);
        if (d.logPath) lines.push('主进程日志：' + d.logPath);
        if (d.status === 404) {
            lines.push('【诊断】探针返回 404：jar 与前端 UI 版本不一致，典型原因是覆盖安装时旧 jar 被占用未能替换。');
        }
        detailEl.textContent = lines.join('\n');
    }

    /* ===== 安装不一致告警条（黄色，非阻塞）=====
       后端能跑但 jar 与本安装包不同源：典型是覆盖安装时旧 jar 被残留 javaw 占用而
       未被替换（“部分覆盖”）。不提示的话用户只会遇到若干无法解释的行为差异。
       与红色条的区别：这里服务可用水，不给「重试」（重试救不了文件层面的错配），
       只给「知道了」并明说下一步是干净重装。 */
    var MISMATCH_BAR_ID = 'gworkInstallMismatchBar';

    function showInstallMismatch(data) {
        if (!document.body) { setTimeout(function () { showInstallMismatch(data); }, 0); return; }
        var d = data || {};
        var bar = document.getElementById(MISMATCH_BAR_ID);
        if (!bar) {
            bar = mkEl('div', null, [
                'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147482900',
                'max-width:560px', 'max-height:45vh', 'overflow:auto', 'padding:12px 14px',
                'border-radius:6px', 'background:#8a5a00', 'color:#fff',
                'font:13px/1.6 -apple-system,Segoe UI,Arial,sans-serif',
                'box-shadow:0 6px 20px rgba(0,0,0,.28)'
            ].join(';'));
            bar.id = MISMATCH_BAR_ID;

            var title = mkEl('div', '安装不完整：检测到旧版本后端仍在运行', 'font-weight:600;font-size:14px;margin-bottom:6px;');
            var detail = mkEl('div', null, 'white-space:pre-wrap;word-break:break-all;opacity:.95;');
            var btns = mkEl('div', null, 'margin-top:10px;');
            var close = mkEl('button', '知道了', 'padding:4px 12px;border-radius:4px;border:1px solid transparent;'
                + 'background:transparent;color:#fff;cursor:pointer;font:inherit;opacity:.85;');
            close.type = 'button';
            close.onclick = function () {
                var el = document.getElementById(MISMATCH_BAR_ID);
                if (el && el.parentNode) el.parentNode.removeChild(el);
            };
            btns.appendChild(close);
            bar.appendChild(title);
            bar.appendChild(detail);
            bar.appendChild(btns);
            document.body.appendChild(bar);
        }

        var detailEl = bar.children[1];
        var lines = [];
        if (d.reason) lines.push(d.reason);
        lines.push('期望构建: ' + (d.expected || '-'));
        lines.push('实际构建: ' + (d.actual || '<无 buildId>'));
        lines.push('处理办法：从托盘图标右键「退出」（不是点关闭），确认任务管理器里 GWork.exe / '
            + 'gourd-ai-tauri.exe / javaw.exe 已全部结束，再卸载并重装。');
        detailEl.textContent = lines.join('\n');
    }

    /* 把一个片段文件（含一个或多个 <template data-mount="SELECTOR">）注入到对应挂载点。
       直接搬运 <template>.content（DocumentFragment），避免二次序列化；
       配合 FRAGMENTS 的固定顺序即可保证同一挂载点内的源序（末尾追加）。 */
    function injectFragment(htmlText) {
        var holder = document.createElement('div');
        holder.innerHTML = htmlText;
        var tpls = holder.querySelectorAll('template[data-mount]');
        for (var i = 0; i < tpls.length; i++) {
            var sel = tpls[i].getAttribute('data-mount');
            var target = (sel === 'body') ? document.body : document.querySelector(sel);
            if (!target) { console.error('[bootstrap] 挂载点未找到：' + sel); continue; }
            var content = document.importNode(tpls[i].content, true);
            // body 级片段直接追加：FRAGMENTS 按固定顺序逐个注入，appendChild 天然保持源序。
            // （旧实现在此用启动遮罩作为插入锚点以保证「遮罩在最后」，遮罩已移除，锚点就失去了意义）
            target.appendChild(content);
        }
    }

    /* 原 web.html 内联初始化：随机欢迎语 + 拉取元信息 / 通用设置。片段注入后执行。
       欢迎语是纯本地操作，立即执行；两个 /web 拉取延后到后端就绪（桌面端冷启动期间
       不占用连接，浏览器端仍立即执行）。 */
    function runInlineInit() {
        var titleEl = document.getElementById('welcomeTitle');
        if (titleEl) {
            // i18n 就绪后再填欢迎语，避免拿到 key 字面量
            GourdI18n.whenReady(function () {
                titleEl.textContent = pickWelcomeTitle();
                // 每 10 秒轮换欢迎语：淡出→换文→淡入，且避免与当前条重复。
                // 原先无条件常驻：窗口最小化/收入托盘后仍每 10s 唤醒渲染进程。
                // 现改为：不可见时停表，恢复可见时重开；且非欢迎页（元素未布局）直接跳过 DOM 操作。
                var rotateTimer = null;
                function rotateOnce() {
                    if (titleEl.offsetParent === null) return;   // 不在欢迎页（已隐藏），无需换文
                    var next = pickWelcomeTitle(titleEl.textContent);
                    if (!next || next === titleEl.textContent) return;
                    titleEl.classList.add('welcome-rotating');
                    setTimeout(function () {
                        titleEl.textContent = next;
                        titleEl.classList.remove('welcome-rotating');
                    }, 260);
                }
                function startRotate() { if (!rotateTimer) rotateTimer = setInterval(rotateOnce, 10000); }
                function stopRotate() { if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; } }
                document.addEventListener('visibilitychange', function () {
                    if (document.hidden) stopRotate(); else startRotate();
                });
                if (!document.hidden) startRotate();
            });
        }

        window.__whenBackendReady(function () {
            fetch('/web/chat/meta').then(function (r) { return r.json(); }).then(function (res) {
                var meta = (res && res.data) ? res.data : res;
                if (!meta) return;
                window.__appMeta = meta; // 缓存供 chat 工作空间选择器（默认工作区项）复用
                if (meta.workname || meta.workspace) {
                    document.title = GourdI18n.t('app.title') + ' - ' + (meta.workname || '') + ' (' + (meta.workspace || '') + ')';
                }
                var verEl = document.getElementById('appVersionLabel');
                if (verEl && meta.appVersion) verEl.textContent = meta.appVersion;
            }).catch(function () { /* ignore */ });

            fetch('/web/settings/general').then(function (r) { return r.json(); }).then(function (resp) {
                if (resp && resp.code === 200 && resp.data) {
                    window.cliPrintSimplified = resp.data.cliPrintSimplified !== false;
                }
            }).catch(function () { /* ignore */ });
        });
    }

    /* 按序加载应用脚本：动态插入的 <script> 设 async=false 即按插入顺序执行。
       不再需要“最后一个脚本 onload 时移除遮罩”——首页本身已是可见终点。 */
    function loadAppScripts() {
        APP_SCRIPTS.forEach(function (src) {
            var s = document.createElement('script');
            s.src = src;
            s.async = false;               // 关键：保证按插入顺序执行
            s.onerror = function () { console.error('[bootstrap] 脚本加载失败：' + src); };
            document.body.appendChild(s);
        });
    }

    // 并行拉取片段，按 FRAGMENTS 顺序注入，再跑初始化，最后按序加载应用脚本
    Promise.all(FRAGMENTS.map(function (url) {
        return fetch(url).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
            return r.text();
        });
    })).then(function (texts) {
        texts.forEach(injectFragment);   // texts 与 FRAGMENTS 同序
        // 片段注入后确保翻译一遍 DOM（settings.html 等异步注入的元素才能拿到正确语言文本）
        if (window.GourdI18n) GourdI18n.translateDOM();
        runInlineInit();
        loadAppScripts();
    }).catch(function (err) {
        console.error('[bootstrap] 片段装配失败：', err);
        showBootError(err && err.message ? err.message : String(err));
        // 片段没注上去也不能吞掉应用脚本：否则界面完全死锁，连设置入口都打不开。
        // 脚本内部的 getElementById 已有空值防御，先加载再提示比完全不加载可用。 
        loadAppScripts();
    });
})();
