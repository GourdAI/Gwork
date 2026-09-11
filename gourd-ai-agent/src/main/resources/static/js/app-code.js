/* ===== app-code.js ===== */
/* Code 模式控制器：模式切换 + Monaco 编辑器（多标签/保存）+ 项目选择器
   依赖：app-base.js（appMode/currentProjectRoot/newSessionId/getSessionCwd）、
        app-filer.js（window.loadTree/clearFilerTree）、app-history.js（loadSessionHistory 等）
   本文件最后加载，可安全覆盖 window.openFileViewer 等。 */

(function () {
    // ---------- DOM ----------
    var $body = $('body');
    var projName = document.getElementById('projectSelectorName');

    var editorPane = document.getElementById('codeEditorPane');
    var editorEmpty = document.getElementById('codeEditorEmpty');
    var gitEmpty = document.getElementById('codeGitEmpty');
    var editorMainEl = document.getElementById('codeEditorMain');
    // 未选项目时的欢迎面板
    var welcomePane = document.getElementById('codeProjectWelcome');
    var welcomeRecentEl = document.getElementById('codeWelcomeRecent');
    var welcomeOpenBtn = document.getElementById('codeWelcomeOpenBtn');
    var welcomeNewBtn = document.getElementById('codeWelcomeNewBtn');
    var tabbar = document.getElementById('codeEditorTabbar');
    var editorHost = document.getElementById('codeEditorHost');
    var previewHost = document.getElementById('codePreviewHost');

    // ---------- 状态 ----------
    var LS_MODE = 'gourdai-app-mode';
    var LS_PROJECT = 'gourdai-code-project';
    var projects = [];            // [{name, path}]
    var homeDir = '';             // 用户主目录（/web/chat/meta 提供，用于新建项目预填父目录）
    var openFiles = [];           // [{path, name}]
    var activeFilePath = null;
    var editor = null;            // Monaco 编辑器实例（单实例，切换 model）
    var docs = {};                // path -> {model, cleanVer, lang, large, dirty, diskChanged, viewState, contentSub}

    /* 给指定文件的 model 挂内容变更监听（幂等：已挂过则直接返回）。
       disposable 存进 docs[path].contentSub，由 closeFile / 淘汰逻辑统一 dispose。 */
    function attachModelListener(path) {
        var st = docs[path];
        if (!st || !st.model || st.contentSub) return;
        st.contentSub = st.model.onDidChangeContent(function () {
            var cur = docs[path];
            if (!cur || cur.model !== st.model) return;
            markDirty(path, st.model.getAlternativeVersionId() !== cur.cleanVer);
        });
    }
    var LARGE_FILE_LIMIT = 1500000; // 超过约 1.5M 字符的文件降级为纯文本 + 关闭补全，避免卡顿

    // 一次性拉取用户主目录，作为“新建项目”对话框的默认父目录
    // （桌面端等后端就绪再拉，避免冷启动占用连接；浏览器端立即执行）
    __whenBackendReady(function () {
        $.get('/web/chat/meta', function (resp) {
            var meta = (resp && resp.data) ? resp.data : resp;
            if (meta && meta.homeDir) homeDir = meta.homeDir;
        });
    });

    // ---------- Monaco 编辑器初始化 ----------
    function ensureEditor() {
        if (editor) return editor;
        var monaco = window.__monacoGet && window.__monacoGet();
        if (!monaco) return null;   // 尚未加载完成（调用方先经 __monacoLoad 回调进入）
        editor = monaco.editor.create(editorHost, {
            model: null,
            theme: window.__monacoThemeName(),
            fontSize: 13,
            fontFamily: window.__monacoFontFamily,
            lineHeight: 1.6,
            lineNumbers: 'on',
            wordWrap: 'off',
            // 折叠
            folding: true,
            showFoldingControls: 'always',
            // 括号匹配/自动闭合/自动缩进（替代原 matchbrackets/closebrackets addon）
            matchBrackets: 'always',
            autoClosingBrackets: 'always',
            autoClosingQuotes: 'always',
            autoSurround: 'languageDefined',
            autoIndent: 'full',
            formatOnPaste: true,
            bracketPairColorization: { enabled: true },
            tabSize: 4,
            insertSpaces: true,
            detectIndentation: false,
            renderWhitespace: 'selection',
            renderLineHighlight: 'line',
            minimap: { enabled: true, maxColumn: 80 },
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            cursorBlinking: 'blink',
            cursorSmoothCaretAnimation: 'off',
            // 布局自适应（容器 resize 自动重排）
            automaticLayout: true,
            // 滚动条尺寸与全局规范一致（theme.css --scrollbar-size: 12px）；颜色/圆角/最小长度由 code.css 统一覆盖。
            // Monaco 滑块默认铺满整个轨道宽，视觉收窄同样在 code.css 用透明内衬实现
            scrollbar: { useShadows: false, verticalScrollbarSize: 12, horizontalScrollbarSize: 12 },
            wordBasedSuggestions: 'currentDocument',
            quickSuggestions: { other: true, comments: false, strings: false },
            suggest: { showKeywords: true },
            // 大文件性能优化
            largeFileOptimizations: true,
            padding: { top: 6, bottom: 6 }
        });
        // 保存快捷键（Ctrl/Cmd+S）
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function () { saveActive(); });
        // 内容变更：按 model 版本号判断 dirty（多标签下 model 独立，切换不串台）。
        // 注意：监听必须按 model 只挂一次，不能写在 onDidChangeModel 里——那样每次 setModel
        // （每点一次标签页）都会给同一个 model 再叠一个回调且 IDisposable 被丢弃，
        // A→B→A 来回切即无界累积，导致每次击键同步跑 N 遍回调（输入发卡）。
        // 改为在 attachModelListener 中按 docs[path] 登记 disposable，close 时统一释放。
        return editor;
    }

    // 主题切换时同步编辑器主题（监听 body data-theme 变化）
    if (window.MutationObserver) {
        new MutationObserver(function () {
            var monaco = window.__monacoGet && window.__monacoGet();
            if (monaco) monaco.editor.setTheme(window.__monacoThemeName());
        }).observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
    }

    // 文件类型 → Monaco 语言 id（映射表与查询逻辑在 js/app-monaco.js 的 window.__monacoGuessLang，全局共用）
    function guessMonacoLanguage(fileName) {
        if (typeof window.__monacoGuessLang === 'function') return window.__monacoGuessLang(fileName);
        return { langId: 'plaintext', label: '' };
    }

    // ---------- 模式切换 ----------
    function isCode() { return window.appMode === 'code'; }

    function enterCodeMode(opts) {
        if (isCode()) return;
        // Monaco 已改为按需加载（不再在页面加载时预载，约省 30-50MB）：
        // 进入 code 模式即开始异步预热，不阻塞后续布局，打开首个文件时通常已就绪。
        if (typeof window.__monacoLoad === 'function') window.__monacoLoad();
        // 关闭进入前 chat 模式可能残留的文件查看浮层（与 #gitDiffViewer 共用），
        // 否则切到 code 后 body.viewer-open 会连带隐藏编辑器面板、悬留旧浮层。
        if (typeof window.closeDiffViewer === 'function') window.closeDiffViewer();
        window.appMode = 'code';
        try { localStorage.setItem(LS_MODE, 'code'); } catch (e) {}
        $body.addClass('code-mode');
        // 专注模式隐藏主侧栏；项目名/返回/更多操作等入口在文件树面板头部（CSS 控制显隐）
        // code 模式始终使用 chatInput 输入
        window.inChatMode = true;
        if (typeof switchToChatMode === 'function') switchToChatMode();
        // 同步文件视图状态（app-gitdiff.js 初始化时已按 localStorage 设好 window.filerView，
        // 这里确保 body[data-filer-view] 反映之，驱动 CSS 显隐中间编辑器）
        if (!window.filerView) window.filerView = 'files';
        try { document.body.dataset.filerView = window.filerView; } catch (e) {}
        // 先记住上次活动会话：下面的 startFreshSession() 会 forgetActiveSession() 清掉它，
        // 而会话列表是异步加载的、其回调里才调 restoreActiveSession()——若不先存下来，
        // 冷启动进 code 模式就永远恢复不了上次会话（只会停在新草稿）。加载完列表后再写回。
        var savedActive = null;
        try { savedActive = localStorage.getItem('gourdai-active-session'); } catch (e) {}
        // 仅统一前缀（work-）的会话可恢复：若属于当前项目会在列表中命中并恢复；
        // 属于其它根（全局/其它工作空间）则不在此恢复，留在原视图等用户切换
        var savedIsWork = savedActive && savedActive.indexOf('work-') === 0;
        // 先建一个当前模式的空会话，右栏立即可见
        startFreshSession();
        // 立即按当前项目状态刷新中间区（未选项目→欢迎面板），避免异步加载前闪现旧空态
        refreshCenterPane();
        // 恢复上次项目
        var saved = null;
        try { saved = localStorage.getItem(LS_PROJECT); } catch (e) {}
        loadProjects(function () {
            // 入口指定的目标项目根（如侧栏项目行图标），优先打开它
            var bootProj = opts && opts.projectRoot;
            if (bootProj) {
                selectProject(bootProj, true);
            } else if (saved && projects.some(function (p) { return p.path === saved; })) {
                selectProject(saved, true);
            } else if (projects.length > 0) {
                selectProject(projects[0].path, true);
            } else {
                // 无项目：清空树与编辑器，提示选择
                window.currentProjectRoot = '';
                if (typeof window.clearFilerTree === 'function') window.clearFilerTree();
            refreshCenterPane();
                if (projName) projName.textContent = GourdI18n.t('code.select_project');
            }
            // 写回上次活动会话 id，供 loadSessionHistory 响应后的 restoreActiveSession 命中并恢复
            if (savedIsWork && typeof window.rememberActiveSession === 'function') {
                window.rememberActiveSession(savedActive);
            }
            // 若没有可恢复的会话（旧前缀残留或无记录），直接选中列表中第一个（最近的对话）
            if (!savedIsWork) {
                setTimeout(function () {
                    if ((window.chatHistory || []).length > 0 && window.currentChatIndex === -1) {
                        if (typeof selectSession === 'function') selectSession(0);
                    }
                }, 350);
            }
            // 项目根已确定，此时才按所选项目加载 code 会话列表
            // （必须放在 loadProjects 回调内：否则会用空 root 抓到安装目录的全局会话）
            reloadSessionsForMode();
        });
    }

    function exitCodeMode() {
        if (!isCode()) return;
        // 防御性关闭 code 模式下可能打开的记忆弹层：#filerMemoryBtn 以弹层形式打开、不退出 code 模式
        // （见 app-memory.js openMemoryView({overlay:true})），若经其它路径退出专注模式，须先收起弹层，
        // 避免 .memory-overlay 残留类在 chat 视图下产生异常样式。此处对未打开状态为空操作。
        if (typeof window.closeMemoryView === 'function') window.closeMemoryView();
        // 先缓存当前 code 会话 ID，稍后在 startFreshSession 清空 localStorage 后写回
        var codeSessionId = window.SESSION_ID;
        window.appMode = 'chat';
        try { localStorage.setItem(LS_MODE, 'chat'); } catch (e) {}
        $body.removeClass('code-mode');
        window.currentProjectRoot = '';
        // 关闭可能残留的「变更详情」Git 审查浮层：它靠内联 display + body.viewer-open 控制显隐，
        // 不受 body.code-mode CSS 约束，若不显式关闭，切回 chat 后会继续悬留在中间区。
        if (typeof window.closeDiffViewer === 'function') window.closeDiffViewer();
        // 回到 chat：新建 chat 会话 + 刷新 chat 会话列表
        startFreshSession();
        // 在 startFreshSession 之后写回，避免被其内部的 forgetActiveSession 清空
        if (typeof rememberActiveSession === 'function') rememberActiveSession(codeSessionId);
        reloadSessionsForMode();
    }

    // 新建当前模式的空会话（不切欢迎页，code 模式保持右栏对话可见）
    function startFreshSession() {
        if (typeof forgetActiveSession === 'function') forgetActiveSession();
        window.SESSION_ID = window.newSessionId();
        // 继承当前对话的模型/思考档位到新会话（写缓存），必须在 setActiveSession 之前，
        // 否则 code 模式下同样会被 refreshSessionModel 拉后端默认覆盖。
        if (typeof window.inheritSelectionToSession === 'function') window.inheritSelectionToSession(window.SESSION_ID);
        window.currentChatIndex = -1;
        if (typeof deactivateSession === 'function') deactivateSession();
        if (isCode()) {
            window.inChatMode = true;
            if (typeof setActiveSession === 'function') setActiveSession(window.SESSION_ID);
            $(document.getElementById('welcomeView')).hide();
            $(document.getElementById('chatView')).addClass('active');
        } else {
            if (typeof switchToWelcomeMode === 'function') switchToWelcomeMode();
        }
        if (typeof updateHistoryUI === 'function') updateHistoryUI();
    }

    function reloadSessionsForMode() {
        if (typeof loadSessionHistory === 'function') loadSessionHistory();
        // 稍后渲染右栏会话下拉（loadSessionHistory 是异步的，用短延迟拿到最新 chatHistory）
        setTimeout(renderCodeSessions, 300);
    }

    // ---------- Code 模式右栏：会话标签页 + 新建 ----------
    var codeChatTabs = document.getElementById('codeChatTabs');
    var codeChatNewBtn = document.getElementById('codeChatNewBtn');
    var _codeTabsLastHtml = '';    // 差异守卫：流式重渲染时不重写 innerHTML（避免重置横向滚动）
    var _codeTabsLastActive = -1;  // 仅当 active 变化时才 scrollIntoView

    function renderCodeSessions() {
        if (!codeChatTabs) return;
        var hist = window.chatHistory || [];
        var html = '';
        // 标签只显示序号（不再塞入长标题，避免会话一多就挤成一团）；完整标题作为鼠标悬停提示。
        // 序号按会话创建先后：最早的为 1，越新序号越大并排在越靠后（右侧），新建的追加到末尾。
        // chatHistory 是「最新在前」（index 0 = 最新），故倒序遍历，序号 = hist.length - i。
        for (var i = hist.length - 1; i >= 0; i--) {
            var sess = (typeof sessionMap !== 'undefined') ? sessionMap[hist[i].sessionId] : null;
            var streaming = sess && sess.isStreaming;
            var active = (i === window.currentChatIndex);
            var num = hist.length - i;   // 最早的会话序号为 1
            html += '<div class="code-chat-tab' + (active ? ' active' : '') + (streaming ? ' streaming' : '') + '" data-idx="' + i + '" title="' + escAttr(hist[i].label) + '">'
                + (streaming ? '<span class="code-chat-tab-spin"></span>' : '')
                + '<span class="code-chat-tab-label">' + num + '</span>'
                + '<button class="code-chat-tab-close" data-idx="' + i + '" title="' + GourdI18n.t('code.close_session') + '">&times;</button>'
                + '</div>';
        }
        // 新建但未发送的会话（尚未进入 chatHistory）：追加到末尾，用空心点 + 下一个序号标识
        if (window.currentChatIndex === -1) {
            html += '<div class="code-chat-tab active draft" data-idx="-1" title="' + GourdI18n.t('code.new_dialog_unsent') + '">'
                + '<span class="code-chat-tab-dot"></span>'
                + '<span class="code-chat-tab-label">' + (hist.length + 1) + '</span>'
                + '<button class="code-chat-tab-close" data-idx="-1" title="' + GourdI18n.t('code.close') + '">&times;</button>'
                + '</div>';
        }
        if (html !== _codeTabsLastHtml) { codeChatTabs.innerHTML = html; _codeTabsLastHtml = html; }
        renderCodeChatListMenu(hist);
        if (window.currentChatIndex !== _codeTabsLastActive) {
            _codeTabsLastActive = window.currentChatIndex;
            var el = codeChatTabs.querySelector('.code-chat-tab.active');
            if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }
    window.renderCodeSessions = renderCodeSessions;

    var codeChatList = document.getElementById('codeChatList');
    var codeChatListBtn = document.getElementById('codeChatListBtn');
    var codeChatListMenu = document.getElementById('codeChatListMenu');

    // 「所有会话」下拉：列出全部会话的完整标题，一键跳转。会话再多也能一眼定位、直接切换。
    function renderCodeChatListMenu(hist) {
        if (!codeChatListMenu) return;
        hist = hist || (window.chatHistory || []);
        var html = '';
        if (hist.length === 0) {
            html = '<div class="code-chat-list-empty">' + GourdI18n.t('code.no_sessions') + '</div>';
        } else {
            // 与标签一致：序号最早为 1，菜单里按序号升序（最早在上）排列
            for (var i = hist.length - 1; i >= 0; i--) {
                var sess = (typeof sessionMap !== 'undefined') ? sessionMap[hist[i].sessionId] : null;
                var streaming = sess && sess.isStreaming;
                var active = (i === window.currentChatIndex);
                var num = hist.length - i;
                html += '<div class="code-chat-list-item' + (active ? ' active' : '') + '" data-idx="' + i + '">'
                    + '<span class="code-chat-list-item-num">' + num + '</span>'
                    + (hist[i].loop ? '<span class="code-chat-list-item-loop" title="' + escAttr(GourdI18n.t('app.sidebar.loop_mark')) + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>' : '')
                    + '<span class="code-chat-list-item-title">' + escHtml(hist[i].label || (GourdI18n.t('code.session') + ' ' + num)) + '</span>'
                    + (streaming ? '<span class="code-chat-list-item-spin"></span>' : '')
                    + '</div>';
            }
        }
        codeChatListMenu.innerHTML = html;
    }

    if (codeChatListBtn) {
        codeChatListBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            $(codeChatList).toggleClass('open');
        });
    }
    if (codeChatListMenu) {
        codeChatListMenu.addEventListener('click', function (e) {
            var item = e.target.closest('.code-chat-list-item');
            if (!item) return;
            $(codeChatList).removeClass('open');
            var idx = parseInt(item.getAttribute('data-idx'));
            if (idx === window.currentChatIndex) return;
            if (typeof selectSession === 'function') selectSession(idx);
        });
    }
    document.addEventListener('click', function () { $(codeChatList).removeClass('open'); });

    if (codeChatTabs) {
        codeChatTabs.addEventListener('click', function (e) {
            var close = e.target.closest('.code-chat-tab-close');
            if (close) {
                e.stopPropagation();
                var di = parseInt(close.getAttribute('data-idx'));
                if (di === -1) {
                    // 关闭未发送的草稿：有历史则切到最近一个，否则重开一个空草稿
                    if ((window.chatHistory || []).length > 0) {
                        if (typeof selectSession === 'function') selectSession(0);
                    } else {
                        startFreshSession();
                    }
                    renderCodeSessions();
                    return;
                }
                if (typeof deleteSession === 'function') deleteSession(di); // 异步、带 layConfirm；经 updateHistoryUI 重渲染
                return;
            }
            var tab = e.target.closest('.code-chat-tab');
            if (tab) {
                var idx = parseInt(tab.getAttribute('data-idx'));
                if (idx === -1) return; // 草稿标签已激活，无需切换
                if (typeof selectSession === 'function') selectSession(idx); // → updateHistoryUI → renderCodeSessions
            }
        });
    }
    if (codeChatNewBtn) {
        codeChatNewBtn.addEventListener('click', function () {
            startFreshSession();
            renderCodeSessions();
        });
    }

    // ---------- 项目选择器 ----------
    function loadProjects(cb) {
        $.get('/web/chat/projects', function (resp) {
            projects = (resp && resp.data) ? resp.data : [];
            renderWelcomeRecent();
            if (cb) cb();
        }).fail(function () { if (cb) cb(); });
    }


    function selectProject(path, silent) {
        // 切项目会关闭全部打开文件；有未保存改动时先确认，取消则中止切换、保留文件与当前项目。
        // 启动期无打开文件，hasUnsavedFiles() 为假，不会打断自动恢复流程。
        if (path !== window.currentProjectRoot && !confirmDiscardUnsavedIfAny()) return;
        var previous = window.currentProjectRoot;
        window.currentProjectRoot = path;
        // 同步项目相关视图 + 持久化项目根（名称/下拉/文件树/已开文件/Git/终端）
        syncProjectContext(path);
        if (path !== previous) {
            document.dispatchEvent(new CustomEvent('workspace:changed', {
                detail: { mode: 'code', cwd: path, previousCwd: previous }
            }));
        }
        // 刷新 code 会话列表（按该项目）——仅项目选择器主动切项目时需要；
        // 从「会话切换」间接触发时不重载列表（避免把当前历史列表刷掉）。
        if (!silent) reloadSessionsForMode();
    }

    // 把「所选项目」相关的 UI 副作用集中到一处，供 selectProject 与「切换历史会话时恢复项目根」共用。
    // 负责持久化项目根 + 刷新项目相关视图；不写 currentProjectRoot（由各调用方先设好），
    // 也不重载会话列表（避免递归/覆盖当前列表）。
    function syncProjectContext(path) {
        try { localStorage.setItem(LS_PROJECT, path); } catch (e) {}
        var p = null;
        for (var i = 0; i < projects.length; i++) { if (projects[i].path === path) { p = projects[i]; break; } }
        if (projName) projName.textContent = p ? p.name : (path || GourdI18n.t('code.select_project'));
        // 重新加载文件树
        if (typeof window.loadTree === 'function') window.loadTree();
        // 登记后端文件监听根：项目目录的外部修改才能实时推送 filer_change
        notifyWatchRoot(path);
        // 关闭所有已打开文件（切项目后旧文件失效）
        closeAllFiles();
        // 刷新 Git 审查（按所选项目仓库）
        if (typeof window.loadGitStatus === 'function') window.loadGitStatus();
        // 通知终端：项目根变更，若终端开着则重连到新目录
        if (typeof window.onCodeProjectChanged === 'function') window.onCodeProjectChanged();
        // 桌面端：同步窗口标题为当前项目名
        updateWindowTitle(p ? p.name : path);
    }
    // 桌面端窗口标题：显示当前项目名
    function updateWindowTitle(name) {
        var ipc = window.__GOURD_IPC__;
        if (!ipc || typeof ipc.setWindowTitle !== 'function') return;
        var base = GourdI18n.t('app.title');
        ipc.setWindowTitle(name ? (base + ' - ' + name) : base);
    }
    window.syncProjectContext = syncProjectContext;

    // 语言切换时：刷新项目选择器显示名称（有选中项目则显示名称，否则更新翻译后的提示）
    document.addEventListener('i18n:localeChanged', function () {
        if (!projName) return;
        var p = null;
        if (currentProjectRoot) {
            for (var i = 0; i < projects.length; i++) {
                if (projects[i].path === currentProjectRoot) { p = projects[i]; break; }
            }
        }
        projName.textContent = p ? p.name : GourdI18n.t('code.select_project');
    });

    function addProject() {
        var doAdd = function (path) {
            if (!path) return;
            $.ajax({
                url: '/web/chat/projects/add', method: 'POST', contentType: 'application/json',
                data: JSON.stringify({ path: path })
            }).done(function (resp) {
                if (resp && resp.code === 200) {
                    projects = resp.data || [];
                    renderWelcomeRecent();
                    // 新加的项目：直接在本窗口打开
                    if (projects.length) {
                        var addedPath = '';
                        for (var j = 0; j < projects.length; j++) {
                            if (projects[j].path === path) { addedPath = path; break; }
                        }
                        if (!addedPath) addedPath = projects[0].path;
                        if (addedPath !== window.currentProjectRoot) selectProject(addedPath);
                    }
                    if (typeof showToast === 'function') showToast(GourdI18n.t('code.project_added'), 'success');
                } else {
                    if (typeof showToast === 'function') showToast((resp && resp.description) || GourdI18n.t('code.add_failed_no_dir'), 'error');
                }
            }).fail(function () {
                if (typeof showToast === 'function') showToast(GourdI18n.t('code.add_failed'), 'error');
            });
        };
        openDirPicker(doAdd);
    }

    // ---------- 新建项目（在父目录下建一个新目录并登记为项目）----------
    function newProject() {
        var defaultParent = homeDir ? joinPath(homeDir, 'gourdai-projects') : '';
        var html = ''
            + '<div class="new-project-dialog">'
            + '  <div class="new-project-row">'
            + '    <label class="new-project-label">' + GourdI18n.t('code.parent_dir') + '</label>'
            + '    <div class="new-project-parent">'
            + '      <input type="text" class="new-project-input" id="npParent" placeholder="' + GourdI18n.t('code.parent_dir_placeholder') + '" />'
            + '      <button class="new-project-browse" id="npBrowse" title="' + GourdI18n.t('code.browse_dir') + '">'
            + '        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
            + '      </button>'
            + '    </div>'
            + '  </div>'
            + '  <div class="new-project-row">'
            + '    <label class="new-project-label">' + GourdI18n.t('code.project_name') + '</label>'
            + '    <input type="text" class="new-project-input" id="npName" placeholder="Project_name" />'
            + '  </div>'
            + '  <div class="new-project-foot">'
            + '    <button class="btn-secondary" id="npCancel">' + GourdI18n.t('code.cancel') + '</button>'
            + '    <button class="btn-primary" id="npConfirm">' + GourdI18n.t('code.confirm') + '</button>'
            + '  </div>'
            + '</div>';

        var idx = layer.open({
            type: 1, title: GourdI18n.t('code.new_project_title'), area: '460px', skin: 'kd-layer',
            content: html,
            success: function (layero) {
                var $parent = layero.find('#npParent');
                var $name = layero.find('#npName');
                $parent.val(defaultParent);
                setTimeout(function () { $name[0] && $name[0].focus(); }, 0);

                // 浏览父目录（复用服务端目录选择器）
                layero.find('#npBrowse').on('click', function () {
                    openDirPicker(function (picked) { if (picked) $parent.val(picked); });
                });

                function submit() {
                    var parent = $parent.val().trim();
                    var name = $name.val().trim();
                    if (!name) { if (typeof showToast === 'function') showToast(GourdI18n.t('code.please_input_project_name'), 'error'); return; }
                    $.ajax({
                        url: '/web/chat/projects/create', method: 'POST', contentType: 'application/json',
                        data: JSON.stringify({ parent: parent, name: name })
                    }).done(function (resp) {
                        if (resp && resp.code === 200) {
                            layer.close(idx);
                            projects = resp.data || [];
                            renderWelcomeRecent();
                            if (projects.length) selectProject(projects[0].path);
                            if (typeof showToast === 'function') showToast(GourdI18n.t('code.project_created'), 'success');
                        } else {
                            if (typeof showToast === 'function') showToast((resp && resp.description) || GourdI18n.t('code.create_failed'), 'error');
                        }
                    }).fail(function () {
                        if (typeof showToast === 'function') showToast(GourdI18n.t('code.create_failed'), 'error');
                    });
                }

                layero.find('#npConfirm').on('click', submit);
                layero.find('#npCancel').on('click', function () { layer.close(idx); });
                $name.on('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
            }
        });
    }

    // ---------- 服务端目录选择器（浏览器无法直接拿本地绝对路径，改由后端浏览）----------
    function openDirPicker(onPick) {
        var state = { current: '', parent: null, sep: '\\' };

        var html = ''
            + '<div class="dir-picker">'
            + '  <div class="dir-picker-bar">'
            + '    <button class="dir-picker-up" id="dpUp" title="' + GourdI18n.t('code.go_up') + '">'
            + '      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>'
            + '    </button>'
            + '    <input type="text" class="dir-picker-path" id="dpPath" placeholder="' + GourdI18n.t('code.current_dir') + '" />'
            + '    <button class="dir-picker-go" id="dpGo">' + GourdI18n.t('code.go') + '</button>'
            + '  </div>'
            + '  <div class="dir-picker-list" id="dpList"></div>'
            + '  <div class="dir-picker-foot">'
            + '    <span class="dir-picker-hint">' + GourdI18n.t('code.select_dir_hint') + '</span>'
            + '    <div class="dir-picker-actions">'
            + '      <button class="btn-secondary" id="dpCancel">' + GourdI18n.t('code.cancel') + '</button>'
            + '      <button class="btn-primary" id="dpChoose">' + GourdI18n.t('code.select_this_dir') + '</button>'
            + '    </div>'
            + '  </div>'
            + '</div>';

        var idx = layer.open({
            type: 1, title: GourdI18n.t('code.select_project_dir'), area: ['520px', '520px'], skin: 'kd-layer',
            content: html,
            success: function (layero) {
                var $list = layero.find('#dpList');
                var $path = layero.find('#dpPath');

                function browse(p) {
                    $list.html('<div class="dir-picker-loading">' + GourdI18n.t('code.dir_loading') + '</div>');
                    $.get('/web/chat/projects/browse' + (p ? '?path=' + encodeURIComponent(p) : ''), function (resp) {
                        if (!resp || resp.code !== 200) {
                            $list.html('<div class="dir-picker-empty">' + GourdI18n.t('code.dir_access_failed') + '</div>');
                            return;
                        }
                        var d = resp.data || {};
                        state.current = d.current || '';
                        state.parent = d.parent;
                        state.sep = d.separator || '\\';
                        $path.val(state.current);
                        var dirs = d.dirs || [];
                        var h = '';
                        if (dirs.length === 0) {
                            h = '<div class="dir-picker-empty">' + GourdI18n.t('code.no_subdirs') + '</div>';
                        } else {
                            for (var i = 0; i < dirs.length; i++) {
                                h += '<div class="dir-picker-item" data-path="' + escAttr(dirs[i].path) + '">'
                                    + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
                                    + '<span class="dir-picker-item-name">' + escHtml(dirs[i].name) + '</span>'
                                    + '</div>';
                            }
                        }
                        $list.html(h);
                    }).fail(function () {
                        $list.html('<div class="dir-picker-empty">' + GourdI18n.t('code.dir_load_failed') + '</div>');
                    });
                }

                // 进入子目录（单击）
                $list.on('click', '.dir-picker-item', function () {
                    browse($(this).attr('data-path'));
                });
                // 上一级
                layero.find('#dpUp').on('click', function () {
                    browse(state.parent || ''); // parent 为空回到起点（盘符列表）
                });
                // 手动前往
                layero.find('#dpGo').on('click', function () {
                    var v = $path.val().trim();
                    if (v) browse(v);
                });
                $path.on('keydown', function (e) { if (e.key === 'Enter') { var v = $path.val().trim(); if (v) browse(v); } });
                // 选定 / 取消
                layero.find('#dpChoose').on('click', function () {
                    if (!state.current) { if (typeof showToast === 'function') showToast(GourdI18n.t('code.please_enter_dir'), 'error'); return; }
                    layer.close(idx);
                    onPick(state.current);
                });
                layero.find('#dpCancel').on('click', function () { layer.close(idx); });

                browse(''); // 起点
            }
        });
    }

    function removeProject(path) {
        $.ajax({
            url: '/web/chat/projects/remove', method: 'POST', contentType: 'application/json',
            data: JSON.stringify({ path: path })
        }).done(function (resp) {
            projects = (resp && resp.data) ? resp.data : [];
            // 任务侧栏的项目行取自同一列表：移除后刷新任务视图列表
            if (window.appMode !== 'code' && typeof loadSessionHistory === 'function') loadSessionHistory();
            if (path === window.currentProjectRoot) {
                if (projects.length) selectProject(projects[0].path);
                else {
                    window.currentProjectRoot = '';
                if (projName) projName.textContent = GourdI18n.t('code.select_project');
                    if (typeof window.clearFilerTree === 'function') window.clearFilerTree();
                    closeAllFiles();
                }
            }
        });
    }


    // ---------- 编辑器：打开 / 标签 / 保存 ----------
    // 中间区三态：未选项目→欢迎面板；已选项目未开文件→空态提示；开了文件→编辑器
    // Git 审查视图：隐藏上述编辑器三态，改显示审查占位（点变更文件仍走 #gitDiffViewer 浮层）
    function refreshCenterPane() {
        var gitView = isCode() && window.filerView === 'gitdiff';
        if (gitEmpty) gitEmpty.style.display = gitView ? 'flex' : 'none';
        if (gitView) {
            if (welcomePane) welcomePane.style.display = 'none';
            if (editorEmpty) editorEmpty.style.display = 'none';
            if (editorMainEl) editorMainEl.style.display = 'none';
            return;
        }
        var noProject = isCode() && !window.currentProjectRoot;
        var hasOpen = openFiles.length > 0;
        if (welcomePane) welcomePane.style.display = noProject ? 'flex' : 'none';
        if (editorEmpty) editorEmpty.style.display = (!noProject && !hasOpen) ? 'flex' : 'none';
        if (editorMainEl) editorMainEl.style.display = (!noProject && hasOpen) ? 'flex' : 'none';
        if (noProject) renderWelcomeRecent();
    }
    window.refreshCenterPane = refreshCenterPane;

    // 欢迎面板的「最近项目」列表
    function renderWelcomeRecent() {
        if (!welcomeRecentEl) return;
        if (!projects || projects.length === 0) {
            welcomeRecentEl.innerHTML = '<div class="code-welcome-recent-empty">' + GourdI18n.t('code.no_projects_empty') + '</div>';
            return;
        }
        var html = '<div class="code-welcome-recent-title">' + GourdI18n.t('code.recent_projects') + '</div>';
        for (var i = 0; i < projects.length; i++) {
            var p = projects[i];
            html += '<div class="code-welcome-recent-item" data-path="' + escAttr(p.path) + '" title="' + escAttr(p.path) + '">'
                + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
                + '<div class="code-welcome-recent-info">'
                + '<div class="code-welcome-recent-name">' + escHtml(p.name) + '</div>'
                + '<div class="code-welcome-recent-path">' + escHtml(p.path) + '</div>'
                + '</div>'
                + '</div>';
        }
        welcomeRecentEl.innerHTML = html;
    }
    if (welcomeRecentEl) {
        welcomeRecentEl.addEventListener('click', function (e) {
            var item = e.target.closest('.code-welcome-recent-item');
            if (item) {
                var picked = item.getAttribute('data-path');
                if (picked === window.currentProjectRoot) return;
                selectProject(picked);
            }
        });
    }
    if (welcomeOpenBtn) welcomeOpenBtn.addEventListener('click', function () { addProject(); });
    if (welcomeNewBtn) welcomeNewBtn.addEventListener('click', function () { newProject(); });

    // ---------- 专注模式文件树面板头部：返回 / 设置 ----------
    // 返回任务视图：退出专注模式，并把任务侧栏工作空间同步选中为刚才的项目，来回无缝
    var filerBackBtn = document.getElementById('filerBackBtn');
    if (filerBackBtn) {
        filerBackBtn.addEventListener('click', function () {
            var root = window.currentProjectRoot || '';
            exitCodeMode();
            if (root && typeof window.applyChatWorkspace === 'function') window.applyChatWorkspace(root, true);
        });
    }

    // 设置：复用主侧栏设置按钮的既有绑定
    var filerSettingsBtn = document.getElementById('filerSettingsBtn');
    if (filerSettingsBtn) {
        filerSettingsBtn.addEventListener('click', function () { $('#settingsBtn').trigger('click'); });
    }

    /* 跨工作区打开保护：文件变更卡可能属于另一个项目的 session。若把它当成当前项目的
       相对路径打开，轻则 404，重则静默打开另一个项目的同名文件（更危险，可能被编辑保存）。 */
    function samePathRoot(a, b) {
        var na = String(a || '').replace(/[\\/]+$/, '').replace(/\\/g, '/');
        var nb = String(b || '').replace(/[\\/]+$/, '').replace(/\\/g, '/');
        if (!na || !nb) return na === nb;
        /* Windows 路径大小写不敏感；POSIX 保留大小写语义 */
        if (/^[a-zA-Z]:/.test(na) || /^[a-zA-Z]:/.test(nb)) return na.toLowerCase() === nb.toLowerCase();
        return na === nb;
    }
    /* 打开中的文件门禁：docs[path] 要等 HTTP 回来才写入，期间重复点击会发多个请求、
       建多个 model 并重复 push tab，先建的 model 还会失去引用无法释放。 */
    var openingFiles = {};

    function openInEditor(path, name, rootOverride) {
        if (!isCode()) {
            // chat 模式仍走原只读查看器（若存在）；rootOverride 必须透传，否则文件变更卡
            // 好不容易带上的 session 工作区会在这一层丢掉。
            if (window._origOpenFileViewer) return window._origOpenFileViewer(path, name, rootOverride);
            return;
        }
        var requestedRoot = rootOverride || window.currentProjectRoot || '';
        if (rootOverride && !samePathRoot(rootOverride, window.currentProjectRoot)) {
            // 跨项目：不当作当前项目的可编辑 tab 打开，退回只读查看器并保留显式 root。
            if (window._origOpenFileViewer) return window._origOpenFileViewer(path, name, rootOverride);
            return;
        }
        // 可预览二进制文件（图片/PDF/音视频）：跳过文本读取，直接开预览标签
        // （Chromium 内核原生渲染，无需额外依赖；不依赖 Monaco 加载完成）
        var pk = previewKindOf(name || baseName(path));
        if (pk) {
            if (docs[path]) { activateFile(path); return; }
            docs[path] = { preview: pk, dirty: false, diskChanged: false };
            openFiles.push({ path: path, name: name || baseName(path) });
            renderTabs();
            activateFile(path);
            return;
        }
        // Monaco 为 AMD 异步加载：待就绪后再创建编辑器/模型
        window.__monacoLoad(function () {
            ensureEditor();
            if (!editor) { if (typeof showToast === 'function') showToast(GourdI18n.t('code.editor_not_loaded'), 'error'); return; }

            // 已打开则直接激活
            if (docs[path]) { activateFile(path); return; }
            var openKey = requestedRoot + '\u0000' + path;
            if (openingFiles[openKey]) return;                  // 同一文件正在加载，忽略重复点击
            openingFiles[openKey] = true;

            var url = '/web/chat/filer/read?path=' + encodeURIComponent(path)
                + (requestedRoot ? '&root=' + encodeURIComponent(requestedRoot) : '');
            $.get(url, function (resp) {
                // 响应回来时项目可能已切换：旧项目的文件不得写进新项目的 docs
                if (!samePathRoot(requestedRoot, window.currentProjectRoot || '')) return;
                if (!resp || resp.code !== 200) {
                    if (typeof showToast === 'function') showToast((resp && resp.description) || GourdI18n.t('code.cannot_read_file'), 'error');
                    return;
                }
                var d = resp.data || {};
                var fileName = d.name || name || path;
                // 二进制文件（后端口探测到 NUL 字节）：不显示乱码，开「不支持预览」占位标签
                if (d.binary) {
                    docs[path] = { preview: 'binary', dirty: false, diskChanged: false };
                    openFiles.push({ path: path, name: fileName });
                    renderTabs();
                    activateFile(path);
                    return;
                }
                var info = guessMonacoLanguage(fileName);
                var content = d.content || '';
                // 大文件降级：超阈值跳过语法着色与补全（Monaco 视口渲染本身不会像旧编辑器那样全量 DOM 卡顿）
                var large = content.length > LARGE_FILE_LIMIT;
                var model = monaco.editor.createModel(content, large ? 'plaintext' : info.langId);
                docs[path] = { model: model, cleanVer: model.getAlternativeVersionId(), large: large, dirty: false, diskChanged: false, viewState: null, contentSub: null };
                attachModelListener(path);
                openFiles.push({ path: path, name: fileName });
                renderTabs();
                activateFile(path);
            }).fail(function () {
                if (typeof showToast === 'function') showToast(GourdI18n.t('code.read_failed'), 'error');
            }).always(function () { delete openingFiles[openKey]; });
        });
    }

    function activateFile(path) {
        var st = docs[path];
        if (!st) return;
        // 切走前保存当前 model 的视图状态（光标/滚动），下次切回恢复
        if (activeFilePath && activeFilePath !== path && docs[activeFilePath] && editor) {
            docs[activeFilePath].viewState = editor.saveViewState();
        }
        // 预览标签（图片/PDF/音视频/二进制占位）：无 Monaco model，直接切换预览层渲染
        if (st.preview) {
            activeFilePath = path;
            // 激活即重新拉流渲染，「磁盘已变更」标记随之解除
            if (st.diskChanged) {
                st.diskChanged = false;
                var ptab = tabbar ? tabbar.querySelector('.code-editor-tab[data-path="' + cssEsc(path) + '"]') : null;
                if (ptab) ptab.classList.remove('disk-changed');
            }
            showPreview(path);
            renderTabs();
            refreshCenterPane();
            return;
        }
        if (!editor) return;
        activeFilePath = path;
        // 切到文本编辑：关闭可能残留的预览层（恢复编辑器宿主显示）
        hidePreview();
        // 仅当 model 变化时才切换（同一 model 重复 setModel 会重复挂变更监听）
        if (editor.getModel() !== st.model) {
            editor.setModel(st.model);
            if (st.viewState) { editor.restoreViewState(st.viewState); st.viewState = null; }
            else { editor.setPosition({ lineNumber: 1, column: 1 }); editor.setScrollTop(0); }
        }
        // 按文件大小切换能力（大文件关闭词补全等重运算）
        editor.updateOptions({
            wordBasedSuggestions: st.large ? 'off' : 'currentDocument',
            quickSuggestions: st.large ? { other: false, comments: false, strings: false } : { other: true, comments: false, strings: false }
        });
        markDirty(path, st.model.getAlternativeVersionId() !== st.cleanVer);
        renderTabs();
        refreshCenterPane();
        editor.focus();
    }

    function renderTabs() {
        if (!tabbar) return;
        var html = '';
        for (var i = 0; i < openFiles.length; i++) {
            var f = openFiles[i];
            var st = docs[f.path];
            var active = (f.path === activeFilePath) ? ' active' : '';
            var dirty = (st && st.dirty) ? ' dirty' : '';
            // 预览标签永不 dirty，但可能 disk-changed（非激活时外部修改，红点提示）
            var diskChanged = (st && st.diskChanged) ? ' disk-changed' : '';
            html += '<div class="code-editor-tab' + active + dirty + diskChanged + '" data-path="' + escAttr(f.path) + '" title="' + escAttr(f.path) + '">'
                + '<span class="code-editor-tab-name">' + escHtml(f.name) + '</span>'
                + '<span class="code-editor-tab-dot"></span>'
                + '<button class="code-editor-tab-close" data-path="' + escAttr(f.path) + '">&times;</button>'
                + '</div>';
        }
        tabbar.innerHTML = html;
        scrollActiveTabIntoView();
    }

    // 文件很多、标签栏出现横向滚动时，确保当前激活标签滚动到可见处
    function scrollActiveTabIntoView() {
        if (!tabbar || !activeFilePath) return;
        var el = tabbar.querySelector('.code-editor-tab.active');
        if (!el) return;
        // 用 rAF 等布局稳定后再滚，避免 innerHTML 重排时机问题
        (window.requestAnimationFrame || function (fn) { setTimeout(fn, 0); })(function () {
            var tabLeft = el.offsetLeft;
            var tabRight = tabLeft + el.offsetWidth;
            var viewLeft = tabbar.scrollLeft;
            var viewRight = viewLeft + tabbar.clientWidth;
            if (tabRight > viewRight) {
                tabbar.scrollLeft = tabRight - tabbar.clientWidth;
            } else if (tabLeft < viewLeft) {
                tabbar.scrollLeft = tabLeft;
            }
        });
    }

    if (tabbar) {
        tabbar.addEventListener('click', function (e) {
            var close = e.target.closest('.code-editor-tab-close');
            if (close) { e.stopPropagation(); closeFile(close.getAttribute('data-path')); return; }
            var tab = e.target.closest('.code-editor-tab');
            if (tab) activateFile(tab.getAttribute('data-path'));
        });
    }

    function markDirty(path, dirty) {
        var st = docs[path];
        if (!st) return;
        st.dirty = dirty;
        // 更新标签点
        var tab = tabbar ? tabbar.querySelector('.code-editor-tab[data-path="' + cssEsc(path) + '"]') : null;
        if (tab) tab.classList.toggle('dirty', dirty);
    }

    function closeFile(path) {
        var st = docs[path];
        if (st && st.dirty) {
            if (!window.confirm(GourdI18n.t('code.unsaved_confirm', baseName(path)))) return;
        }
        // 释放内容监听与 model（大文件标签必须释放，避免内存泄漏）
        if (st && st.contentSub) { try { st.contentSub.dispose(); } catch (e) {} st.contentSub = null; }
        if (st && st.model) st.model.dispose();
        delete docs[path];
        openFiles = openFiles.filter(function (f) { return f.path !== path; });
        if (activeFilePath === path) {
            activeFilePath = null;
            hidePreview(); // 关闭当前标签：预览内容随之清除，再激活下一个（或回空态）
            if (openFiles.length) activateFile(openFiles[openFiles.length - 1].path);
            else { if (editor) editor.setModel(null); refreshCenterPane(); renderTabs(); }
        } else {
            renderTabs();
        }
    }

    function closeAllFiles() {
        hidePreview();
        for (var p in docs) {
            if (!docs[p]) continue;
            if (docs[p].contentSub) { try { docs[p].contentSub.dispose(); } catch (e) {} }
            if (docs[p].model) docs[p].model.dispose();
        }
        openFiles = [];
        docs = {};
        activeFilePath = null;
        if (editor) editor.setModel(null);
        renderTabs();
        refreshCenterPane();
    }

    // 是否存在未保存（dirty）的打开文件。用于切项目/跨项目切会话前提示，避免静默丢弃改动。
    function hasUnsavedFiles() {
        for (var i = 0; i < openFiles.length; i++) {
            var st = docs[openFiles[i].path];
            if (st && st.dirty) return true;
        }
        return false;
    }

    // 切换项目（含跨项目切历史会话）会关闭全部打开文件。若有未保存改动，先聚合确认一次；
    // 用户取消则返回 false，调用方据此中止切换、保留文件。无未保存改动时直接放行。
    function confirmDiscardUnsavedIfAny() {
        if (!hasUnsavedFiles()) return true;
        return window.confirm(GourdI18n.t('code.unsaved_switch_confirm'));
    }
    window.confirmDiscardUnsavedIfAny = confirmDiscardUnsavedIfAny;

    var _saving = false;   // 保存防重入（原状态栏按钮防重入的替代）
    function saveActive() {
        if (!activeFilePath || _saving) return;
        var st = docs[activeFilePath];
        if (!st) return;
        if (!st.dirty) return;
        var content = st.model.getValue();
        var path = activeFilePath;
        _saving = true;
        $.ajax({
            url: '/web/chat/filer/write', method: 'POST', contentType: 'application/json',
            data: JSON.stringify({ path: path, content: content, root: window.currentProjectRoot || '' })
        }).done(function (resp) {
            _saving = false;
            if (resp && resp.code === 200) {
                st.cleanVer = st.model.getAlternativeVersionId();
                // 保存即以当前内容为准，清除「磁盘已变更」标记（否则下次编辑时红点会错误重现）
                st.diskChanged = false;
                var tab2 = tabbar ? tabbar.querySelector('.code-editor-tab[data-path="' + cssEsc(path) + '"]') : null;
                if (tab2) tab2.classList.remove('disk-changed');
                markDirty(path, false);
                // 保存成功不弹提示：静默完成即可（失败仍会报错）
            } else {
                if (typeof showToast === 'function') showToast((resp && resp.description) || GourdI18n.t('code.save_failed'), 'error');
            }
        }).fail(function () {
            _saving = false;
            if (typeof showToast === 'function') showToast(GourdI18n.t('code.save_failed'), 'error');
        });
    }

    // ---------- 外部修改同步：监听 filer_change，编辑器内容按需刷新 ----------
    // 后端 WorkspaceWatcher 监听启动工作区 + Code 当前项目根，变更经 WebSocket 广播 filer_change。
    // clean 文件静默重载磁盘内容（保留光标/滚动）；dirty 文件不覆盖用户改动，
    // 标签显示「磁盘已变更」提示点，点击标签时确认后重载。
    function notifyWatchRoot(root) {
        if (!root) return;
        $.ajax({
            url: '/web/chat/filer/watch', method: 'POST', contentType: 'application/json',
            data: JSON.stringify({ root: root })
        });
    }

    function onCodeFilerChange(chunk) {
        if (!chunk || !chunk.changes || chunk.changes.length === 0) return;
        chunk.changes.forEach(function (rel) {
            var abs = changeRelToOpenPath(rel);
            if (abs) handleDiskChanged(abs);
        });
    }

    // 后端 filer_change 的 changes 是「相对其所属监听根」的路径。已打开文件必然位于当前项目根下，
    // 且后端对嵌套根取最长前缀相对化，故用「项目根 + rel」精确匹配即可，不做文件名兜底（避免同名文件误触发）。
    function changeRelToOpenPath(rel) {
        var root = window.currentProjectRoot;
        if (!root || !rel) return null;
        var cand = root + '/' + rel;
        for (var i = 0; i < openFiles.length; i++) {
            if (openFiles[i].path === cand) return cand;
        }
        return null;
    }

    function handleDiskChanged(path) {
        var st = docs[path];
        if (!st) return;
        if (st.preview) {
            // 预览标签：激活中直接重新拉流渲染（URL 带时间戳天然破缓存）；
            // 非激活时标记红点，待激活时刷新
            if (activeFilePath === path) {
                showPreview(path);
            } else if (!st.diskChanged) {
                st.diskChanged = true;
                var ptab = tabbar ? tabbar.querySelector('.code-editor-tab[data-path="' + cssEsc(path) + '"]') : null;
                if (ptab) ptab.classList.add('disk-changed');
            }
            return;
        }
        if (st.dirty) {
            // 有未保存改动：不覆盖，标记「磁盘已变更」，点击标签时确认重载
            if (!st.diskChanged) {
                st.diskChanged = true;
                var tab = tabbar ? tabbar.querySelector('.code-editor-tab[data-path="' + cssEsc(path) + '"]') : null;
                if (tab) tab.classList.add('disk-changed');
            }
            return;
        }
        reloadFileFromDisk(path);
    }

    // 静默重载磁盘内容：保留光标与滚动位置，重置 clean 基线
    function reloadFileFromDisk(path) {
        var st = docs[path];
        if (!st) return;
        $.get('/web/chat/filer/read?path=' + encodeURIComponent(path) + rootQuery(), function (resp) {
            if (!resp || resp.code !== 200 || !docs[path]) return;
            var cur = docs[path];
            var cursor = null, scrollTop = null;
            if (editor && activeFilePath === path) {
                cursor = editor.getPosition();
                scrollTop = editor.getScrollTop();
            }
            cur.model.setValue(resp.data.content || '');
            cur.cleanVer = cur.model.getAlternativeVersionId();
            cur.diskChanged = false;
            markDirty(path, false);
            var tab = tabbar ? tabbar.querySelector('.code-editor-tab[data-path="' + cssEsc(path) + '"]') : null;
            if (tab) tab.classList.remove('disk-changed');
            if (cursor && editor && activeFilePath === path) {
                var maxLine = cur.model.getLineCount();
                if (cursor.lineNumber > maxLine) cursor = { lineNumber: maxLine, column: 1 };
                editor.setPosition(cursor);
            }
            if (scrollTop !== null && editor && activeFilePath === path) editor.setScrollTop(scrollTop);
        });
    }

    // 标签点击：disk-changed 文件先确认是否放弃本地未保存改动、重载磁盘内容（捕获阶段先于激活逻辑）
    if (tabbar) {
        tabbar.addEventListener('click', function (e) {
            if (e.target.closest('.code-editor-tab-close')) return;
            var tab = e.target.closest('.code-editor-tab');
            if (!tab) return;
            var p = tab.getAttribute('data-path');
            var st = docs[p];
            if (st && st.diskChanged && st.dirty) {
                if (window.confirm(GourdI18n.t('code.disk_changed_confirm', baseName(p)))) {
                    reloadFileFromDisk(p);
                }
            }
        }, true);
    }

    // 挂接 filer_change 事件链（app-gitdiff 可能已包装 window.onFilerChange，保留原调用）
    var _origOnFilerChange = window.onFilerChange;
    window.onFilerChange = function (chunk) {
        onCodeFilerChange(chunk);
        if (typeof _origOnFilerChange === 'function') _origOnFilerChange(chunk);
    };

    // ---------- 二进制文件预览（图片/PDF/音视频，Chromium 原生渲染，无额外依赖） ----------
    // 可预览扩展名按类划分；SVG 保留 Monaco 可编辑文本，不在此列
    var PREVIEW_KINDS = {
        image: { png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, bmp: 1, ico: 1, avif: 1 },
        pdf: { pdf: 1 },
        audio: { mp3: 1, wav: 1, ogg: 1, m4a: 1, aac: 1, flac: 1 },
        video: { mp4: 1, webm: 1 }
    };
    function previewKindOf(fileName) {
        var ext = String(fileName || '').toLowerCase().split('.').pop();
        for (var k in PREVIEW_KINDS) {
            if (PREVIEW_KINDS[k][ext]) return k;
        }
        return null;
    }

    // 预览用原始字节流地址（附时间戳破缓存：外部修改后刷新即可见新内容）
    function rawUrl(path) {
        return '/web/chat/filer/raw?path=' + encodeURIComponent(path) + rootQuery() + '&_t=' + Date.now();
    }

    // 渲染指定文件的预览层，并与编辑器宿主互斥显示
    function showPreview(path) {
        var st = docs[path];
        if (!previewHost || !st || !st.preview) return;
        var url = rawUrl(path);
        var name = escAttr(baseName(path));
        var html = '';
        if (st.preview === 'image') {
            html = '<div class="code-preview-stage"><img class="code-preview-img" src="' + url + '" alt="' + name + '" /></div>';
        } else if (st.preview === 'pdf') {
            html = '<iframe class="code-preview-frame" src="' + url + '" title="' + name + '"></iframe>';
        } else if (st.preview === 'audio') {
            html = '<div class="code-preview-stage"><audio class="code-preview-media" controls src="' + url + '"></audio></div>';
        } else if (st.preview === 'video') {
            html = '<div class="code-preview-stage"><video class="code-preview-media" controls src="' + url + '"></video></div>';
        } else {
            // binary 占位：不可预览的二进制文件（zip/exe/字体等）
            html = '<div class="code-preview-stage"><div class="code-preview-binary">'
                + binaryIcon()
                + '<div class="code-preview-binary-title">' + GourdI18n.t('code.preview_binary_title') + '</div>'
                + '<div class="code-preview-binary-name">' + escHtml(baseName(path)) + '</div>'
                + '<div class="code-preview-binary-desc">' + GourdI18n.t('code.preview_binary_desc') + '</div>'
                + '</div></div>';
        }
        previewHost.innerHTML = html;
        previewHost.style.display = 'flex';
        if (editorHost) editorHost.style.display = 'none';
        // 媒体加载失败：降级为通用「加载失败」占位
        var media = previewHost.querySelector('img, audio, video');
        if (media) media.addEventListener('error', function () { previewLoadFailed(); });
    }

    // 关闭预览层（停止音视频播放），恢复编辑器宿主显示
    function hidePreview() {
        if (!previewHost) return;
        var wasVisible = previewHost.style.display !== 'none';
        previewHost.innerHTML = '';
        previewHost.style.display = 'none';
        if (editorHost) editorHost.style.display = '';
        // 容器刚由隐藏恢复可见：主动刷新一次 Monaco 布局（automaticLayout 之外的双保险）
        if (wasVisible && editor) setTimeout(function () { editor.layout(); }, 0);
    }

    function previewLoadFailed() {
        if (!previewHost) return;
        previewHost.innerHTML = '<div class="code-preview-stage"><div class="code-preview-binary">'
            + binaryIcon()
            + '<div class="code-preview-binary-title">' + GourdI18n.t('code.preview_load_failed') + '</div>'
            + '</div></div>';
    }

    function binaryIcon() {
        return '<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">'
            + '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'
            + '</svg>';
    }

    // ---------- helpers ----------
    function rootQuery() {
        return (window.currentProjectRoot) ? '&root=' + encodeURIComponent(window.currentProjectRoot) : '';
    }
    function baseName(p) { return (p || '').replace(/.*\//, ''); }
    // 用与父目录一致的分隔符拼接子目录（Windows 用反斜杠，Unix 用正斜杠）
    function joinPath(parent, child) {
        if (!parent) return child;
        var sep = (parent.indexOf('\\') >= 0 && parent.indexOf('/') < 0) ? '\\' : '/';
        return parent.replace(/[\/\\]+$/, '') + sep + child;
    }
    function escHtml(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
    function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;'); }
    function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }

    // ---------- 覆盖 openFileViewer：code 模式进编辑器，chat 模式保留原只读查看器 ----------
    window._origOpenFileViewer = window.openFileViewer;
    window.openFileViewer = openInEditor;

    // ---------- 启动：恢复上次模式 ----------
    (function initMode() {
        var saved = null;
        try { saved = localStorage.getItem(LS_MODE); } catch (e) {}
        if (saved === 'code') {
            // 延迟一拍，确保 app-history 等已初始化
            setTimeout(enterCodeMode, 0);
        }
    })();

    // ---------- 右侧对话栏：拖拽调宽 + 收起/展开 ----------
    // 布局回顾：code 模式 .main-area 为 flex row，编辑器(order:1) | 手柄(order:2) | 对话栏(order:3)。
    // 对话栏宽度由 CSS 变量 --code-chat-width 驱动（.chat-view: flex 0 1 var(--code-chat-width)，可收缩至 min-width:320px）。
    var LS_CHAT_WIDTH = 'code-chat-width';
    var LS_CHAT_COLLAPSED = 'code-chat-collapsed';
    var CHAT_MIN_WIDTH = 320;
    var CHAT_MAX_WIDTH = 900;

    // 布局变化后刷新 Monaco 布局（automaticLayout 已自动跟随，这里保留手动触达口）
    function refreshEditor() { if (editor) setTimeout(function () { editor.layout(); }, 0); }
    window.refreshCodeEditor = refreshEditor;

    function setChatWidth(px) {
        var w = Math.max(CHAT_MIN_WIDTH, Math.min(CHAT_MAX_WIDTH, px));
        document.documentElement.style.setProperty('--code-chat-width', w + 'px');
        return w;
    }

    (function initChatResizeCollapse() {
        var handle = document.getElementById('codeChatResizeHandle');
        var collapseBtn = document.getElementById('codeChatCollapseBtn');
        var expandBtn = document.getElementById('codeChatExpandBtn');
        var chatView = document.getElementById('chatView');

        // 恢复持久化宽度（即使当前非 code 模式也无妨：变量待 code 模式生效）
        try {
            var savedW = parseInt(localStorage.getItem(LS_CHAT_WIDTH), 10);
            if (savedW) setChatWidth(savedW);
        } catch (e) {}

        // 恢复收起态（.chat-collapsed 仅在 body.code-mode 下由 CSS 生效，故此处可无条件加类）
        try {
            if (localStorage.getItem(LS_CHAT_COLLAPSED) === '1') $body.addClass('chat-collapsed');
        } catch (e) {}

        // ---- 拖拽调宽 ----
        if (handle && chatView) {
            var dragging = false, startX = 0, startWidth = 0;
            handle.addEventListener('mousedown', function (e) {
                dragging = true;
                startX = e.clientX;
                startWidth = chatView.offsetWidth;
                handle.classList.add('dragging');
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                e.preventDefault();
            });
            document.addEventListener('mousemove', function (e) {
                if (!dragging) return;
                // 对话栏在右侧：手柄向左拖（clientX 变小）→ 变宽
                var w = setChatWidth(startWidth + (startX - e.clientX));
                try { localStorage.setItem(LS_CHAT_WIDTH, w); } catch (er) {}
            });
            document.addEventListener('mouseup', function () {
                if (!dragging) return;
                dragging = false;
                handle.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                refreshEditor();
            });
        }

        // ---- 收起 / 展开 ----
        function setCollapsed(collapsed) {
            $body.toggleClass('chat-collapsed', collapsed);
            try { localStorage.setItem(LS_CHAT_COLLAPSED, collapsed ? '1' : '0'); } catch (e) {}
            refreshEditor();
        }
        if (collapseBtn) collapseBtn.addEventListener('click', function () { setCollapsed(true); });
        if (expandBtn) expandBtn.addEventListener('click', function () { setCollapsed(false); });
    })();

    // 暴露给其它模块
    window.enterCodeMode = enterCodeMode;
    window.exitCodeMode = exitCodeMode;
    // 聊天侧栏项目行图标：进入 code 模式并定位到指定项目（已在 code 模式则仅切换项目）
    window.openProjectInCodeMode = function (path) {
        if (!path) return;
        if (isCode()) { if (path !== window.currentProjectRoot) selectProject(path); }
        else enterCodeMode({ projectRoot: path });
    };
    window.startFreshCodeSession = startFreshSession;
    // 任务侧栏项目行「从列表移除」入口复用
    window.removeProjectFromList = removeProject;
    // chat 工作空间选择器复用：目录浏览弹窗 + watch 根登记
    window.openDirPicker = openDirPicker;
    window.notifyWatchRoot = notifyWatchRoot;
})();
