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
            if (ready) return;
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
            ipc.onBackendReady(function () { settle(false); });
            // 失败也放行：让请求真去打后端拿到错误，UI 自行提示，而不是永久挂起
            ipc.onBackendFailed(function () { settle(true); });
            // 主动查询当前状态：防止“后端就绪事件早于本监听器注册”而错过（冷启动竞态）
            if (typeof ipc.getBackendState === 'function') {
                ipc.getBackendState().then(function (state) {
                    if (state === 'ready') settle(false);
                    else if (state === 'failed') settle(true);
                }).catch(function () { /* ignore */ });
            }
            // 兜底超时：与主进程 waitForBackend(60s) 对齐再留些余量，避免壳异常时永久挂起
            setTimeout(function () { settle(false); }, 65000);
        }
    })();

    // 界面片段：按此顺序注入，保证同一挂载点内的源序（chat 的欢迎/对话视图在 code 的编辑器之前）
    var FRAGMENTS = ['/chat.html', '/code.html', '/automation.html', '/skills.html', '/channel.html', '/settings.html', '/model-settings.html', '/memory.html'];

    // 应用脚本加载顺序（与原 web.html 第 1404-1425 行完全一致）
    var APP_SCRIPTS = [
        '/js/app-base.js',
        '/js/message-queue.js',
        '/js/app-ui.js',
        '/js/app-history.js',
        '/js/app-workspace.js',
        '/js/app-message.js',
        '/js/app-streaming.js',
        '/js/app-filer.js',
        '/js/app-monaco.js',
        '/js/app-gitdiff.js',
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

    var bootLoading = document.getElementById('appBootLoading');

    function showBootError() {
        if (bootLoading) bootLoading.classList.add('boot-error');
    }
    function removeBootLoading() {
        if (bootLoading && bootLoading.parentNode) bootLoading.parentNode.removeChild(bootLoading);
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
            if (sel === 'body' && bootLoading && bootLoading.parentNode === document.body) {
                // body 级片段插到启动遮罩之前，保持遮罩在最后、结构整洁
                document.body.insertBefore(content, bootLoading);
            } else {
                target.appendChild(content);
            }
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
       在最后一个脚本 onload 时移除启动遮罩。 */
    function loadAppScripts() {
        var last = null;
        APP_SCRIPTS.forEach(function (src) {
            var s = document.createElement('script');
            s.src = src;
            s.async = false;               // 关键：保证按插入顺序执行
            s.onerror = function () { console.error('[bootstrap] 脚本加载失败：' + src); };
            document.body.appendChild(s);
            last = s;
        });
        if (last) {
            last.addEventListener('load', removeBootLoading);
            // 兜底：即使最后一个脚本 onload 因故未触发，也不永久卡遮罩
            last.addEventListener('error', removeBootLoading);
        } else {
            removeBootLoading();
        }
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
        showBootError();
    });
})();
