/* ===== app-gitdiff.js ===== */
/* Filer Panel Git Diff 面板：三态检测、文件列表（带勾选）、Diff Viewer 内联查看、精确提交 */

(function() {
    // ---- DOM 元素 ----
    // 视图切换按钮现位于左侧主侧边栏底部（.sidebar-footer-icons），data-view = files | gitdiff
    var tabs = document.querySelectorAll('.filer-view-btn');
    var tabContents = document.querySelectorAll('.filer-tab-content');
    var gitUnavailable = document.getElementById('gitUnavailable');
    var gitUninitialized = document.getElementById('gitUninitialized');
    var gitDiffPanel = document.getElementById('gitDiffPanel');
    // Git 变更计数角标：入口按钮可能有多处（专注模式文件树面板头部），统一按类查询同步更新
    var gitBadges = document.querySelectorAll('.git-badge');
    var gitBranch = document.getElementById('gitBranch');
    var gitDiffFileList = document.getElementById('gitDiffFileList');
    var gitDiffEmpty = document.getElementById('gitDiffEmpty');
    var gitInitBtn = document.getElementById('gitInitBtn');
    var gitInitCommit = document.getElementById('gitInitCommit');
    var gitCommitBtn = document.getElementById('gitCommitBtn');
    var gitCommitMsg = document.getElementById('gitCommitMsg');
    var gitCommitBar = document.getElementById('gitCommitBar');
    var gitSelectAll = document.getElementById('gitSelectAll');
    var gitRefreshBtn = document.getElementById('gitRefreshBtn');

    // Diff Viewer / File Viewer 元素（内联在 main-area 内）
    var gitDiffViewer = document.getElementById('gitDiffViewer');
    var gitViewerLabel = document.getElementById('gitViewerLabel');
    var gitViewerFile = document.getElementById('gitViewerFile');
    var gitViewerContent = document.getElementById('gitViewerContent');
    var gitViewerClose = document.getElementById('gitViewerClose');
    // main-area 子视图引用
    var welcomeView = document.getElementById('welcomeView');
    var chatView = document.getElementById('chatView');
    var codeEditorPane = document.getElementById('codeEditorPane');

    // ---- 状态 ----
    var gitStatus = null;
    var isInitializing = false;

    // ---- Code 模式项目根：git 接口按所选项目重定向（chat 模式为空串）----
    function gitRoot() {
        return (window.appMode === 'code' && window.currentProjectRoot) ? window.currentProjectRoot : '';
    }
    function gitRootQ(sep) {
        var r = gitRoot();
        return r ? (sep || '&') + 'root=' + encodeURIComponent(r) : '';
    }
    var viewerMode = null; // 'diff' | 'file' | null

    // ---- 刷新按钮 ----
    if (gitRefreshBtn) {
        gitRefreshBtn.addEventListener('click', function() {
            loadGitStatus();
        });
    }

    // ---- 视图切换（项目 / Git 审查）----
    // 切换入口在左侧主侧边栏的 .filer-view-btn；内容面板仍是 #tabContentFiles / #tabContentGitdiff。
    // 同步 window.filerView + body[data-filer-view]，供 CSS 显隐中间编辑器、app-code.js 刷新中间区。
    function applyFilerView(view, opts) {
        opts = opts || {};
        // 切换视图前先关掉可能打开的 diff/文件浮层，避免它继续占据编辑器列
        if (diffViewerActive) closeDiffViewer();
        tabs.forEach(function(t) { t.classList.toggle('active', t.getAttribute('data-view') === view); });
        var contentId = 'tabContent' + view.charAt(0).toUpperCase() + view.slice(1);
        tabContents.forEach(function(tc) { tc.classList.toggle('active', tc.id === contentId); });

        window.filerView = view;
        try { document.body.dataset.filerView = view; } catch (e) {}

        if (view === 'gitdiff') loadGitStatus();
        // 中间区按视图刷新（Git 视图隐藏 Code 编辑器）
        if (typeof window.refreshCenterPane === 'function') window.refreshCenterPane();
        if (opts.persist !== false) {
            try { localStorage.setItem('filer-active-tab', view); } catch (e) {}
        }
    }

    tabs.forEach(function(tab) {
        tab.addEventListener('click', function() {
            applyFilerView(this.getAttribute('data-view'));
        });
    });

    // 恢复上次视图（键名沿用 'filer-active-tab'）
    var savedTab = localStorage.getItem('filer-active-tab');
    // 历史遗留值 'tasks' 回退到 'files'
    if (savedTab === 'tasks') { savedTab = 'files'; try { localStorage.setItem('filer-active-tab', 'files'); } catch (e) {} }
    if (savedTab === 'gitdiff') {
        applyFilerView('gitdiff', { persist: false });
    } else {
        // 默认项目视图：仅初始化状态，不额外持久化
        window.filerView = 'files';
        try { document.body.dataset.filerView = 'files'; } catch (e) {}
    }

    // ---- 显示/隐藏状态区 ----
    function showState(state) {
        if (gitUnavailable) gitUnavailable.style.display = 'none';
        if (gitUninitialized) gitUninitialized.style.display = 'none';
        if (gitDiffPanel) gitDiffPanel.style.display = 'none';

        if (state === 'unavailable' && gitUnavailable) gitUnavailable.style.display = '';
        else if (state === 'uninitialized' && gitUninitialized) gitUninitialized.style.display = '';
        else if (state === 'ready' && gitDiffPanel) gitDiffPanel.style.display = '';
    }

    // ---- 加载 Git 状态 ----
    function loadGitStatus() {
        // Git 审查仅在 Code 模式且已选项目时才有意义：
        // - chat 模式没有文件树/审查面板，不应查询
        // - code 模式未选项目时，没有目标仓库，避免误显示启动工作区的变更
        if (window.appMode !== 'code' || !window.currentProjectRoot) {
            updateBadge(0);
            return;
        }
        var rootQ = '?root=' + encodeURIComponent(window.currentProjectRoot);
        fetch('/web/chat/git/status' + rootQ)
            .then(function(r) { return r.json(); })
            .then(function(res) {
                var data = (res && res.data) ? res.data : {};
                gitStatus = data;

                if (!data.gitAvailable) {
                    showState('unavailable');
                    pushFilerGitColors([]);
                    return;
                }
                if (!data.initialized) {
                    showState('uninitialized');
                    updateBadge(0);
                    pushFilerGitColors([]);
                    return;
                }

                showState('ready');
                renderBranch(data.branch);
                renderFileList(data);
                updateBadge(
                    (data.changed || []).length +
                    (data.staged || []).length +
                    (data.untracked || []).length
                );
                // 文件树着色复用本次结果（提交/暂存/变更后自动同步）
                pushFilerGitColors(buildFilesArray(data));
            })
            .catch(function(e) {
                console.error('[gitdiff] status error', e);
                showState('unavailable');
            });
    }

    // ---- 渲染分支名 ----
    function renderBranch(branch) {
        if (gitBranch) gitBranch.textContent = branch || '--';
    }

    // ---- 组装逐文件列表（status 分桶 + type 变更类型，图标/着色按 type 区分）----
    function buildFilesArray(data) {
        var files = [];
        // 优先读后端逐文件列表；旧版后端无 files 字段时回退三大桶拼装
        if (data.files && data.files.length) {
            data.files.forEach(function(f) {
                if (f && f.path) {
                    files.push({ path: f.path, status: f.status || 'M', type: f.type || 'M' });
                }
            });
        } else {
            (data.staged || []).forEach(function(p) {
                files.push({ path: p, status: 'S', type: 'M' });
            });
            (data.changed || []).forEach(function(p) {
                files.push({ path: p, status: 'M', type: 'M' });
            });
            (data.untracked || []).forEach(function(p) {
                files.push({ path: p, status: '?', type: 'U' });
            });
        }
        return files;
    }

    // ---- 推送状态给文件树着色（app-filer.js 复用本次请求结果，零额外 git 调用）----
    function pushFilerGitColors(files) {
        if (typeof window.filerOnGitStatus === 'function') {
            window.filerOnGitStatus(files);
        }
    }

    // ---- 渲染文件列表（带 checkbox）----
    function renderFileList(data) {
        if (!gitDiffFileList) return;

        // 在清空列表前，记录当前已勾选的文件路径
        var prevChecked = {};
        var hasPrevState = false;
        gitDiffFileList.querySelectorAll('.git-file-checkbox').forEach(function(cb) {
            hasPrevState = true;
            if (cb.checked) prevChecked[cb.getAttribute('data-path')] = true;
        });

        gitDiffFileList.innerHTML = '';

        var files = buildFilesArray(data);

        if (files.length === 0) {
            if (gitDiffEmpty) gitDiffEmpty.style.display = '';
            gitDiffFileList.style.display = 'none';
            if (gitCommitBar) gitCommitBar.style.display = 'none';
            return;
        }
        if (gitDiffEmpty) gitDiffEmpty.style.display = 'none';
        gitDiffFileList.style.display = '';
        if (gitCommitBar) gitCommitBar.style.display = '';

        files.forEach(function(file) {
            var item = document.createElement('div');
            item.className = 'git-file-item';

            // checkbox：如果之前有选中状态则恢复，否则默认全选
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'git-file-checkbox';
            cb.checked = hasPrevState ? !!prevChecked[file.path] : true;
            cb.setAttribute('data-path', file.path);
            cb.addEventListener('click', function(e) {
                e.stopPropagation(); // 防止触发外层 click 打开 diff
                syncSelectAll();
            });

            // 状态图标：轮廓样式，按变更类型区分（新增 + / 修改 ● / 删除 −，未跟踪视同新增）
            var statusSpan = document.createElement('span');
            statusSpan.className = 'git-status-icon ' + file.type;

            // 文件名（主）+ 所在目录（次）：优先保证文件名可见，长路径不再把名字挤没
            var slash = file.path.lastIndexOf('/');
            var fileName = slash >= 0 ? file.path.substring(slash + 1) : file.path;
            var dirPath = slash >= 0 ? file.path.substring(0, slash) : '';

            var pathSpan = document.createElement('span');
            pathSpan.className = 'git-file-path';
            pathSpan.title = file.path;
            var nameEl = document.createElement('span');
            nameEl.className = 'git-file-name';
            nameEl.textContent = fileName;
            pathSpan.appendChild(nameEl);
            if (dirPath) {
                var dirEl = document.createElement('span');
                dirEl.className = 'git-file-dir';
                dirEl.textContent = dirPath;
                pathSpan.appendChild(dirEl);
            }

            item.appendChild(cb);
            item.appendChild(statusSpan);
            item.appendChild(pathSpan);

            item.setAttribute('data-status', file.status);

            // 点击文件行打开 diff viewer
            item.addEventListener('click', function(e) {
                // 避免点 checkbox 时也触发
                if (e.target === cb) return;
                openDiffViewer(file.path, file.status, file.type);
            });

            gitDiffFileList.appendChild(item);
        });
    }

    // ---- 同步全选 checkbox 状态 ----
    function syncSelectAll() {
        if (!gitSelectAll || !gitDiffFileList) return;
        var all = gitDiffFileList.querySelectorAll('.git-file-checkbox');
        var checked = gitDiffFileList.querySelectorAll('.git-file-checkbox:checked');
        gitSelectAll.checked = (all.length > 0 && all.length === checked.length);
    }

    // ---- 全选/取消全选 ----
    if (gitSelectAll) {
        gitSelectAll.addEventListener('change', function() {
            if (!gitDiffFileList) return;
            var cbs = gitDiffFileList.querySelectorAll('.git-file-checkbox');
            var val = this.checked;
            cbs.forEach(function(cb) { cb.checked = val; });
        });
    }

    // ---- 获取选中的文件路径列表 ----
    function getSelectedFiles() {
        if (!gitDiffFileList) return [];
        var checked = gitDiffFileList.querySelectorAll('.git-file-checkbox:checked');
        var paths = [];
        checked.forEach(function(cb) {
            var p = cb.getAttribute('data-path');
            if (p) paths.push(p);
        });
        return paths;
    }

    // ---- 根据文件扩展名推测语言（用于 hljs）----
    function guessLang(path) {
        var ext = (path || '').replace(/.*\./, '').toLowerCase();
        var map = {
            js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
            java: 'java', kt: 'kotlin', kts: 'kotlin',
            py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
            c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
            cs: 'csharp', fs: 'fsharp',
            scala: 'scala', clj: 'clojure', ex: 'elixir', exs: 'elixir',
            html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
            css: 'css', scss: 'scss', less: 'less', sass: 'scss',
            json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
            md: 'markdown', markdown: 'markdown',
            sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
            dockerfile: 'dockerfile', makefile: 'makefile',
            gradle: 'groovy', groovy: 'groovy',
            lua: 'lua', r: 'r', pl: 'perl', pm: 'perl',
            swift: 'swift', dart: 'dart',
            vue: 'xml', svelte: 'xml',
            properties: 'properties', conf: 'nginx', nginx: 'nginx',
            ini: 'ini', cfg: 'ini',
            txt: 'plaintext'
        };
        // 特殊文件名
        var name = (path || '').replace(/.*\//, '').toLowerCase();
        if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
        if (name === 'dockerfile') return 'dockerfile';
        if (name === '.gitignore' || name === '.gitattributes') return 'bash';
        if (name === 'jenkinsfile') return 'groovy';
        if (name === 'vagrantfile') return 'ruby';
        return map[ext] || '';
    }

    // ---- 格式化文件大小 ----
    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // ---- File Viewer / Diff Viewer：Monaco 宿主与状态 ----
    var diffViewerActive = false;

    var fileViewerEditor = null;      // 文件查看器：只读 Monaco 编辑器（懒创建）
    var diffViewerEditor = null;      // Diff 查看器：Monaco DiffEditor（懒创建）
    var viewerFileModel = null;       // 文件查看器当前 model
    var viewerDiffModels = null;      // { original, modified }
    var VIEWER_LARGE_LIMIT = 1500000; // 与 app-code.js 一致：超阈值 plaintext + 关补全

    var gitViewerInfoBar = document.getElementById('gitViewerInfoBar');
    var gitViewerMsg = document.getElementById('gitViewerMsg');
    var gitViewerFileHost = document.getElementById('gitViewerFileHost');
    var gitViewerDiffHost = document.getElementById('gitViewerDiffHost');

    // 消息占位（loading/错误/无差异等）：隐藏两个 Monaco 宿主
    function showViewerMsg(text, isError) {
        if (!gitViewerMsg) return;
        gitViewerMsg.innerHTML = '<div class="git-viewer-msg-inner"' + (isError ? ' style="color:var(--color-danger)"' : '') + '>'
            + escapeHtml(text) + '</div>';
        gitViewerMsg.style.display = 'block';
        if (gitViewerInfoBar) gitViewerInfoBar.style.display = 'none';
        if (gitViewerFileHost) gitViewerFileHost.style.display = 'none';
        if (gitViewerDiffHost) gitViewerDiffHost.style.display = 'none';
    }

    // 只读文件查看器（懒创建单实例，切换 model）
    function ensureFileViewerEditor() {
        if (fileViewerEditor) return fileViewerEditor;
        var monaco = window.__monacoGet && window.__monacoGet();
        if (!monaco || !gitViewerFileHost) return null;
        fileViewerEditor = monaco.editor.create(gitViewerFileHost, {
            model: null,
            theme: window.__monacoThemeName(),
            readOnly: true,
            domReadOnly: true,
            fontSize: 13,
            fontFamily: window.__monacoFontFamily,
            lineHeight: 1.6,
            lineNumbers: 'on',
            wordWrap: 'off',
            folding: true,
            showFoldingControls: 'always',
            minimap: { enabled: true, maxColumn: 80 },
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            automaticLayout: true,
            renderLineHighlight: 'none',
            matchBrackets: 'always',
            bracketPairColorization: { enabled: true },
            // 滚动条尺寸与全局规范一致（theme.css --scrollbar-size: 6px），颜色/圆角由 code.css 统一覆盖
            scrollbar: { useShadows: false, verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
            wordBasedSuggestions: 'currentDocument',
            quickSuggestions: { other: true, comments: false, strings: false },
            largeFileOptimizations: true,
            padding: { top: 6, bottom: 6 }
        });
        return fileViewerEditor;
    }

    // Diff 编辑器（懒创建单实例，切换 model）
    function ensureDiffEditor() {
        if (diffViewerEditor) return diffViewerEditor;
        var monaco = window.__monacoGet && window.__monacoGet();
        if (!monaco || !gitViewerDiffHost) return null;
        diffViewerEditor = monaco.editor.createDiffEditor(gitViewerDiffHost, {
            theme: window.__monacoThemeName(),
            readOnly: true,
            renderSideBySide: true,
            enableSplitViewResizing: true,
            ignoreTrimWhitespace: false,
            renderOverviewRuler: true,
            automaticLayout: true,
            fontSize: 13,
            fontFamily: window.__monacoFontFamily,
            lineHeight: 1.6,
            folding: true,
            showFoldingControls: 'always',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            // 滚动条尺寸与全局规范一致（theme.css --scrollbar-size: 6px），颜色/圆角由 code.css 统一覆盖
            scrollbar: { useShadows: false, verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
            matchBrackets: 'always',
            bracketPairColorization: { enabled: true },
            largeFileOptimizations: true,
            padding: { top: 6, bottom: 6 }
        });
        return diffViewerEditor;
    }

    // 在 code 模式下，main-area 是横向 flex：中间编辑器列（.code-editor-col，内含编辑器面板、
    // diff 浮层与底部终端）与右侧对话栏是同级列。若只显示浮层而不隐藏编辑器面板，二者会各占
    // 一半，右侧残留「代码审查」占位空白。用 body.viewer-open 类让 CSS 在 viewer 打开时隐藏
    // 编辑器面板（终端面板独立于编辑器面板，不受影响，仍可打开）——纯类控制，避免与
    // refreshCenterPane 的内联样式打架。
    function showViewer() {
        if (welcomeView) welcomeView.style.display = 'none';
        // code 模式：diff 浮层占据中间列，与右侧对话栏(#chatView, order:3)是正交的两列，
        // 不能隐藏对话栏（否则新开/切换对话会连带把中间 diff 顶掉）。仅 chat 模式下
        // diff 是全屏覆盖，才需要隐藏聊天视图。
        if (chatView && window.appMode !== 'code') chatView.style.display = 'none';
        try { document.body.classList.add('viewer-open'); } catch (e) {}
        gitDiffViewer.style.display = 'flex';
        diffViewerActive = true;
    }

    function openFileViewer(path, name) {
        if (!gitDiffViewer) return;

        viewerMode = 'file';

        // 显示 viewer（隐藏欢迎页/聊天视图，并在 code 模式接管编辑器列）
        showViewer();

        // 更新 header
        if (gitViewerLabel) gitViewerLabel.textContent = GourdI18n.t('git.file_content');
        if (gitViewerFile) gitViewerFile.textContent = path;

        // 清理操作栏
        var oldActions = gitDiffViewer.querySelector('.git-viewer-actions');
        if (oldActions) oldActions.remove();

        showViewerMsg(GourdI18n.t('git.loading'));

        // Monaco 为 AMD 异步加载：待就绪后再读取并渲染
        window.__monacoLoad(function () {
            var monaco = window.__monacoGet && window.__monacoGet();
            if (!monaco) { showViewerMsg(GourdI18n.t('code.editor_not_loaded'), true); return; }

            // code 模式必须携带 root（当前项目根），否则后端回退到启动工作区解析路径 → 404
            fetch('/web/chat/filer/read?path=' + encodeURIComponent(path) + gitRootQ())
                .then(function(r) { return r.json(); })
                .then(function(res) {
                    var d = (res && res.data) ? res.data : {};
                    if (res && res.code !== 200) {
                        showViewerMsg((res && res.data && res.data.message) || res.description || GourdI18n.t('git.cannot_read'), true);
                        return;
                    }
                    renderFileContentMonaco(d.content || '', d.name || name, d.size, path);
                })
                .catch(function(e) {
                    showViewerMsg(GourdI18n.t('git.load_failed', (e && e.message) || ''), true);
                });
        });
    }

    // ---- File Viewer：Monaco 只读编辑器渲染（语法高亮 + 行号 + 折叠，替代 hljs 逐行 innerHTML）----
    function renderFileContentMonaco(content, fileName, fileSize, filePath) {
        var monaco = window.__monacoGet && window.__monacoGet();
        if (!monaco) return;
        var info = (typeof window.__monacoGuessLang === 'function') ? window.__monacoGuessLang(filePath || fileName) : { langId: 'plaintext', label: '' };
        var large = (content || '').length > VIEWER_LARGE_LIMIT;
        var langId = large ? 'plaintext' : info.langId;

        var ed = ensureFileViewerEditor();
        if (!ed) return;
        // 替换 model（旧 model dispose 释放内存，大文件不残留）
        if (viewerFileModel) viewerFileModel.dispose();
        var uri = monaco.Uri.parse('file:///' + (filePath || fileName || 'file'));
        viewerFileModel = monaco.editor.createModel(content || '', langId, uri);
        ed.setModel(viewerFileModel);
        ed.updateOptions({
            wordBasedSuggestions: large ? 'off' : 'currentDocument',
            quickSuggestions: large ? { other: false, comments: false, strings: false } : { other: true, comments: false, strings: false }
        });

        // 信息栏（保留复制按钮）
        var totalLines = (content || '').split('\n').length;
        var infoHtml = '<div class="file-view-info">'
            + '<span>' + escapeHtml(fileName || '') + '</span>'
            + '<span class="file-view-info-sep">|</span>'
            + '<span>' + GourdI18n.t('git.total_lines', totalLines) + '</span>'
            + '<span class="file-view-info-sep">|</span>'
            + '<span>' + formatSize(fileSize || 0) + '</span>'
            + (info.label ? '<span class="file-view-info-sep">|</span><span>' + escapeHtml(info.label) + '</span>' : '')
            + '<span class="file-view-copy-btn" title="' + GourdI18n.t('git.copy_file') + '">' + GourdI18n.t('git.copy') + '</span>'
            + '</div>';
        if (gitViewerInfoBar) { gitViewerInfoBar.innerHTML = infoHtml; gitViewerInfoBar.style.display = ''; }
        if (gitViewerMsg) gitViewerMsg.style.display = 'none';
        if (gitViewerFileHost) gitViewerFileHost.style.display = 'block';
        if (gitViewerDiffHost) gitViewerDiffHost.style.display = 'none';

        // 复制按钮
        var copyBtn = gitViewerInfoBar ? gitViewerInfoBar.querySelector('.file-view-copy-btn') : null;
        if (copyBtn) {
            (function(rawContent, btn) {
                btn.addEventListener('click', function() {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(rawContent).then(function() {
                            btn.textContent = GourdI18n.t('git.copied');
                            setTimeout(function() { btn.textContent = GourdI18n.t('git.copy'); }, 1500);
                        }).catch(function() {
                            fallbackCopy(rawContent, btn);
                        });
                    } else {
                        fallbackCopy(rawContent, btn);
                    }
                });
            })(content, copyBtn);
        }
        ed.layout();
    }

    // 复制兜底方法
    function fallbackCopy(text, btn) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch(e) {}
        document.body.removeChild(ta);
        btn.textContent = GourdI18n.t('git.copied');
        setTimeout(function() { btn.textContent = GourdI18n.t('git.copy'); }, 1500);
    }

    // ---- Diff Viewer：打开内联 diff（在 main-area 内）----

    function openDiffViewer(path, status, type) {
        if (!gitDiffViewer) return;

        viewerMode = 'diff';

        // 显示 diff viewer（隐藏欢迎页/聊天视图，并在 code 模式接管编辑器列）
        showViewer();

        if (gitViewerLabel) gitViewerLabel.textContent = GourdI18n.t('git.change_detail');
        if (gitViewerFile) gitViewerFile.textContent = path;

        // 判断是否是目录（以 / 结尾）
        var isDir = path.endsWith('/');

        if (isDir) {
            // 目录：显示提示信息，不调用 diff 接口
            showViewerMsg(path + '\n' + GourdI18n.t('git.no_diff_dir'));
            renderViewerActions(path, status);
            return;
        }

        showViewerMsg(GourdI18n.t('git.loading'));

        // Monaco DiffEditor 需要修改前后的完整内容（而非 unified diff 文本）：
        // - 旧版：/web/chat/git/file-content?ref=HEAD（git show HEAD:path；新文件/无 HEAD 时为空）
        // - 新版：/web/chat/filer/read（工作区当前内容）
        window.__monacoLoad(function () {
            var monaco = window.__monacoGet && window.__monacoGet();
            if (!monaco) { showViewerMsg(GourdI18n.t('code.editor_not_loaded'), true); return; }

            var oldP = Promise.resolve('');
            if (status !== '?') {
                oldP = fetch('/web/chat/git/file-content?path=' + encodeURIComponent(path) + '&ref=HEAD' + gitRootQ())
                    .then(function(r) { return r.json(); })
                    .then(function(res) {
                        if (res && res.code === 200 && res.data && typeof res.data.content === 'string') return res.data.content;
                        return '';  // 新文件 / HEAD 不存在 → 旧版为空
                    })
                    .catch(function() { return ''; });
            }
            // 新版内容：优先读工作区；删除类型（暂存删除 D  或工作区删除  D）文件已不在磁盘，
            // filer/read 必然 404（旧版走 unified diff 能看到整文件删除，此处必须等价恢复，否则误报"无法读取"）
            var newP;
            if (type === 'D') {
                newP = Promise.resolve('');
            } else {
                // code 模式必须携带 root（当前项目根），否则后端回退到启动工作区解析路径 → 404
                newP = fetch('/web/chat/filer/read?path=' + encodeURIComponent(path) + gitRootQ())
                    .then(function(r) { return r.json(); })
                    .then(function(res) {
                        if (res && res.code === 200 && res.data && typeof res.data.content === 'string') return res.data.content;
                        if (res && res.code === 413) return { tooLarge: res.description || '' };
                        throw new Error('filer read failed');
                    })
                    .catch(function() { return null; });
            }

            Promise.all([oldP, newP]).then(function(parts) {
                var oldText = parts[0] || '';
                var newText = parts[1];
                if (newText === null) { showViewerMsg(GourdI18n.t('git.cannot_read'), true); return; }
                if (newText && newText.tooLarge !== undefined) {
                    showViewerMsg(newText.tooLarge || GourdI18n.t('git.cannot_read'), true);
                    return;
                }
                renderViewerDiffMonaco(path, oldText, newText);
            });
        });

        renderViewerActions(path, status);
    }

    // ---- Diff Viewer：渲染操作按钮（添加到Git / 移出暂存）----
    function renderViewerActions(path, status) {
        // 移除旧的操作栏（如有）
        var oldActions = gitDiffViewer.querySelector('.git-viewer-actions');
        if (oldActions) oldActions.remove();

        if (status !== '?' && status !== 'S') return; // 只有未跟踪和已暂存需要操作按钮

        var actionBar = document.createElement('div');
        actionBar.className = 'git-viewer-actions';

        if (status === '?') {
            // 未跟踪 -> 提供 "添加到 Git" 按钮
            var addBtn = document.createElement('button');
            addBtn.className = 'git-action-btn git-action-add';
            addBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> ' + GourdI18n.t('git.add_to_git');
            addBtn.addEventListener('click', function() {
                addBtn.disabled = true;
                addBtn.textContent = GourdI18n.t('git.adding');
                fetch('/web/chat/git/stage', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: path, root: gitRoot() })
                })
                .then(function(r) { return r.json(); })
                .then(function(res) {
                    if (res && res.code === 200) {
                        loadGitStatus();
                        closeDiffViewer();
                    } else {
                        layAlert(GourdI18n.t('git.op_failed', (res && res.data && res.data.message) || GourdI18n.t('git.unknown_error')));
                    }
                })
                .catch(function(e) {
                    layAlert(GourdI18n.t('git.op_failed', e.message));
                    addBtn.disabled = false;
                });
            });
            actionBar.appendChild(addBtn);
        }

        if (status === 'S') {
            // 已暂存 -> 提供 "移出暂存" 按钮
            var unstageBtn = document.createElement('button');
            unstageBtn.className = 'git-action-btn git-action-unstage';
            unstageBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg> ' + GourdI18n.t('git.unstage_from_git');
            unstageBtn.addEventListener('click', function() {
                unstageBtn.disabled = true;
                unstageBtn.textContent = GourdI18n.t('git.unstaging');
                fetch('/web/chat/git/unstage', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: path, root: gitRoot() })
                })
                .then(function(r) { return r.json(); })
                .then(function(res) {
                    if (res && res.code === 200) {
                        loadGitStatus();
                        closeDiffViewer();
                    } else {
                        layAlert(GourdI18n.t('git.op_failed', (res && res.data && res.data.message) || GourdI18n.t('git.unknown_error')));
                        unstageBtn.disabled = false;
                        unstageBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg> ' + GourdI18n.t('git.unstage_from_git');
                    }
                })
                .catch(function(e) {
                    layAlert(GourdI18n.t('git.op_failed', e.message));
                    unstageBtn.disabled = false;
                    unstageBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg> ' + GourdI18n.t('git.unstage_from_git');
                });
            });
            actionBar.appendChild(unstageBtn);
        }

        // 插入到 header 后面、content 前面
        var content = gitDiffViewer.querySelector('.git-viewer-content');
        if (content) {
            gitDiffViewer.insertBefore(actionBar, content);
        }
    }

    // ---- Diff Viewer：Monaco DiffEditor 渲染（左右并排 + 行内 diff + 折叠，替代手写 unified diff 解析）----
    // 输入为修改前后两份完整内容（openDiffViewer 经 file-content + filer/read 取得）。
    function renderViewerDiffMonaco(path, oldText, newText) {
        var monaco = window.__monacoGet && window.__monacoGet();
        if (!monaco) return;
        var info = (typeof window.__monacoGuessLang === 'function') ? window.__monacoGuessLang(path) : { langId: 'plaintext', label: '' };
        var large = ((oldText || '').length + (newText || '').length) > VIEWER_LARGE_LIMIT;
        var langId = large ? 'plaintext' : info.langId;

        var de = ensureDiffEditor();
        if (!de) return;
        // 替换 model（旧 model dispose 释放内存）
        if (viewerDiffModels) {
            viewerDiffModels.original.dispose();
            viewerDiffModels.modified.dispose();
        }
        var origUri = monaco.Uri.parse('file:///HEAD/' + (path || 'file'));
        var modUri = monaco.Uri.parse('file:///' + (path || 'file'));
        viewerDiffModels = {
            original: monaco.editor.createModel(oldText || '', langId, origUri),
            modified: monaco.editor.createModel(newText || '', langId, modUri)
        };
        de.setModel({ original: viewerDiffModels.original, modified: viewerDiffModels.modified });

        if (gitViewerInfoBar) gitViewerInfoBar.style.display = 'none';
        if (gitViewerMsg) gitViewerMsg.style.display = 'none';
        if (gitViewerFileHost) gitViewerFileHost.style.display = 'none';
        if (gitViewerDiffHost) gitViewerDiffHost.style.display = 'block';
        de.layout();
    }

    // ---- Diff Viewer：关闭，恢复原始视图 ----
    function closeDiffViewer() {
        if (!gitDiffViewer) return;
        gitDiffViewer.style.display = 'none';
        diffViewerActive = false;

        // 清理操作栏
        var oldActions = gitDiffViewer.querySelector('.git-viewer-actions');
        if (oldActions) oldActions.remove();

        // 释放 Monaco model（大文件内存及时回收）
        if (viewerFileModel) { viewerFileModel.dispose(); viewerFileModel = null; if (fileViewerEditor) fileViewerEditor.setModel(null); }
        if (viewerDiffModels) {
            viewerDiffModels.original.dispose();
            viewerDiffModels.modified.dispose();
            viewerDiffModels = null;
            if (diffViewerEditor) diffViewerEditor.setModel(null);
        }

        // 解除对编辑器列的接管（code 模式下让 #codeEditorPane 重新显示）
        try { document.body.classList.remove('viewer-open'); } catch (e) {}

        // 关键：必须先清除两个视图的内联 display 样式
        // 因为 chatView 的可见性由 CSS .active 类控制（.chat-view.active { display: flex }）
        // 如果残留 style="display:none"，会覆盖 CSS 类规则，导致视图空白
        if (chatView) chatView.style.display = '';
        if (welcomeView) welcomeView.style.display = '';

        // code 模式：中间编辑器列的三态（欢迎/空态/编辑器/审查占位）由 refreshCenterPane 统一恢复
        if (window.appMode === 'code' && typeof window.refreshCenterPane === 'function') {
            window.refreshCenterPane();
            return;
        }

        // chat 模式：根据当前视图恢复正确的可见性
        // chatView 可见性由 .active 类控制（CSS 规则），无需额外操作
        // welcomeView 仅在非聊天模式下可见
        if (chatView && chatView.classList.contains('active')) {
            welcomeView.style.display = 'none';
        }
    }

    if (gitViewerClose) {
        gitViewerClose.addEventListener('click', closeDiffViewer);
    }

    // ESC 关闭 diff viewer
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && diffViewerActive) {
            closeDiffViewer();
        }
    });

    // ---- AI 生成变更摘要（专用 HTTP 接口）----
    var gitSummaryBtn = document.getElementById('gitSummaryBtn');
    var isGeneratingSummary = false;

    if (gitSummaryBtn) {
        gitSummaryBtn.addEventListener('click', function() {
            if (isGeneratingSummary) return;

            var files = getSelectedFiles();
            if (files.length === 0) {
                if (typeof showToast === 'function') showToast(GourdI18n.t('git.check_at_least_one'), 'error');
                else layAlert(GourdI18n.t('git.check_at_least_one'));
                return;
            }

            isGeneratingSummary = true;
            gitSummaryBtn.disabled = true;
            gitSummaryBtn.classList.add('loading');
            gitSummaryBtn.innerHTML = GourdI18n.t('git.generating');
            if (gitCommitMsg) gitCommitMsg.value = '';

            // 获取当前会话的 sessionId
            var currentSessionId = (typeof activeSessionId !== 'undefined') ? activeSessionId : '';

            fetch('/web/chat/git/summary', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'sessionId=' + encodeURIComponent(currentSessionId)
                    + '&paths=' + encodeURIComponent(JSON.stringify(files))
                    + (gitRoot() ? '&root=' + encodeURIComponent(gitRoot()) : '')
            })
            .then(function(r) { return r.json(); })
            .then(function(res) {
                if (res && res.code === 200 && res.data) {
                    var summary = res.data.summary || '';
                if (gitCommitMsg) {
                    gitCommitMsg.value = summary;
                    if (!gitCommitMsg._manualH) {
                        gitCommitMsg.style.height = 'auto';
                        gitCommitMsg.style.height = Math.min(gitCommitMsg.scrollHeight, 80) + 'px';
                    }
                }
                } else {
                    var errMsg = (res && res.description) || GourdI18n.t('git.unknown_error');
                    if (typeof showToast === 'function') showToast(GourdI18n.t('git.summary_failed', errMsg), 'error');
                    else layAlert(GourdI18n.t('git.summary_failed', errMsg));
                }
            })
            .catch(function(e) {
                if (typeof showToast === 'function') showToast(GourdI18n.t('git.summary_failed', e.message), 'error');
                else layAlert(GourdI18n.t('git.summary_failed', e.message));
            })
            .finally(function() {
                isGeneratingSummary = false;
                if (gitSummaryBtn) {
                    gitSummaryBtn.disabled = false;
                    gitSummaryBtn.classList.remove('loading');
                    gitSummaryBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4V2"/><path d="M15 16v-2"/><path d="M8 9h2"/><path d="M20 9h2"/><path d="M17.8 11.8L19 13"/><path d="M15 9h.01"/><path d="M17.8 6.2L19 5"/><path d="m3 21 9-9"/><path d="M12.2 6.2L11 5"/></svg> ' + GourdI18n.t('git.gen_summary');
                }
            });
        });
    }

    // ---- Git 提交（精确文件列表）----
    var isCommitting = false;
    if (gitCommitBtn) {
        gitCommitBtn.addEventListener('click', function() {
            if (isCommitting) return;
            var msg = (gitCommitMsg && gitCommitMsg.value.trim()) || '';
            if (!msg) {
                gitCommitMsg && gitCommitMsg.focus();
                gitCommitMsg && gitCommitMsg.classList.add('shake');
                var origPH = gitCommitMsg.placeholder;
                gitCommitMsg.placeholder = GourdI18n.t('git.input_commit_msg');
                setTimeout(function() {
                    gitCommitMsg && gitCommitMsg.classList.remove('shake');
                    gitCommitMsg.placeholder = origPH;
                }, 1200);
                return;
            }
            var files = getSelectedFiles();
            if (files.length === 0) {
                if (typeof showToast === 'function') showToast(GourdI18n.t('git.check_at_least_one'), 'error');
                return;
            }

            isCommitting = true;
            gitCommitBtn.disabled = true;
            gitCommitBtn.innerHTML = '<span style="opacity:0.7">' + GourdI18n.t('git.committing') + '</span>';

            fetch('/web/chat/git/commit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: msg, files: files, root: gitRoot() })
            })
                .then(function(r) { return r.json(); })
                .then(function(res) {
                    if (res && res.code === 200) {
            if (gitCommitMsg) {
                gitCommitMsg.value = '';
                gitCommitMsg.style.height = (gitCommitMsg._manualH ? gitCommitMsg._manualH : 30) + 'px';
                        }
                        loadGitStatus();
                        // 提交成功，不显示提示
                    } else {
                        layAlert(GourdI18n.t('git.commit_failed', (res && res.data && res.data.message) || GourdI18n.t('git.unknown_error')));
                    }
                })
                .catch(function(e) {
                    layAlert(GourdI18n.t('git.commit_failed', e.message));
                })
                .finally(function() {
                    isCommitting = false;
                    gitCommitBtn.disabled = false;
                    gitCommitBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> ' + GourdI18n.t('git.commit');
                });
        });

        // Enter 键提交
        if (gitCommitMsg) {
            gitCommitMsg.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                    e.preventDefault();
                    gitCommitBtn.click();
                }
            });
            // textarea 自动增高（最多4行）；手动拖拽过高度后保持手动值（超出滚动）
            gitCommitMsg.addEventListener('input', function() {
                if (this._manualH) return;
                this.style.height = 'auto';
                this.style.height = Math.min(this.scrollHeight, 80) + 'px';
            });
            // 复用对话输入框的顶部拖拽条：拖拽调整高度，双击恢复自动
            if (gitCommitBar && typeof window.initInputResizeHandle === 'function') {
                window.initInputResizeHandle(gitCommitBar.querySelector('.input-resize-handle'), gitCommitMsg);
            }
        }
    }

    // ---- 初始化 Git 仓库 ----
    if (gitInitBtn) {
        gitInitBtn.addEventListener('click', function() {
            if (isInitializing) return;
            isInitializing = true;
            gitInitBtn.disabled = true;
            gitInitBtn.textContent = GourdI18n.t('git.initializing');

            var doCommit = gitInitCommit && gitInitCommit.checked;
            fetch('/web/chat/git/init?initialCommit=' + (doCommit ? 'true' : 'false') + gitRootQ(), { method: 'POST' })
                .then(function(r) { return r.json(); })
                .then(function(res) {
                    if (res && res.code === 200) {
                        loadGitStatus();
                    } else {
                        layAlert(GourdI18n.t('git.init_failed', (res && res.data && res.data.message) || GourdI18n.t('git.unknown_error')));
                        gitInitBtn.disabled = false;
                        gitInitBtn.innerHTML =
                            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> ' + GourdI18n.t('git.init_repo');
                    }
                })
                .catch(function(e) {
                    layAlert(GourdI18n.t('git.init_failed', e.message));
                    gitInitBtn.disabled = false;
                    gitInitBtn.innerHTML =
                        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> ' + GourdI18n.t('git.init_repo');
                })
                .finally(function() {
                    isInitializing = false;
                });
        });
    }

    // ---- Badge 更新 ----
    function updateBadge(count) {
        gitBadges.forEach(function (b) {
            if (count > 0) {
                b.textContent = count > 99 ? '99+' : count;
                b.style.display = 'inline';
            } else {
                b.style.display = 'none';
            }
        });
    }

    // ---- WebSocket 联动：文件变更时刷新 git status ----
    var origOnFilerChange = window.onFilerChange;
    window.onFilerChange = function(chunk) {
        if (origOnFilerChange) origOnFilerChange(chunk);

        // 如果当前在 Git 视图上且面板可见，debounce 后刷新
        if (window.filerView === 'gitdiff' && gitDiffPanel && gitDiffPanel.style.display !== 'none') {
            clearTimeout(window._gitDiffRefreshTimer);
            window._gitDiffRefreshTimer = setTimeout(loadGitStatus, 1500);
        } else {
            // 不在 Git 视图上，后台静默刷新 badge
            clearTimeout(window._gitBadgeRefreshTimer);
            window._gitBadgeRefreshTimer = setTimeout(loadGitStatus, 2000);
        }
    };

    // ---- 工具函数 ----
    function escapeHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    // ---- 初始化 ----
    loadGitStatus();
    // 每 60 秒兜底刷新。原先无条件常驻：窗口收入托盘后仍周期性唤醒渲染进程并发起后端请求。
    // 现改为：不可见时停表，恢复可见时先立即补一次（避免展示陈旧状态）再重开周期。
    var gitPollTimer = null;
    function startGitPoll() { if (!gitPollTimer) gitPollTimer = setInterval(loadGitStatus, 60000); }
    function stopGitPoll() { if (gitPollTimer) { clearInterval(gitPollTimer); gitPollTimer = null; } }
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) { stopGitPoll(); return; }
        loadGitStatus();
        startGitPoll();
    });
    if (!document.hidden) startGitPoll();

    // 暴露全局（供 app-filer.js / app-message.js 调用）
    window.loadGitStatus = loadGitStatus;
    window.openFileViewer = openFileViewer;
    window.closeDiffViewer = closeDiffViewer;
    window.guessLang = guessLang;
})();
