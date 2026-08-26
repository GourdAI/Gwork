/* ===== app-monaco.js ===== */
/* Monaco Editor 共享加载器：AMD 异步加载 vs/editor/editor.main，
   供 app-code.js（Code 编辑器）与 app-gitdiff.js（Diff/文件查看器）共用。
   依赖：index.html 已静态引入 /monaco/loader.js（AMD loader）。
   editor.main 加载完成后会自动：设置 window.monaco、注入 editor.main.css、
   配置 MonacoEnvironment.getWorker（blob + importScripts 同源加载 worker chunk）。 */
(function () {
    var monaco = null;            // window.monaco（editor.main 加载完成后设置）
    var callbacks = [];
    var started = false;

    function flush(args) {
        var cbs = callbacks;
        callbacks = [];
        for (var i = 0; i < cbs.length; i++) {
            try { cbs[i].apply(null, args); } catch (e) { console.error('[monaco] 回调异常', e); }
        }
    }

    function load(cb) {
        if (monaco) { if (cb) cb(monaco); return; }
        if (typeof cb === 'function') callbacks.push(cb);
        if (started) return;
        started = true;
        if (typeof require === 'undefined' || !require.config) {
            // AMD loader 缺失（资源损坏）：清空队列，调用方按 __monacoGet()===null 兜底
            flush([]);
            return;
        }
        try {
            require.config({ paths: { vs: '/monaco' } });
            require(['vs/editor/editor.main'], function () {
                monaco = window.monaco || null;
                if (monaco && monaco.editor && monaco.editor.defineTheme) {
                    // 自定义主题：以 vs / vs-dark 为底，仅覆盖代码区背景为应用主题背景色
                    // （light --bg-primary #ffffff；dark --bg-main #1a1b1e），其余 token 色沿用底座。
                    monaco.editor.defineTheme('gwork-light', { base: 'vs', inherit: true, rules: [], colors: { 'editor.background': '#ffffff' } });
                    monaco.editor.defineTheme('gwork-dark', { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#1a1b1e' } });
                }
                if (monaco && monaco.editor && monaco.editor.tokenize) {
                    initBalanceChecker(monaco);
                }
                flush(monaco ? [monaco] : []);
            }, function (err) {
                console.error('[monaco] 加载失败', err);
                flush([]);
            });
        } catch (e) {
            console.error('[monaco] 初始化异常', e);
            flush([]);
        }
    }

    // 主题名：跟随应用 body[data-theme]（light → gwork-light，dark → gwork-dark，均为自定义主题见 load 回调）
    window.__monacoThemeName = function () {
        return document.body.getAttribute('data-theme') === 'dark' ? 'gwork-dark' : 'gwork-light';
    };
    // Monaco 等宽字体：与主题变量 --font-mono 同栈（Monaco 不支持 CSS 变量，直接写栈）
    window.__monacoFontFamily = '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace';

    window.__monacoLoad = load;
    window.__monacoGet = function () { return monaco; };

    // ---------- 文件类型 → Monaco 语言 id（basic-languages 全集 + 常用兜底映射）----------
    var MONACO_LANG_MAP = {
        js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
        ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
        json: 'json', jsonc: 'json', html: 'html', htm: 'html', xhtml: 'html',
        css: 'css', scss: 'scss', less: 'less',
        xml: 'xml', svg: 'xml', xsl: 'xml', xslt: 'xml',
        java: 'java', kt: 'kotlin', kts: 'kotlin',
        py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
        c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
        cs: 'csharp', fs: 'fsharp', fsx: 'fsharp', scala: 'scala', clj: 'clojure',
        ex: 'elixir', exs: 'elixir',
        php: 'php', dart: 'dart', swift: 'swift', lua: 'lua',
        sql: 'sql', pgsql: 'pgsql',
        sh: 'shell', bash: 'shell', zsh: 'shell', bat: 'bat', cmd: 'bat', ps1: 'powershell',
        yaml: 'yaml', yml: 'yaml', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', toml: 'ini',
        md: 'markdown', markdown: 'markdown', mdx: 'mdx',
        r: 'r', pl: 'perl', pm: 'perl', proto: 'protobuf',
        graphql: 'graphql', gql: 'graphql',
        vue: 'html', svelte: 'html',
        txt: 'plaintext', log: 'plaintext'
    };

    // 扩展名/文件名 → { langId, label }。供 app-code.js（编辑器）与 app-gitdiff.js（diff/文件查看器）共用。
    window.__monacoGuessLang = function (fileName) {
        if (!monaco) return { langId: 'plaintext', label: '' };
        var name = (fileName || '').replace(/.*\//, '');
        var lower = name.toLowerCase();
        var langId = 'plaintext';
        var label = '';
        if (lower === 'makefile' || lower === 'gnumakefile' || lower === 'cmakelists.txt') {
            langId = 'shell'; label = 'Makefile';
        } else if (lower === 'dockerfile') {
            langId = 'dockerfile'; label = 'Dockerfile';
        } else if (lower === '.gitignore' || lower === '.gitattributes' || lower === '.editorconfig' || lower === '.npmrc') {
            langId = 'shell'; label = 'Shell';
        } else {
            var ext = (lower.indexOf('.') >= 0) ? lower.replace(/.*\./, '') : '';
            if (ext && MONACO_LANG_MAP[ext]) langId = MONACO_LANG_MAP[ext];
        }
        if (langId !== 'plaintext') {
            var langs = monaco.languages.getLanguages() || [];
            for (var i = 0; i < langs.length; i++) {
                if (langs[i].id === langId) {
                    label = (langs[i].aliases && langs[i].aliases[0]) || langId;
                    break;
                }
            }
            if (!label) label = langId;
        }
        return { langId: langId, label: label };
    };

    // ---------- 通用语法平衡检查（非语言服务语言的兜底诊断）----------
    // Monaco 自带语言服务仅覆盖 javascript/typescript/css/scss/less/html/json 等，其余语言
    // （java/python/shell/c/cpp/go/rust…）只有语法着色、没有报错告警。这里用 Monaco 自带的
    // tokenizer 区分「代码 / 字符串 / 注释」，仅对代码区做括号与引号平衡检查，给所有语言
    // 提供基础的语法错误提示（未闭合括号/引号、多余闭合、错配）。语义级检查（类型错误等）
    // 不在其列，由语言服务承担。
    var LS_LANGS = { javascript: 1, typescript: 1, css: 1, scss: 1, less: 1, html: 1, handlebars: 1, razor: 1, json: 1, plaintext: 1 };
    var BALANCE_MAX_CHARS = 500000;   // 超过 50 万字符不检查，避免大文件卡顿
    var BALANCE_MAX_MARKERS = 24;     // 单文件最多报 24 条，防止刷屏
    var BALANCE_DEBOUNCE_MS = 600;

    function balanceMarker(monaco, line, col, msg) {
        return {
            severity: monaco.MarkerSeverity.Error,
            startLineNumber: line, startColumn: col,
            endLineNumber: line, endColumn: col + 1,
            message: msg, source: 'gwork'
        };
    }

    function scanBalanceTokens(monaco, langId, text) {
        var markers = [];
        var stack = [];                       // 未闭合项：{ch, line, col}
        var pairs = { ')': '(', ']': '[', '}': '{' };
        var lines = text.split('\n');
        var lineTokens = monaco.editor.tokenize(text, langId);
        for (var ln = 0; ln < lineTokens.length && markers.length < BALANCE_MAX_MARKERS; ln++) {
            var line = lines[ln] || '';
            var tokens = lineTokens[ln];
            for (var ti = 0; ti < tokens.length; ti++) {
                var tk = tokens[ti];
                var type = tk.type || '';
                // 字符串/注释内的字符一律跳过（tokenizer 已分类；跨行字符串由 tokenize 的 state 传递处理）
                if (type.indexOf('string') >= 0 || type.indexOf('comment') >= 0) continue;
                var seg = line.substring(tk.offset, ti + 1 < tokens.length ? tokens[ti + 1].offset : line.length);
                for (var ci = 0; ci < seg.length && markers.length < BALANCE_MAX_MARKERS; ci++) {
                    var ch = seg[ci];
                    var col = tk.offset + ci + 1;
                    if (ch === '(' || ch === '[' || ch === '{') {
                        stack.push({ ch: ch, line: ln + 1, col: col });
                    } else if (ch === ')' || ch === ']' || ch === '}') {
                        var open = pairs[ch];
                        var top = stack[stack.length - 1];
                        if (!top) {
                            markers.push(balanceMarker(monaco, ln + 1, col, 'Unexpected "' + ch + '"'));
                        } else if (top.ch !== open) {
                            markers.push(balanceMarker(monaco, ln + 1, col, 'Mismatched "' + ch + '": expected closing for "' + top.ch + '" (line ' + top.line + ')'));
                            stack.pop();
                        } else {
                            stack.pop();
                        }
                    } else if (ch === '"' || ch === "'" || ch === '`') {
                        // 代码区的引号视为开口：与栈顶同型则闭合，否则入栈
                        var top2 = stack[stack.length - 1];
                        if (top2 && top2.ch === ch) stack.pop();
                        else stack.push({ ch: ch, line: ln + 1, col: col });
                    }
                }
            }
        }
        for (var i = 0; i < stack.length && markers.length < BALANCE_MAX_MARKERS; i++) {
            var s = stack[i];
            markers.push(balanceMarker(monaco, s.line, s.col, 'Unclosed "' + s.ch + '"'));
        }
        return markers;
    }

    function initBalanceChecker(monaco) {
        var owner = 'gwork-balance';
        monaco.editor.onDidCreateModel(function (model) {
            var timer = null;
            var sub = model.onDidChangeContent(function () {
                if (timer) clearTimeout(timer);
                timer = setTimeout(check, BALANCE_DEBOUNCE_MS);
            });
            function check() {
                if (model.isDisposed()) return;
                var langId = model.getLanguageId();
                // 语言服务语言与纯文本不参与（前者有完整诊断，后者无意义）；模型语言被切换时同样自动停用
                if (LS_LANGS[langId]) { monaco.editor.setModelMarkers(model, owner, []); return; }
                var text = model.getValue();
                if (text.length > BALANCE_MAX_CHARS) { monaco.editor.setModelMarkers(model, owner, []); return; }
                try {
                    monaco.editor.setModelMarkers(model, owner, scanBalanceTokens(monaco, langId, text));
                } catch (e) {
                    // 语言定义尚未注册（basic-languages 懒加载，tokenize 会抛「unknown language」）：
                    // 先清空，待 onLanguage 注册完成回调再查
                    monaco.editor.setModelMarkers(model, owner, []);
                }
            }
            check();
            // 语言定义多为异步注册（首次用到该语言时才加载）：注册完成后再补查一次
            var langSub = monaco.languages.onLanguage(model.getLanguageId(), check);
            model.onWillDispose(function () { if (timer) clearTimeout(timer); sub.dispose(); langSub.dispose(); });
        });
    }

    // 不在页面加载时预载：Monaco（editor.main + worker + 基础语言包）常驻内存约 30-50MB，
    // 而纯 chat 用户全程用不到编辑器。改为按需加载，触发时机：
    //   ① enterCodeMode()（app-code.js）—— 进入 code 模式即预热，打开首个文件时通常已就绪；
    //   ② openFile / Diff / 文件查看器 —— 均已经 __monacoLoad(cb) 回调入口，未就绪会自动等待。
    // （启动时若 localStorage 恢复到 code 模式，initMode 会调 enterCodeMode，行为等同于原预载。）
})();
