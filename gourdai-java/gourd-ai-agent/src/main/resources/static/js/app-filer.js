/* ===== app-filer.js ===== */
/* 工作区文件树面板（右侧） */

(function() {
    var $panel = $('#filerPanel');
    var $toggleBtn = $('#filerToggleBtn');
    var $treeEl = $('#filerTree');
    var $worknameEl = $('#filerWorkname');
    var $resizeHandle = $('#filerResizeHandle');

    var FILER_MIN_WIDTH = 180;
    var FILER_MAX_WIDTH = 600;
    var FILER_DEFAULT_WIDTH = 280;

    // ---- 同步 toggle 按钮位置 ----
    function syncToggleBtnPosition() {
        if (!$toggleBtn.length || !$panel.length) return;
        var collapsed = $panel.hasClass('collapsed');
        if (collapsed) {
            $toggleBtn.css('right', '4px');
        } else {
            var w = $panel[0].offsetWidth;
            $toggleBtn.css('right', (w - 14) + 'px');
        }
    }

    // ---- 拖拽调整大小 ----
    function initResize() {
        if (!$resizeHandle.length || !$panel.length) return;

        var isDragging = false;
        var startX = 0;
        var startWidth = 0;

        // code 模式：文件树居左，手柄夹在树与编辑器之间（与「编辑器/对话栏」手柄一致）；
        // chat 模式：文件树居右。两种布局的拖拽方向相反。
        function inCodeMode() { return document.body.classList.contains('code-mode'); }

        $resizeHandle.on('mousedown', function(e) {
            // code 模式面板恒为展开态（CSS 强制显示），忽略 collapsed 判断；chat 模式收起时不可拖
            if (!inCodeMode() && $panel.hasClass('collapsed')) return;
            isDragging = true;
            startX = e.clientX;
            startWidth = $panel[0].offsetWidth;
            $resizeHandle.addClass('dragging');
            $(document.body).css({ cursor: 'col-resize', userSelect: 'none' });
            e.preventDefault();
        });

        $(document).on('mousemove', function(e) {
            if (!isDragging) return;
            // 居右(chat)：向左拖 dx>0 变宽；居左(code)：向右拖 dx>0 变宽
            var dx = inCodeMode() ? (e.clientX - startX) : (startX - e.clientX);
            var newWidth = Math.max(FILER_MIN_WIDTH, Math.min(FILER_MAX_WIDTH, startWidth + dx));
            if (inCodeMode()) {
                // code 模式宽度由 --filer-panel-width 变量驱动（CSS 用 !important 固定），
                // 直接改内联 width 会被覆盖，故写变量。
                document.documentElement.style.setProperty('--filer-panel-width', newWidth + 'px');
            } else {
                $panel.css('width', newWidth + 'px');
            }
            localStorage.setItem('filer-width', newWidth);
            syncToggleBtnPosition();
        });

        $(document).on('mouseup', function() {
            if (!isDragging) return;
            isDragging = false;
            $resizeHandle.removeClass('dragging');
            $(document.body).css({ cursor: '', userSelect: '' });
            // code 模式：拖完刷新编辑器布局（Monaco 已随 flex 流式变宽，此处仅触发 layout 校正）
            if (inCodeMode() && typeof window.refreshCodeEditor === 'function') window.refreshCodeEditor();
        });
    }

    // ---- 恢复持久化宽度 ----
    function restoreWidth() {
        if (!$panel.length) return;
        var savedWidth = localStorage.getItem('filer-width');
        if (savedWidth) {
            var w = parseInt(savedWidth, 10);
            if (w >= FILER_MIN_WIDTH && w <= FILER_MAX_WIDTH) {
                $panel.css('width', w + 'px');
                // code 模式宽度走 CSS 变量，同步一份，切到 code 模式即生效
                document.documentElement.style.setProperty('--filer-panel-width', w + 'px');
            }
        }
    }

    // ---- Toggle 折叠 ----
    var $mainHeader = $('.main-header');

    function syncHeaderPadding(collapsed) {
        if (!$mainHeader.length) return;
        if (collapsed) {
            $mainHeader.addClass('filer-collapsed');
        } else {
            $mainHeader.removeClass('filer-collapsed');
        }
    }

    if ($toggleBtn.length) {
        $toggleBtn.on('click', function() {
            $panel.toggleClass('collapsed');
            var collapsed = $panel.hasClass('collapsed');
            $toggleBtn.toggleClass('collapsed', collapsed);
            $toggleBtn.html(collapsed ? '\u2039' : '\u203A');

            localStorage.setItem('filer-collapsed', collapsed ? '1' : '0');
            syncHeaderPadding(collapsed);
            syncToggleBtnPosition();
        });
    }

    // 恢复持久化状态
    restoreWidth();
    var shouldExpand = localStorage.getItem('filer-collapsed') === '0';
    if (shouldExpand) {
        $panel.removeClass('collapsed');
        $toggleBtn.removeClass('collapsed');
        $toggleBtn.html('\u203A');

        syncHeaderPadding(false);
    } else {
        syncHeaderPadding(true);
    }
    syncToggleBtnPosition();
    initResize();

    // ---- 收集当前已展开的目录路径集合 ----
    function collectExpandedPaths() {
        var paths = {};
        if (!$treeEl.length) return paths;
        $treeEl.find('.filer-node-children.open').each(function() {
            var $parent = $(this).parent();
            var dataPath = $parent.attr('data-path');
            if (dataPath) {
                paths[dataPath] = true;
            }
        });
        return paths;
    }

    // ---- Code 模式项目根：拼到 filer 接口的 query（chat 模式为空）----
    function rootParam(sep) {
        if (window.appMode === 'code' && window.currentProjectRoot) {
            return (sep || '&') + 'root=' + encodeURIComponent(window.currentProjectRoot);
        }
        return '';
    }

    // ---- Git 状态着色缓存 ----
    // 数据由 app-gitdiff.js 在 git status 加载成功后推送（window.filerOnGitStatus），
    // 本文件零额外接口请求、零额外 git 进程调用，只做内存查表与 class 切换。
    // files: 文件路径 -> 变更类型（A 新增 / M 修改 / D 删除 / U 未跟踪）
    // dirs:  目录路径 -> 子树内优先级最高的变更类型（目录名一并着色）
    var gitColorCache = null;
    var GIT_TYPE_PRIORITY = { 'D': 3, 'M': 2, 'A': 1, 'U': 1 };

    // 变更类型 -> 颜色 class 后缀（未跟踪视同新增，与 Git 审查面板一致）
    function gitTypeToClass(type) {
        if (type === 'D') return 'deleted';
        if (type === 'M') return 'modified';
        return 'added'; // A / U
    }

    // O(变更文件数 × 路径深度) 构建缓存；目录染色仅需一次查表，无逐目录递归
    function buildGitColorCache(files) {
        var cache = { files: {}, dirs: {} };
        (files || []).forEach(function(f) {
            var p = f && f.path;
            var t = f && f.type;
            if (!p || !t) return;
            cache.files[p] = t;
            // 沿路径向上聚合祖先目录状态（取优先级最高者）
            var idx = p.lastIndexOf('/');
            var dir = idx > 0 ? p.substring(0, idx) : '';
            while (dir) {
                var prev = cache.dirs[dir];
                if (!prev || (GIT_TYPE_PRIORITY[t] || 0) > (GIT_TYPE_PRIORITY[prev] || 0)) {
                    cache.dirs[dir] = t;
                }
                var next = dir.lastIndexOf('/');
                dir = next > 0 ? dir.substring(0, next) : '';
            }
        });
        return cache;
    }

    // 节点查表：文件精确匹配，目录直接取子树聚合结果（O(1)）
    function gitColorOf(path, nodeType) {
        if (!gitColorCache) return null;
        return nodeType === 'directory' ? gitColorCache.dirs[path] : gitColorCache.files[path];
    }

    // 只操作 class 列表：无状态变化时 jQuery 不会触碰 attribute，不触发重排
    function setGitColorClass($nameEl, statusType) {
        $nameEl.removeClass('filer-git-modified filer-git-added filer-git-deleted');
        if (statusType) $nameEl.addClass('filer-git-' + gitTypeToClass(statusType));
    }

    // 全树重套色：仅在 git status 推送时调用一次，O(节点数) 纯查表
    function applyGitColorsToTree() {
        if (!$treeEl.length) return;
        $treeEl.find('.filer-node').each(function() {
            var $el = $(this);
            var st = gitColorOf($el.attr('data-path') || '', $el.attr('data-type') || '');
            setGitColorClass($el.children('.filer-node-row').children('.filer-node-name'), st);
        });
    }

    // 由 app-gitdiff.js 在 status 加载成功后推送；提交/暂存操作后颜色随其刷新自动更新
    window.filerOnGitStatus = function(files) {
        gitColorCache = buildGitColorCache(files);
        applyGitColorsToTree();
    };

    // ---- 加载文件树 ----
    function loadTree() {
        // 切项目/重载：清空旧项目着色缓存（新项目状态由 gitdiff 推送后自动套色）
        gitColorCache = null;
        // Code 模式且未选项目时，不请求（清空树）
        if (window.appMode === 'code' && !window.currentProjectRoot) {
            if ($treeEl.length) $treeEl.html('');
            return;
        }
        $.get('/web/chat/filer/tree?depth=1' + rootParam(), function(res) {
            var data = (res && res.data) ? res.data : [];
            if ($treeEl.length) renderTree(data, $treeEl, 0);
        }).fail(function(jqXHR, textStatus, error) {
            console.error('[filer] load error', error);
        });
    }

    // ---- 清空文件树（切项目/退出 code 模式）----
    function clearFilerTree() {
        gitColorCache = null; // 防旧项目状态误染新树
        if ($treeEl.length) $treeEl.html('');
    }
    window.clearFilerTree = clearFilerTree;

    // ---- 渲染树节点 ----
    function renderTree(nodes, $container, indent) {
        $container.html('');
        nodes.forEach(function(node) {
            appendNode(node, $container, indent);
        });
    }

    // ---- IDEA 风格紧凑目录：单子目录链折叠为单行（a \ b \ c） ----
    // 后端 buildTree 会把「仅含一个子目录」的链折叠为一个节点（name 以 " \ " 拼接、path 指向链尾）；
    // 前端再对 depth=1 返回的子层做同样折叠（懒加载场景），任一层出现兄弟节点即断开、恢复逐层展示。
    function collapseChain(node, $container, indent) {
        var cur = node;
        var names = [cur.name];
        while (cur.type === 'directory' && cur.expanded && cur.children
            && cur.children.length === 1 && cur.children[0].type === 'directory') {
            cur = cur.children[0];
            names.push(cur.name);
        }
        if (names.length > 1) {
            var collapsed = {
                name: names.join(' \\ '),
                path: cur.path,
                type: 'directory',
                expanded: true,
                children: cur.children || null
            };
            appendNode(collapsed, $container, indent);
            return;
        }
        appendNode(node, $container, indent);
    }

    // ---- 渲染并追加单个节点 ----
    function appendNode(node, $container, indent) {
        var $nodeEl = $('<div>').addClass('filer-node')
            .attr('data-indent', indent)
            .attr('data-path', node.path)
            .attr('data-type', node.type);
        // 缩进用 CSS 变量按绝对层级驱动（配合 .filer-node-row 的 calc），
        // 不再依赖 [data-indent="n"] 逐级硬编码，任意深度均可正确缩进。
        $nodeEl[0].style.setProperty('--filer-depth', String(indent));

        var $row = $('<div>').addClass('filer-node-row');

        if (node.type === 'directory') {
            var $arrow = $('<span>').addClass('filer-arrow')
                .toggleClass('open', !!node.expanded)
                .html('<svg width="12" height="12" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>');
            $row.append($arrow);
        } else {
            // 文件行不再插入隐形占位符：图标直接占据行首槽位，
            // 与目录行的箭头同列对齐（槽宽由 CSS 统一为 16px + 5px margin）。
            var $icon = $('<span>').addClass('filer-node-icon filer-icon-file')
                .html('<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 1.5h4.75L12.5 5.75V13.5a1 1 0 01-1 1H4a1 1 0 01-1-1V2.5a1 1 0 011-1z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/><path d="M8.75 1.5v4.25H12.5" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg>');
            $row.append($icon);
        }

        var $name = $('<span>').addClass('filer-node-name')
            .text(node.name);
        // 渲染时查表套色：新渲染节点零额外 DOM 遍历
        var nameStatus = gitColorOf(node.path, node.type);
        if (nameStatus) $name.addClass('filer-git-' + gitTypeToClass(nameStatus));
        $row.append($name);

        $nodeEl.append($row);

        if (node.type === 'directory') {
            var $childrenEl = $('<div>').addClass('filer-node-children')
                .toggleClass('open', !!node.expanded);
            if (node.expanded && node.children) {
                node.children.forEach(function(child) {
                    collapseChain(child, $childrenEl, indent + 1);
                });
            }
            $nodeEl.append($childrenEl);
        }

        // 单击：目录展开/折叠；双击：文件打开查看器
        if (node.type === 'directory') {
            (function(n, $ne) {
                $row.on('click', function(e) {
                    e.stopPropagation();
                    var $cEl = $ne.children('.filer-node-children');
                    var $aEl = $row.find('.filer-arrow');
                    if (!$cEl.length) return;

                    var isOpen = $cEl.hasClass('open');
                    if (isOpen) {
                        $cEl.removeClass('open');
                        $aEl.removeClass('open');
                    } else {
                        $cEl.addClass('open');
                        $aEl.addClass('open');
                        // dirty 标记或无子节点时，展开后重新拉取最新数据
                        var isDirty = $ne.attr('data-dirty') === '1';
                        if (isDirty || !$cEl.children().length) {
                            $ne.removeAttr('data-dirty');
                            $.get('/web/chat/filer/tree?path=' + encodeURIComponent(n.path) + '&depth=1' + rootParam(), function(res) {
                                var subData = (res && res.data) ? res.data : [];
                                // 重新拉取前清空旧节点，避免追加式刷新导致同级节点重复渲染
                                $cEl.empty();
                                subData.forEach(function(child) {
                                    collapseChain(child, $cEl, indent + 1);
                                });
                            });
                        }
                    }
                });
            })(node, $nodeEl);
        } else {
            // 文件：双击打开文件查看器
            (function(n) {
                $row.on('dblclick', function(e) {
                    e.stopPropagation();
                    if (typeof window.openFileViewer === 'function') {
                        window.openFileViewer(n.path, n.name);
                    }
                });
            })(node);
        }

        $container.append($nodeEl);
    }

    // ---- 文件变更实时同步 ----
    function onFilerChange(chunk) {
        if (!chunk || !chunk.changes || chunk.changes.length === 0) return;

        // 文件树为空时，直接全量刷新根目录兜底
        if (!$treeEl.length || !$treeEl.children().length) {
            smartRefreshRoot();
            showFilerChangeIndicator();
            return;
        }

        var changes = chunk.changes;

        // 收集所有受影响的父目录
        var affectedDirs = {};
        changes.forEach(function(path) {
            var lastSlash = path.lastIndexOf('/');
            var parentDir = lastSlash > 0 ? path.substring(0, lastSlash) : '';
            affectedDirs[parentDir] = true;
        });

        // 逐个刷新受影响的目录
        Object.keys(affectedDirs).forEach(function(dirPath) {
            refreshDirectory(dirPath);
        });

        showFilerChangeIndicator();
    }

    function refreshDirectory(dirPath) {
        if (!dirPath) {
            // 根目录变化：智能刷新，保留已展开目录的展开状态
            smartRefreshRoot();
            return;
        }

        if (!$treeEl.length) return;
        var selector = '.filer-node[data-path="' + CSS.escape(dirPath) + '"]';
        var $nodeEl = $treeEl.find(selector);
        if (!$nodeEl.length) return;

        var $childrenEl = $nodeEl.children('.filer-node-children');
        if (!$childrenEl.length) return;

        var isExpanded = $childrenEl.hasClass('open');
        if (!isExpanded) {
            // 折叠的目录标记为 dirty，下次展开时重新拉取最新数据
            $nodeEl.attr('data-dirty', '1');
            return;
        }

        var indent = parseInt($nodeEl.attr('data-indent') || '0', 10);
        $.get('/web/chat/filer/tree?path=' + encodeURIComponent(dirPath) + '&depth=1' + rootParam(), function(res) {
            var subData = (res && res.data) ? res.data : [];
            // 先收集已展开的子目录，刷新后恢复
            var expandedPaths = {};
            $childrenEl.find('.filer-node-children.open').each(function() {
                var $parent = $(this).parent();
                var dataPath = $parent.attr('data-path');
                if (dataPath) {
                    expandedPaths[dataPath] = true;
                }
            });
            // 重新拉取前清空旧节点，避免追加式刷新导致同级节点重复渲染
            $childrenEl.empty();
            subData.forEach(function(child) {
                collapseChain(child, $childrenEl, indent + 1);
            });
            // 恢复子目录展开状态（异步重新拉取数据）
            Object.keys(expandedPaths).forEach(function(expandedPath) {
                var expSelector = '.filer-node[data-path="' + CSS.escape(expandedPath) + '"]';
                var $expNodeEl = $childrenEl.find(expSelector);
                if ($expNodeEl.length) {
                    var $expChildrenEl = $expNodeEl.children('.filer-node-children');
                    var $expArrow = $expNodeEl.children('.filer-node-row').find('.filer-arrow');
                    var expIndent = parseInt($expNodeEl.attr('data-indent') || '0', 10);
                    if ($expChildrenEl.length) {
                        $expChildrenEl.addClass('open');
                        $expArrow.addClass('open');
                        $.get('/web/chat/filer/tree?path=' + encodeURIComponent(expandedPath) + '&depth=1' + rootParam(), function(res2) {
                            var subData2 = (res2 && res2.data) ? res2.data : [];
                            subData2.forEach(function(child) {
                                collapseChain(child, $expChildrenEl, expIndent + 1);
                            });
                        });
                    }
                }
            });
        }).fail(function(jqXHR, textStatus, error) {
            console.error('[filer] refresh error', dirPath, error);
        });
    }

    /**
     * 智能刷新根树：重新拉取根层节点，但保留已展开目录的展开状态
     */
    function smartRefreshRoot() {
        var expandedPaths = collectExpandedPaths();

        $.get('/web/chat/filer/tree?depth=1' + rootParam(), function(res) {
            var newData = (res && res.data) ? res.data : [];
            if (!$treeEl.length) return;

            $treeEl.html('');
            newData.forEach(function(node) {
                if (expandedPaths[node.path] && node.type === 'directory') {
                    node.expanded = true;
                }
                collapseChain(node, $treeEl, 0);
            });

            // 对之前已展开的目录，重新拉取子节点
            Object.keys(expandedPaths).forEach(function(dirPath) {
                var selector = '.filer-node[data-path="' + CSS.escape(dirPath) + '"]';
                var $nodeEl = $treeEl.find(selector);
                if (!$nodeEl.length) return;
                var $childrenEl = $nodeEl.children('.filer-node-children');
                if (!$childrenEl.length) return;
                var indent = parseInt($nodeEl.attr('data-indent') || '0', 10);

                $.get('/web/chat/filer/tree?path=' + encodeURIComponent(dirPath) + '&depth=1' + rootParam(), function(res2) {
                    var subData = (res2 && res2.data) ? res2.data : [];
                    subData.forEach(function(child) {
                        collapseChain(child, $childrenEl, indent + 1);
                    });
                });
            });
        }).fail(function(jqXHR, textStatus, error) {
            console.error('[filer] smart refresh root error', error);
        });
    }

    function showFilerChangeIndicator() {
        // 文件视图切换按钮已移到左侧主侧边栏（.filer-view-btn[data-view="files"]）
        var $filesTab = $('.filer-view-btn[data-view="files"]');
        if (!$filesTab.length) return;
        var $dot = $filesTab.find('.filer-change-dot');
        if (!$dot.length) {
            $dot = $('<span>').addClass('filer-change-dot');
            $filesTab.append($dot);
        }
        $dot.addClass('active');
        setTimeout(function() { $dot.removeClass('active'); }, 2000);
    }

    // ---- 暴露全局函数 ----
    window.loadTree = loadTree;
    window.onFilerChange = onFilerChange;

    // ---- 搜索（后端全量搜索） ----
    var $searchInput = $('#filerSearchInput');
    var $searchClear = $('#filerSearchClear');
    var searchResultsEl = null;

    function ensureSearchResultsContainer() {
        if (!searchResultsEl && $treeEl.length) {
            searchResultsEl = $('<div>').addClass('filer-search-results');
            $treeEl.after(searchResultsEl);
        }
    }

    function escapeHtml(text) {
        return $('<div>').text(text || '').html();
    }

    function showSearchResults(keyword) {
        if (!$treeEl.length || !keyword) return;
        var kw = keyword.trim().toLowerCase();
        if (!kw) { hideSearchResults(); return; }

        $treeEl.hide();
        ensureSearchResultsContainer();
        searchResultsEl.show();
        searchResultsEl.html('<div class="filer-search-loading">' + GourdI18n.t('filer.searching') + '</div>');

        $.get('/web/chat/filer/search?keyword=' + encodeURIComponent(kw) + rootParam(), function(res) {
            var data = (res && res.data) ? res.data : [];
            searchResultsEl.html('');

            if (data.length === 0) {
                searchResultsEl.html('<div class="filer-search-empty">' + GourdI18n.t('filer.no_results') + '</div>');
                return;
            }

            data.forEach(function(item) {
                var $row = $('<div>').addClass('filer-search-item')
                    .attr('data-path', item.path)
                    .attr('data-name', item.name)
                    .attr('data-type', item.type);

                // 图标
                var $icon = $('<span>').addClass('filer-search-item-icon');
                if (item.type === 'directory') {
                    $icon.html('<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4a1 1 0 011-1h3.5l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg>');
                } else {
                    $icon.html('<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 1.5h4.75L12.5 5.75V13.5a1 1 0 01-1 1H4a1 1 0 01-1-1V2.5a1 1 0 011-1z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/><path d="M8.75 1.5v4.25H12.5" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg>');
                }
                $row.append($icon);

                // 路径显示（高亮匹配部分）
                var $pathSpan = $('<span>').addClass('filer-search-item-path');
                var pathLower = item.path.toLowerCase();
                var idx = pathLower.indexOf(kw);
                if (idx >= 0) {
                    $pathSpan.html(escapeHtml(item.path.substring(0, idx))
                        + '<mark>' + escapeHtml(item.path.substring(idx, idx + kw.length)) + '</mark>'
                        + escapeHtml(item.path.substring(idx + kw.length)));
                } else {
                    $pathSpan.text(item.path);
                }
                $row.append($pathSpan);

                // 双击：打开文件查看器
                if (item.type === 'file') {
                    (function(it, $r) {
                        $r.on('dblclick', function(e) {
                            e.stopPropagation();
                            if (typeof window.openFileViewer === 'function') {
                                window.openFileViewer(it.path, it.name);
                            }
                        });
                    })(item, $row);
                }

                searchResultsEl.append($row);
            });
        }).fail(function(jqXHR, textStatus, error) {
            console.error('[filer] search error', error);
            searchResultsEl.html('<div class="filer-search-empty">' + GourdI18n.t('filer.search_failed') + '</div>');
        });
    }

    function hideSearchResults() {
        if ($treeEl.length) $treeEl.css('display', '');
        if (searchResultsEl) searchResultsEl.hide();
    }

    if ($searchInput.length) {
        var searchTimer = null;
        $searchInput.on('input', function() {
            var val = $searchInput.val();
            if ($searchClear.length) {
                $searchClear.toggleClass('visible', val.length > 0);
            }
            clearTimeout(searchTimer);
            searchTimer = setTimeout(function() {
                if (val.trim()) {
                    showSearchResults(val);
                } else {
                    hideSearchResults();
                }
            }, 250);
        });
    }
    if ($searchClear.length) {
        $searchClear.on('click', function() {
            if ($searchInput.length) {
                $searchInput.val('');
                $searchInput.trigger('focus');
            }
            $searchClear.removeClass('visible');
            hideSearchResults();
        });
    }

    // ---- 启动 ----
    // ---- 启动 ----
    // 文件树是 Code 模式专属；chat 模式（默认）不请求，避免无谓的树加载。
    // 进入 Code 模式时由 app-code.js 调 window.loadTree() 触发。
    if (window.appMode === 'code' && window.currentProjectRoot) {
        loadTree();
    }
})();
