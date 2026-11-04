/**
 * app-skills.js — 技能管理独立主视图（2026-10 重构版）
 *
 * 形态对齐 WorkBuddy 技能页：
 *  - 顶栏标签页：已安装 + 各市场（skillhub / clawhub / modelscope，来自 /web/settings/skills/markets）；
 *  - 市场视图：分类筛选 chips + 卡片网格（图标/名称/描述/下载量），卡片点击开详情弹窗；
 *  - 详情弹窗：图标 + 名称 + 安装按钮 + 描述 + 标签 + 版本/下载量统计；
 *  - 安装统一落全局区（不再选作用域），卡片「+」与弹窗「安装」均一键安装；
 *  - 已安装视图：卡片带启禁用开关（改写 SKILL.md frontmatter enabled）与悬浮卸载按钮。
 *
 * 后端接口：
 *   GET  /web/settings/skills/markets                      — 市场列表（标签页）
 *   GET  /web/settings/skills/categories?marketName=       — 市场分类（筛选 chips）
 *   GET  /web/settings/skills/proxy?action=&q=&cursor=&limit=&marketName=&category= — 列表/搜索
 *   GET  /web/settings/skills/detail?slug=&marketName=     — 技能详情（弹窗）
 *   GET  /web/settings/skills/installed                    — 已安装列表（含 enabled/icon/market）
 *   GET  /web/settings/skills/icon?url=                    — 市场图标代理
 *   POST /web/settings/skills/install    {slug, marketName}         — 安装（统一全局区）
 *   POST /web/settings/skills/uninstall  {scope, skillName}         — 卸载
 *   POST /web/settings/skills/toggle     {skillName, enabled, scope} — 启禁用
 *
 * 依赖：layui.js（jQuery）、app-base.js、app-i18n.js（GourdI18n）
 * 协同：app-history.js（commandList / loadCommands）
 */
(function () {
    'use strict';

    // ==================== 常量 ====================

    var SKILLS_API_BASE = '/web/settings/skills/proxy';
    var VIEW_INSTALLED = 'installed';

    /** 市场名 → 标签页展示名（市场 name 是域名，直接展示不友好） */
    var MARKET_LABELS = {
        'skillhub.cn': 'SkillHub',
        'clawhub.ai': 'ClawHub',
        'modelscope.cn': 'ModelScope'
    };

    // ==================== DOM 引用 ====================

    var $skillsViewTabs = $('#skillsViewTabs');
    var $skillsViewTabsWrap = $('.skills-tabs-wrap');
    var $skillsSearchInput = $('#skillsSearchInput');
    var $skillsSearchClear = $('#skillsSearchClear');
    var $skillsList = $('#skillsList');
    var $skillsLoading = $('#skillsLoading');
    var $skillsError = $('#skillsError');
    var $skillsStatus = $('#skillsStatus');
    var $skillsCategoryBar = $('#skillsCategoryBar');
    var $skillsCategoryBarWrap = $('#skillsCategoryBarWrap');
    var $detailOverlay = $('#skillDetailOverlay');

    // ==================== 状态 ====================

    var _markets = [];              // [{name, description}]
    var _currentView = VIEW_INSTALLED; // 'installed' 或市场 name
    var _categories = [];           // 当前市场的分类列表
    var _currentCategory = '';      // 当前分类 key（'' = 全部）
    var _installedAll = [];         // 已安装技能完整列表（/installed 原始数据）
    var _installedIndex = null;     // 已安装索引：localName -> item；marketKey -> item
    var _currentQuery = null;
    var _nextCursor = null;
    var _pageLimit = 20;
    var _hasMore = true;
    var _isLoadingMore = false;
    var _loadSeq = 0;
    var _seenSlugs = {};
    var _detailCtx = null;          // 弹窗上下文 {slug, market, installed}
    var _marketsLoadFailed = false; // markets 端点失败标记：错误条可点击重试

    // ==================== 工具函数 ====================

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function escapeAttr(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function marketLabel(name) {
        return MARKET_LABELS[name] || name || '';
    }

    /** 数字紧凑展示：12345 -> 12.3k */
    function compactNum(n) {
        if (!n || n <= 0) return '';
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
        return String(n);
    }

    /** 图标 HTML：有 iconUrl 时走后端代理 <img>，加载失败自毁露出首字母底 */
    function iconHtml(iconUrl, displayName, cls) {
        var letter = (displayName || 'SK').substring(0, 2).toUpperCase();
        var img = iconUrl
            ? '<img src="/web/settings/skills/icon?url=' + encodeURIComponent(iconUrl) + '" alt="" onerror="this.remove()">'
            : '';
        return '<div class="' + cls + '"><span>' + escapeHtml(letter) + '</span>' + img + '</div>';
    }

    // ==================== 已安装索引 ====================

    /**
     * 拉取已安装列表并重建索引。
     * 索引键：本地技能名、以及「市场|市场slug」，供市场卡片判断已安装。
     */
    function loadInstalledIndex(callback) {
        $.ajax({
            url: '/web/settings/skills/installed',
            method: 'GET',
            timeout: 15000,
            dataType: 'json'
        }).done(function (resp) {
            var skills = (resp && resp.code === 200 && resp.data) ? resp.data : [];
            _installedAll = skills;
            _installedIndex = {};
            skills.forEach(function (s) {
                _installedIndex['name:' + s.name] = s;
                if (s.market && s.marketSlug) {
                    _installedIndex['market:' + s.market + '|' + s.marketSlug] = s;
                }
            });
            updateInstalledCount();
            // 索引变了就要重算屏幕上的徽标（安装/卸载后都走这里）；
            // 否则卡片会停在旧状态，与「已安装」视图对不上。
            syncInstalledBadges();
            if (callback) callback();
        }).fail(function () {
            _installedAll = [];
            _installedIndex = {};
            updateInstalledCount();
            syncInstalledBadges();
            if (callback) callback();
        });
    }

    function updateInstalledCount() {
        var n = _installedAll.length;
        // 徒标渲染在「已安装」标签内（renderTabs 产出），不另设右上角入口按钮：
        // 旧结构的「已安装」按钮与标签页功能完全重复，且在已安装视图下又多一行返回条，
        // 实测头部高 104px = 两行，第二行仅约 100px 内容、右侧约 1200px 整行空白。
        $('.skills-tab-count').text(n > 0 ? String(n) : '');
    }

    /**
     * 市场条目是否已安装（优先市场元数据精确匹配；回退候选按 slug 形态隔离）。
     *
     * @param {boolean} allowLegacyBare 是否允许用「裸 slug」回退匹配旧版安装记录。
     *        仅当该裸 slug 在本次渲染的列表里【唯一】时才为真（由调用方算好）。
     */
    function findInstalledForMarket(marketName, slug, allowLegacyBare) {
        if (!_installedIndex) return null;
        var hit = _installedIndex['market:' + marketName + '|' + slug];
        if (hit) return hit;
        // 回退候选必须按形态隔离：namespace 限定卡（@owner/s）不得无条件回退到裸尾名，
        // 否则同名技能只要装过任何一个，所有同 slug 卡片会连带误亮「已安装」
        // （上游实测：skillhub 存在不同作者共用同一公开 slug 的记录）。
        // 限定形态的目录名候选与后端 installDirName 口径一致（@ 与 / → _）。
        var qualified = String(slug).charAt(0) === '@' && String(slug).indexOf('/') > 0;
        var candidates;
        if (qualified) {
            candidates = [slug, String(slug).replace(/[@/]/g, '_')];
        } else {
            candidates = [slug, String(slug).replace(/[^a-zA-Z0-9._-]/g, '')];
        }
        for (var i = 0; i < candidates.length; i++) {
            hit = _installedIndex['name:' + candidates[i]];
            if (hit) return hit;
        }
        /* 旧版安装兼容：本次改动之前安装的技能，元数据与目录名都是【裸 slug】
         * （download?slug=bare 由上游解析到某一家，落盘却只有裸名）。
         * 这种记录无法反推作者，故只在「该裸 slug 在本列表唯一」时才认领——
         * 唯一即可确定就是这一家；多卡同裸 slug 时任何认领都是猜测，
         * 宁可不上徽标（用户仍可在已安装视图看到它），也不能回到误亮的老毛病。 */
        if (qualified && allowLegacyBare) {
            var bare = String(slug).substring(String(slug).indexOf('/') + 1);
            hit = _installedIndex['market:' + marketName + '|' + bare];
            if (hit) return hit;
            hit = _installedIndex['name:' + bare];
            if (hit) return hit;
        }
        return null;
    }

    /**
     * 市场 slug 的裸尾形态（{@code @owner/s → s}；裸 slug 原样返回）。
     *
     * <p><b>与后端 {@code WebSettingsController.marketBareSlug} 严格同口径</b>：
     * 分隔符下标必须 {@code > 1}（而不是 {@code > 0}）。首版写的是 {@code > 0}，对
     * {@code @/slug} 这种畸形 slug 前端会剥成 {@code slug}、后端却原样返回，
     * 同一个 slug 在两端算出不同展示名（旧记录兜底时后端下发一个、前端再算另一个）。
     * 正常 {@code @owner/slug} 两条件都命中，差异只在这类边界值上——而边界值上的
     * 「口径一致」注释恰是最容易骗过自己的地方。
     */
    function marketBareSlug(slug) {
        var s = String(slug || '');
        return (s.charAt(0) === '@' && s.indexOf('/') > 1) ? s.substring(s.indexOf('/') + 1) : s;
    }

    /**
     * 统计「裸 slug → 出现次数」，用于判定旧版裸 slug 安装能否安全认领。
     * 必须把已在列表里的卡（无限滚动 append 的旧批次）与新批次一起算：
     * 只算新批次会让「第一页 1 张、第二页又 1 张」的同名技能各自被判为唯一 → 双双误亮。
     */
    function countBareSlugs(incoming) {
        var counts = {};
        var add = function (slug) {
            var bare = marketBareSlug(slug);
            if (!bare) return;
            counts[bare] = (counts[bare] || 0) + 1;
        };
        $skillsList.find('.skill-card:not(.skill-card-installed)').each(function () {
            add($(this).attr('data-slug'));
        });
        (incoming || []).forEach(function (s) {
            add(s && (s.slug || s.name));
        });
        return counts;
    }

    /**
     * 按「当前列表整体」重算所有市场卡的徽标与 + 按钮。
     *
     * <p>为什么不能只在渲染时算一次：旧版裸 slug 安装的认领条件是「裸 slug 在本列表
     * 唯一」，而无限滚动会分批 append——第一页只有 1 张同名卡时判定「唯一」并亮徽标，
     * 第二页又未一张同名卡后前提就崩了。所以每次列表变化（首次渲染/append/
     * 已安装索引刷新）都从 DOM 集重算，保证「同一屏内口径终态一致」。</p>
     */
    function syncInstalledBadges() {
        if (!_installedIndex) return;
        /* 只能作用于市场卡：已安装视图的卡（.skill-card-installed）没有 data-slug，
         * 它们本来就不该有市场徽标，若一并处理会被当成「未安装」而凭空长出一个 + 按钮。 */
        var $cards = $skillsList.find('.skill-card:not(.skill-card-installed)');
        var counts = {};
        $cards.each(function () {
            var bare = marketBareSlug($(this).attr('data-slug'));
            if (bare) counts[bare] = (counts[bare] || 0) + 1;
        });
        $cards.each(function () {
            var $card = $(this);
            var slug = $card.attr('data-slug') || '';
            var market = $card.attr('data-market') || _currentView;
            var installed = !!findInstalledForMarket(market, slug, counts[marketBareSlug(slug)] === 1);

            var $badge = $card.find('.skill-installed-badge');
            if (installed && !$badge.length) {
                $card.find('.skill-card-title').append('<span class="skill-installed-badge">'
                    + escapeHtml(GourdI18n.t('settings.skills.installed')) + '</span>');
            } else if (!installed && $badge.length) {
                $badge.remove();
            }

            // 未安装 → 必须有 + 按钮；已安装 → 必须没有（两者严格互斥）
            var $actions = $card.find('.skill-card-actions');
            if (!installed && !$actions.length) {
                $card.append('<div class="skill-card-actions"><button type="button" class="skill-card-add" data-slug="'
                    + escapeAttr(slug) + '" data-market="' + escapeAttr(market) + '" title="'
                    + escapeAttr(GourdI18n.t('settings.skills.install')) + '">'
                    + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
                    + '</button></div>');
            } else if (installed && $actions.length) {
                $actions.remove();
            }
        });
    }

    // ==================== 标签页与分类 ====================

    function loadMarkets(callback) {
        $.ajax({
            url: '/web/settings/skills/markets',
            method: 'GET',
            timeout: 5000,
            dataType: 'json'
        }).done(function (resp) {
            _markets = (resp && resp.data) ? resp.data : [];
            renderTabs();
            if (callback) callback();
        }).fail(function () {
            _markets = [];
            renderTabs();
            if (callback) callback();
        });
    }

    function renderTabs() {
        var installedCount = _installedAll.length;
        var html = '<button type="button" class="skills-view-tab' + (_currentView === VIEW_INSTALLED ? ' active' : '') + '" data-view="' + VIEW_INSTALLED + '">'
            + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>'
            + '<span>' + escapeHtml(GourdI18n.t('settings.skills.installed_tab')) + '</span>'
            + '<span class="skills-tab-count">' + (installedCount > 0 ? installedCount : '') + '</span></button>';
        _markets.forEach(function (m) {
            html += '<button type="button" class="skills-view-tab' + (_currentView === m.name ? ' active' : '') + '" data-view="' + escapeAttr(m.name) + '">'
                + '<span>' + escapeHtml(marketLabel(m.name)) + '</span></button>';
        });
        $skillsViewTabs.html(html);
    }

    function loadCategories() {
        if (_currentView === VIEW_INSTALLED) {
            hideCategoryBar();
            _categories = [];
            _currentCategory = '';
            return;
        }
        $.ajax({
            url: '/web/settings/skills/categories?marketName=' + encodeURIComponent(_currentView),
            method: 'GET',
            timeout: 5000,
            dataType: 'json'
        }).done(function (resp) {
            _categories = (resp && resp.code === 200 && resp.data) ? resp.data : [];
            renderCategoryBar();
        }).fail(function () {
            _categories = [];
            renderCategoryBar();
        });
    }

    function renderCategoryBar() {
        if (_currentView === VIEW_INSTALLED || !_categories.length) {
            hideCategoryBar();
            return;
        }
        var zh = (GourdI18n.getLocale() || '').indexOf('zh') === 0;
        var html = '<button type="button" class="skills-category-chip' + (_currentCategory === '' ? ' active' : '') + '" data-cat="">'
            + escapeHtml(GourdI18n.t('settings.skills.category_all')) + '</button>';
        _categories.forEach(function (c) {
            var label = (zh && c.nameZh) ? c.nameZh : (c.name || c.key);
            html += '<button type="button" class="skills-category-chip' + (_currentCategory === c.key ? ' active' : '') + '" data-cat="' + escapeAttr(c.key) + '">'
                + escapeHtml(label) + '</button>';
        });
        $skillsCategoryBar.html(html);
        showCategoryBar();
    }

    /**
     * 显示分类栏。
     * 只显 wrap，不动内层 bar：bar 始终 display:flex，
     * 否则隐过一次的 bar 会被留在 display:none 上再也回不来。
     * 新 chips 渲染后宽度变了，必须重算溢出态（左右箭头与渐隐才不会停在旧状态）。
     */
    function showCategoryBar() {
        $skillsCategoryBarWrap.show();
        syncHScrollState($skillsCategoryBar[0]);
    }

    /**
     * 隐藏分类栏：必须隐 wrap（只隐内层 chips 会留下一条空的渐隐带与两个孤箭头），
     * 同时清掉溢出态（含箭头显隐）；内层 bar 仅清空内容、不切 display。
     */
    function hideCategoryBar() {
        $skillsCategoryBar.empty();
        $skillsCategoryBarWrap.hide();
        syncHScrollState($skillsCategoryBar[0]);
    }

    // ==================== 列表加载 ====================

    function appendListFooter(type) {
        $('.skills-list-footer').remove();
        var html = '';
        if (type === 'loading') {
            html = '<div class="skills-list-footer loading">'
                + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>'
                + '<span>' + GourdI18n.t('settings.skills.loading') + '</span>'
                + '</div>';
        } else if (type === 'error') {
            html = '<div class="skills-list-footer error">' + GourdI18n.t('settings.skills.load_failed_retry') + '</div>';
        } else if (type === 'end') {
            html = '<div class="skills-list-footer end">' + GourdI18n.t('settings.skills.no_more') + '</div>';
        }
        if (html) $skillsList.append(html);
    }

    /**
     * 复位「当前列表的加载态」：加载中提示、底部 footer、列表级错误条、append 在途标记。
     *
     * <p><b>为什么必须有这个统一出口</b>：加载态原本只在请求回调里清理，而回调的清理
     * 全部写在「这次请求仍然有效」的分支内部（seq 校验、视图校验之后）。用户在请求在途时
     * 切走视图，回调走到校验就 return 了，清理整段被跳过 —— 于是上一个视图的
     * 「加载中…」永久挂在【新视图】上（用户报障：从技能市场切到已安装，市场还在加载，
     * 已安装这块也显示加载信息）。加载态的生命周期必须由视图切换来收口，不能寄望于
     * 「那个请求一定会回来并且走完清理分支」。</p>
     */
    function resetListStatus() {
        $('.skills-list-footer').remove();
        $skillsLoading.hide();
        _isLoadingMore = false;
        /* 错误条同属「上一次加载」的结果，换视图时一并清掉。
         * 例外：markets 端点整体失败时那条「加载失败，点击重试」是【视图级】恢复入口
         * （此时 _markets 为空、只剩「已安装」标签），清掉用户就再没有重试的路了。 */
        if (_marketsLoadFailed) {
            $skillsStatus.show();
            $skillsError.text(GourdI18n.t('settings.skills.load_failed_retry')).show();
        } else {
            $skillsStatus.hide();
            $skillsError.text('').hide();
        }
    }

    function loadSkillsList(query, append) {
        var isAppend = append === true;

        /* 已安装视图的数据源是本地索引（同步内存），永远不走列表加载。
         * 这是防御守卫：所有调用方（switchView / 搜索 / 分类 / 无限滚动）都已提前拦截，
         * 此处保留仅为封口。注："已安装视图不显示加载态"不能靠这一支保证——
         * 真正保证它的是 switchView 里的 resetListStatus（在切视图那一刻就清）。 */
        if (_currentView === VIEW_INSTALLED) return;

        if (!isAppend) {
            /* 全新加载（首次进入/换分类/搜索）必须从干净状态起步：
             * 清掉上一次加载残留的「加载中…」与 footer，否则会与新加载态叠加。 */
            resetListStatus();
            _nextCursor = null;
            _hasMore = true;
            _seenSlugs = {};
            $skillsList.empty();
        }

        /* 防重入只对「追加下一页」成立：首次/换分类/搜索是用户主动发起的「取代」，
         * 必须允许提掉在途的旧请求（旧请求靠 _loadSeq 作废），否则用户会看到一个
         * 灵异的「点了没反应」。 */
        if (isAppend && _isLoadingMore) return;
        _isLoadingMore = true;
        var mySeq = ++_loadSeq;
        var viewAtRequest = _currentView;

        if (isAppend) {
            appendListFooter('loading');
        } else {
            $skillsStatus.show();
            $skillsLoading.css('display', 'flex');
            $skillsError.hide();
        }

        var url;
        var params = 'limit=' + _pageLimit
            + '&marketName=' + encodeURIComponent(viewAtRequest)
            + ((isAppend && _nextCursor) ? '&cursor=' + encodeURIComponent(_nextCursor) : '')
            + (_currentCategory ? '&category=' + encodeURIComponent(_currentCategory) : '');
        if (query) {
            url = SKILLS_API_BASE + '?action=search&q=' + encodeURIComponent(query) + '&' + params;
        } else {
            url = SKILLS_API_BASE + '?action=trending&' + params;
        }

        $.ajax({
            url: url,
            method: 'GET',
            timeout: 15000,
            dataType: 'json'
        })
            .done(function (resp) {
                // 已有更新的请求接管：加载态归它管，这里不能动
                if (mySeq !== _loadSeq) return;
                if (_currentView !== viewAtRequest || _currentView === VIEW_INSTALLED) {
                    /* 视图已切走 → 结果作废。但 append 在途标记必须复位，
                     * 否则新视图的下一次「加载更多」会被永久拦住。 */
                    _isLoadingMore = false;
                    return;
                }
                if (resp && resp.code !== undefined && resp.code !== 200) {
                    $skillsLoading.hide();
                    $('.skills-list-footer').remove();
                    $skillsError.text(resp.description || GourdI18n.t('settings.operation_failed')).show();
                    if (isAppend) appendListFooter('error');
                    _isLoadingMore = false;
                    return;
                }

                var payload = (resp && resp.code !== undefined && resp.data !== undefined) ? resp.data : resp;
                var skills = [];
                var nextCursor = null;
                if (payload && payload.items !== undefined) {
                    skills = Array.isArray(payload.items) ? payload.items : [];
                    nextCursor = payload.nextCursor || null;
                } else if (Array.isArray(payload)) {
                    skills = payload;
                }

                _hasMore = !!nextCursor && skills.length > 0;
                _nextCursor = nextCursor;

                if (isAppend) {
                    skills = skills.filter(function (s) {
                        var key = dedupeKey(s);
                        return !!key && !_seenSlugs[key];
                    });
                    if (skills.length === 0) {
                        _hasMore = false;
                        _nextCursor = null;
                    }
                }
                skills.forEach(function (s) {
                    _seenSlugs[dedupeKey(s)] = true;
                });

                try {
                    renderMarketCards(skills, isAppend);
                    $('.skills-list-footer').remove();
                    if (!isAppend) {
                        $skillsStatus.hide();
                        $skillsError.hide();
                    }
                    if (_hasMore) {
                        appendListFooter('loading');
                    } else if (isAppend) {
                        appendListFooter('end');
                    }
                } finally {
                    _isLoadingMore = false;
                }
                maybeAutoFill();
            })
            .fail(function (jqXHR, textStatus) {
                if (mySeq !== _loadSeq) return;
                if (_currentView !== viewAtRequest) {
                    _isLoadingMore = false;
                    return;
                }
                $('.skills-list-footer').remove();
                if (!isAppend) $skillsLoading.hide();
                if (isAppend) appendListFooter('error');
                var msg = (textStatus === 'timeout' || jqXHR.status === 0)
                    ? GourdI18n.t('settings.network_error')
                    : GourdI18n.t('settings.operation_failed') + '（HTTP ' + (jqXHR.status || '?') + '）';
                $skillsError.text(msg).show();
                _isLoadingMore = false;
            });
    }

    function dedupeKey(s) {
        var slug = (s && (s.slug || s.name)) || '';
        var owner = (s && (s.ownerHandle || (s.owner && s.owner.handle))) || '';
        return slug ? (slug + '|' + owner) : '';
    }

    // ==================== 渲染：市场卡片 ====================

    function renderMarketCards(skills, append) {
        if (!skills || skills.length === 0) {
            if (!append) renderEmpty();
            return;
        }

        var html = '';
        // 裸 slug 出现次数：决定旧版（裸 slug）安装记录能否被安全认领（详见 findInstalledForMarket）
        var bareCounts = countBareSlugs(skills);
        skills.forEach(function (skill) {
            var slug = skill.slug || skill.name || '';
            var displayName = skill.displayName || slug;
            var desc = skill.summary || skill.description || '';
            var owner = skill.ownerHandle || (skill.owner && skill.owner.handle) || '';
            var installs = skill.installs || 0;
            var stars = skill.stars || 0;
            var allowLegacyBare = bareCounts[marketBareSlug(slug)] === 1;
            var installed = findInstalledForMarket(_currentView, slug, allowLegacyBare);
            html += '<div class="skill-card" data-slug="' + escapeAttr(slug) + '" data-market="' + escapeAttr(_currentView) + '">'
                + iconHtml(skill.iconUrl, displayName, 'skill-card-icon')
                + '<div class="skill-card-body">'
                + '<div class="skill-card-title"><span class="skill-card-name">' + escapeHtml(displayName) + '</span>'
                + (installed ? '<span class="skill-installed-badge">' + escapeHtml(GourdI18n.t('settings.skills.installed')) + '</span>' : '')
                + '</div>'
                + '<div class="skill-card-desc">' + escapeHtml(desc) + '</div>'
                + '<div class="skill-card-meta">'
                + (installs > 0 ? '<span title="' + escapeAttr(GourdI18n.t('settings.skills.downloads')) + '"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' + compactNum(installs) + '</span>' : '')
                + (stars > 0 ? '<span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>' + compactNum(stars) + '</span>' : '')
                + (owner ? '<span>' + escapeHtml(owner) + '</span>' : '')
                + '</div></div>'
                + (installed ? '' :
                    '<div class="skill-card-actions"><button type="button" class="skill-card-add" data-slug="' + escapeAttr(slug) + '" data-market="' + escapeAttr(_currentView) + '" title="' + escapeAttr(GourdI18n.t('settings.skills.install')) + '">'
                    + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
                    + '</button></div>')
                + '</div>';
        });

        if (append) $skillsList.append(html);
        else $skillsList.html(html);

        /* 列表发生变化（首次渲染 / 无限滚动 append / 搜索换批）后重算所有卡的徽标：
         * 「旧版裸 slug 安装可认领」的前提是裸 slug 在【当前整屏】唯一，
         * 只按本批计算会在 append 后与已渲染卡得出不同结论 → 同页自相矛盾。 */
        syncInstalledBadges();
    }

    // ==================== 渲染：已安装卡片 ====================

    function renderInstalledList(query) {
        var skills = _installedAll;
        if (query) {
            var kw = query.toLowerCase();
            skills = skills.filter(function (s) {
                /* 必须同时匹配 displayName：卡片标题显示的是展示名（如「编程专家.Skill」），
                 * 用户只会照着看得见的名字搜。只搜 name（真实目录名 _owner_slug）会出现
                 * 「看着卡片上的名字搜，却搜不到它自己」——恰好是本次修完展示名后新引入的
                 * 不一致。name 仍保留匹配，方便用户按目录名/旧名精确查找。 */
                return (s.displayName || '').toLowerCase().indexOf(kw) !== -1
                    || (s.name || '').toLowerCase().indexOf(kw) !== -1
                    || (s.description || '').toLowerCase().indexOf(kw) !== -1;
            });
        }

        if (!skills || skills.length === 0) {
            renderEmpty();
            return;
        }

        var html = '';
        skills.forEach(function (skill) {
            var name = skill.name || '';
            /* 展示名与操作标识必须分开：
             *  - data-name / data-scope 是卸载与启禁用的定位键，必须是真实目录名；
             *  - 卡片上给用户看的标题优先用市场展示名（否则 namespace 限定 slug
             *    会落成 _owner_slug，用户看到的是个完全陌生的目录名，与安装前对不上）。
             * 无 displayName 时（本地手放技能 / 旧版安装记录）回退目录名，行为不变。 */
            var displayName = skill.displayName || name;
            var desc = skill.description || '';
            var enabled = skill.enabled !== false;
            var scope = skill.scope || 'global';
            var sourceLabel = skill.market ? marketLabel(skill.market) : GourdI18n.t('settings.skills.source_local');

            html += '<div class="skill-card skill-card-installed' + (enabled ? '' : ' skill-card-disabled') + '" data-name="' + escapeAttr(name) + '" data-scope="' + escapeAttr(scope) + '">'
                + iconHtml(skill.iconUrl, displayName, 'skill-card-icon')
                + '<div class="skill-card-body">'
                + '<div class="skill-card-title"><span class="skill-card-name" title="' + escapeAttr(displayName) + '">' + escapeHtml(displayName) + '</span>'
                + (skill.version ? '<span class="skill-installed-badge" style="color:var(--text-secondary);background:var(--bg-hover)">v' + escapeHtml(skill.version) + '</span>' : '')
                + '</div>'
                + '<div class="skill-card-desc">' + escapeHtml(desc) + '</div>'
                + '<div class="skill-card-meta"><span>' + escapeHtml(sourceLabel) + '</span></div>'
                + '</div>'
                + '<div class="skill-card-side">'
                + '<button type="button" class="skill-uninstall-btn" data-name="' + escapeAttr(name) + '" data-scope="' + escapeAttr(scope) + '" title="' + escapeAttr(GourdI18n.t('settings.skills.uninstall')) + '">'
                + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
                + '</button>'
                + '<button type="button" class="skill-toggle' + (enabled ? ' on' : '') + '" data-name="' + escapeAttr(name) + '" data-scope="' + escapeAttr(scope) + '" data-enabled="' + (enabled ? '1' : '0') + '" title="' + escapeAttr(enabled ? GourdI18n.t('settings.skills.disable') : GourdI18n.t('settings.skills.enable')) + '" aria-pressed="' + (enabled ? 'true' : 'false') + '"></button>'
                + '</div></div>';
        });
        $skillsList.html(html);
    }

    function renderEmpty() {
        $skillsList.html(
            '<div class="skill-empty-state">'
            + '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="1.5">'
            + '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'
            + '</svg>'
            + '<div style="font-size:13px;margin-top:12px;">' + GourdI18n.t('common.no_data') + '</div>'
            + '</div>'
        );
    }

    // ==================== 视图切换 ====================

    function switchView(view) {
        if (view !== VIEW_INSTALLED && !_markets.some(function (m) { return m.name === view; })) return;
        if (_currentView === view) return;
        _currentView = view;

        renderTabs();

        /* 视图一换，上一个视图的加载态立刻作废。
         * 这一步是用户报障的直接解药：市场列表还在飞时点「已安装」，
         * 若不在这里清，「加载中…」会一直挂在已安装视图上（且请求回来时
         * 因视图校验直接 return，永远不会有人来清它）。 */
        resetListStatus();

        _currentQuery = null;
        $skillsSearchInput.val('');
        $skillsSearchClear.hide();
        _nextCursor = null;
        _hasMore = true;

        if (view === VIEW_INSTALLED) {
            _currentCategory = '';
            hideCategoryBar();
            loadInstalledIndex(function () {
                renderInstalledList(null);
            });
        } else {
            _currentCategory = '';
            loadCategories();
            loadSkillsList(null, false);
        }
    }

    // ==================== 安装 ====================

    var SPIN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>';
    var PLUS_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

    /**
     * 一键安装（统一全局区，不再选作用域）。
     * @param {jQuery} $btn 触发按钮（卡片 + 或弹窗安装按钮）
     */
    function installSkill(slug, marketName, $btn) {
        if ($btn) $btn.addClass('installing').prop('disabled', true);

        $.ajax({
            url: '/web/settings/skills/install',
            method: 'POST',
            data: { slug: slug, marketName: marketName },
            timeout: 60000,
            dataType: 'json'
        })
        .done(function (resp) {
            var ok = resp && resp.code === 200 && resp.data;
            if (ok) {
                var skillName = (resp.data || slug) + '';
                // 卡片态：加已安装徽标、移除 + 按钮
                var $card = $btn ? $btn.closest('.skill-card') : $();
                if ($card.length) {
                    if (!$card.find('.skill-installed-badge').length) {
                        $card.find('.skill-card-title').append('<span class="skill-installed-badge">' + escapeHtml(GourdI18n.t('settings.skills.installed')) + '</span>');
                    }
                    $card.find('.skill-card-actions').remove();
                }
                if (_detailCtx && _detailCtx.slug === slug && _detailCtx.market === marketName) {
                    _detailCtx.installed = true;
                    var $db = $('#skillDetailInstallBtn');
                    $db.addClass('done').prop('disabled', true).text(GourdI18n.t('settings.skills.installed'));
                }
                loadInstalledIndex(function () {
                    if (typeof loadCommands === 'function') loadCommands();
                });
                if (typeof window.showToast === 'function') {
                    // 动词用技能域的 installed_ok（「安装成功」），不借 loop.created（「已创建」）——
                    // 安装不是创建，错配动词会让用户以为新建了个什么东西
                    window.showToast(GourdI18n.t('app.skills') + '「' + escapeHtml(skillName) + '」' + GourdI18n.t('settings.skills.installed_ok'), 'success');
                }
            } else {
                if ($btn) $btn.removeClass('installing').prop('disabled', false);
                resetDetailInstallBtn(slug, marketName);
                if (typeof window.showToast === 'function') {
                    window.showToast((resp && resp.description) || GourdI18n.t('settings.operation_failed'), 'error');
                }
            }
        })
        .fail(function (jqXHR) {
            if ($btn) $btn.removeClass('installing').prop('disabled', false);
            resetDetailInstallBtn(slug, marketName);
            var msg = GourdI18n.t('settings.loop.create_failed');
            try {
                var err = JSON.parse(jqXHR.responseText);
                if (err && err.description) msg = err.description;
            } catch (e) { /* 非 JSON 响应保留兜底文案 */ }
            if (typeof window.showToast === 'function') window.showToast(msg, 'error');
        });
    }

    /** 安装失败时把弹窗安装按钮从 loading 态恢复（成功态由 _detailCtx 分支处理） */
    function resetDetailInstallBtn(slug, marketName) {
        if (_detailCtx && _detailCtx.slug === slug && _detailCtx.market === marketName && !_detailCtx.installed) {
            $('#skillDetailInstallBtn').removeClass('installing done').prop('disabled', false)
                .text(GourdI18n.t('settings.skills.install'));
        }
    }

    // ==================== 详情弹窗 ====================

    function openDetail(slug, marketName) {
        // 与卡片判定保持同源：详情弹窗不能自己用另一套口径，否则会出现
        // 「卡片亮已安装、点进去安装按钮却能点（或反之）」的自相矛盾。
        // 计数源就是当前列表里已渲染的卡片（openDetail 只可能从卡片点进来）。
        var bareCounts = countBareSlugs([]);
        _detailCtx = {
            slug: slug,
            market: marketName,
            installed: !!findInstalledForMarket(marketName, slug, bareCounts[marketBareSlug(slug)] === 1)
        };

        $detailOverlay.show();
        $('#skillDetailName').text(slug);
        $('#skillDetailOwner').text(marketLabel(marketName));
        $('#skillDetailIcon').html('<span>' + escapeHtml(slug.substring(0, 2).toUpperCase()) + '</span>');
        $('#skillDetailBody').text(GourdI18n.t('settings.skills.loading'));
        $('#skillDetailTags').empty();
        $('#skillDetailStats').empty();
        var $btn = $('#skillDetailInstallBtn');
        $btn.removeClass('done installing').prop('disabled', false).text(GourdI18n.t('settings.skills.install'));
        if (_detailCtx.installed) {
            $btn.addClass('done').prop('disabled', true).text(GourdI18n.t('settings.skills.installed'));
        }

        $.ajax({
            url: '/web/settings/skills/detail?slug=' + encodeURIComponent(slug) + '&marketName=' + encodeURIComponent(marketName),
            method: 'GET',
            timeout: 15000,
            dataType: 'json'
        }).done(function (resp) {
            if (!_detailCtx || _detailCtx.slug !== slug || _detailCtx.market !== marketName) return;
            if (!resp || resp.code !== 200 || !resp.data) {
                $('#skillDetailBody').text((resp && resp.description) || GourdI18n.t('settings.operation_failed'));
                return;
            }
            var d = resp.data;
            var displayName = d.displayName || slug;
            $('#skillDetailName').text(displayName);
            $('#skillDetailOwner').text((d.ownerHandle ? d.ownerHandle + ' · ' : '') + marketLabel(marketName));
            $('#skillDetailIcon').html((d.iconUrl
                ? '<img src="/web/settings/skills/icon?url=' + encodeURIComponent(d.iconUrl) + '" alt="" onerror="this.remove()">'
                : '') + '<span>' + escapeHtml(displayName.substring(0, 2).toUpperCase()) + '</span>');
            $('#skillDetailBody').text(d.description || d.summary || '');

            var tags = Array.isArray(d.tags) ? d.tags : [];
            if (d.category) tags = [d.category].concat(tags);
            if (tags.length) {
                var th = '';
                tags.slice(0, 12).forEach(function (t) {
                    th += '<span class="skill-detail-tag">' + escapeHtml(String(t)) + '</span>';
                });
                $('#skillDetailTags').html(th);
            }

            var sh = '';
            if (d.version) sh += '<div class="skill-detail-stat"><b>v' + escapeHtml(d.version) + '</b><span>' + escapeHtml(GourdI18n.t('settings.skills.version')) + '</span></div>';
            if (d.installs) sh += '<div class="skill-detail-stat"><b>' + compactNum(d.installs) + '</b><span>' + escapeHtml(GourdI18n.t('settings.skills.downloads')) + '</span></div>';
            if (d.stars) sh += '<div class="skill-detail-stat"><b>' + compactNum(d.stars) + '</b><span>' + escapeHtml(GourdI18n.t('settings.skills.stars')) + '</span></div>';
            $('#skillDetailStats').html(sh);
        }).fail(function () {
            if (!_detailCtx || _detailCtx.slug !== slug) return;
            $('#skillDetailBody').text(GourdI18n.t('settings.network_error'));
        });
    }

    function closeDetail() {
        _detailCtx = null;
        $detailOverlay.hide();
    }

    // ==================== 启禁用 / 卸载 ====================

    function toggleSkill($btn) {
        var name = $btn.attr('data-name');
        var scope = $btn.attr('data-scope') || 'global';
        var next = $btn.attr('data-enabled') !== '1';

        $btn.prop('disabled', true);
        $.ajax({
            url: '/web/settings/skills/toggle',
            method: 'POST',
            data: { skillName: name, enabled: next ? 'true' : 'false', scope: scope },
            timeout: 15000,
            dataType: 'json'
        }).done(function (resp) {
            $btn.prop('disabled', false);
            if (resp && resp.code === 200) {
                $btn.toggleClass('on', next).attr('data-enabled', next ? '1' : '0')
                    .attr('title', next ? GourdI18n.t('settings.skills.disable') : GourdI18n.t('settings.skills.enable'))
                    .attr('aria-pressed', next ? 'true' : 'false');
                $btn.closest('.skill-card').toggleClass('skill-card-disabled', !next);
                loadInstalledIndex(function () {
                    if (typeof loadCommands === 'function') loadCommands();
                });
            } else if (typeof window.showToast === 'function') {
                window.showToast((resp && resp.description) || GourdI18n.t('settings.operation_failed'), 'error');
            }
        }).fail(function () {
            $btn.prop('disabled', false);
            if (typeof window.showToast === 'function') window.showToast(GourdI18n.t('settings.operation_failed'), 'error');
        });
    }

    $skillsList.on('click', '.skill-uninstall-btn', function (e) {
        e.stopPropagation();
        var $btn = $(this);
        var name = $btn.attr('data-name') || '';
        var scope = $btn.attr('data-scope') || 'global';

        /* 确认文案必须用用户看得见的名字（展示名），否则卡片写着「编程专家.Skill」、
         * 弹窗却问「确定卸载 _owner_slug 吗」——用户无法确认自己删的是不是那一张。
         * 注意：真正的请求体仍传 name（真实目录名），两者不可互换。 */
        var shownName = $btn.closest('.skill-card').find('.skill-card-name').text();
        layConfirm(GourdI18n.t('settings.skills.uninstall_confirm', [shownName || name]), function () {
            $btn.prop('disabled', true).addClass('removing');
            $.ajax({
                url: '/web/settings/skills/uninstall',
                method: 'POST',
                data: { scope: scope, skillName: name },
                timeout: 30000,
                dataType: 'json'
            })
            .done(function (resp) {
                if (resp && resp.code === 200) {
                    loadInstalledIndex(function () {
                        if (typeof loadCommands === 'function') loadCommands();
                        renderInstalledList(_currentQuery);
                    });
                    if (typeof window.showToast === 'function') {
                        // 同上：提示用展示名，与卡片/确认框保持同一个名字
                        window.showToast(GourdI18n.t('app.skills') + '「' + escapeHtml(shownName || name) + '」' + GourdI18n.t('settings.loop.deleted') + '！', 'success');
                    }
                } else {
                    $btn.prop('disabled', false).removeClass('removing');
                    if (typeof window.showToast === 'function') {
                        window.showToast((resp && resp.description) || GourdI18n.t('settings.operation_failed'), 'error');
                    }
                }
            })
            .fail(function () {
                $btn.prop('disabled', false).removeClass('removing');
                if (typeof window.showToast === 'function') window.showToast(GourdI18n.t('settings.operation_failed'), 'error');
            });
        });
    });

    // ==================== 事件绑定 ====================

    /* ---------- 横向滚轮带：让分类栏/标签栏能被鼠标滚动 ----------
     * 根因（Playwright 实测）：原生 overflow-x 只响应 deltaX 与 shift+wheel，
     * 鼠标滚轮的 deltaY 不会让容器横向滚动（scrollLeft 恒 0），而滚动条又被隐藏，
     * 鼠标用户既滚不动也拖不到 → chips 只能看见前几个。
     * 对策：① deltaY 转横向；② 按住拖拽平移；③ 溢出时给右缘渐隐 + hover 细滚动条。 */

    /**
     * 溢出态同步：一次性驱动【左右箭头可用性 + 箭头显隐 + 左右渐隐】。
     *
     * 为何不用原生 overflow-x：滚轮 deltaY 不产生横滚（实测 scrollLeft 恒 0）、
     * 滚动条又被刻意隐藏（占位会让分类栏高度突增、与顶栏错位），
     * 鼠标用户无路可走 → 必须给出可发现的左右箭头作为主入口。
     * 三个态必须同源计算：各自算一遍会在「刚好滚到底」「窗口缩放到不溢出」等
     * 边界上彼此矛盾（例如箭头已 disabled 但渐隐还挂着）。
     */
    function syncHScrollState(el) {
        if (!el) return;
        var wrap = el.closest ? el.closest('.skills-hscroll-wrap') : null;
        if (!wrap) return;
        var max = el.scrollWidth - el.clientWidth;
        var overflow = max > 1;
        var canLeft = overflow && el.scrollLeft > 1;
        var canRight = overflow && el.scrollLeft < max - 1;
        wrap.classList.toggle('can-scroll-right', canRight);
        wrap.classList.toggle('can-scroll-left', canLeft);
        // 不溢出时整组箭头隐掉（不占位），避免「两个灰色禁用箭头」长期占着布局宽度
        wrap.classList.toggle('has-overflow', overflow);
        var prev = wrap.querySelector('.skills-hscroll-nav.prev');
        var next = wrap.querySelector('.skills-hscroll-nav.next');
        if (prev) prev.disabled = !canLeft;
        if (next) next.disabled = !canRight;
    }

    /**
     * 箭头点击：按「一屏可见宽度的 80%」平移，保留 20% 上下文避免完全断层。
     * 不用 scrollBy({behavior:'smooth'})：在「点到底部后立即点另一头」等快速操作下
     * 平滑动画会与后续点击互相覆盖，且 scroll 事件高频触发会反复重算溢出态。
     * 直接赋值 scrollLeft 由浏览器自行 clamp 到 [0, max]，无需手写边界判断。
     */
    function bindHScrollNav(el) {
        if (!el || el.__hScrollNavBound) return;
        var wrap = el.closest ? el.closest('.skills-hscroll-wrap') : null;
        if (!wrap) return;
        el.__hScrollNavBound = true;
        var step = function () {
            return Math.max(60, Math.round(el.clientWidth * 0.8));
        };
        var prev = wrap.querySelector('.skills-hscroll-nav.prev');
        var next = wrap.querySelector('.skills-hscroll-nav.next');
        if (prev) prev.addEventListener('click', function () {
            el.scrollLeft -= step();
            syncHScrollState(el);
        });
        if (next) next.addEventListener('click', function () {
            el.scrollLeft += step();
            syncHScrollState(el);
        });
    }

    /**
     * 给一个横向溢出容器绑上「滚轮转横向 + 按住拖拽 + 溢出态」。
     * 拖拽与 chip 点击共存：位移超 4px 阈值才当作拖拽，并在捕获阶段
     * 抑制后续的 click，避免「拖完松手顺手选中一个分类」。
     * @param {HTMLElement} el .skills-hscroll 元素
     */
    function bindHScroll(el) {
        if (!el || el.__hScrollBound) return;
        el.__hScrollBound = true;

        // ① 滚轮：deltaY 转横向（触控板原生 deltaX 仍优先生效）
        el.addEventListener('wheel', function (e) {
            var max = el.scrollWidth - el.clientWidth;
            if (max <= 0) return;
            var delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
            if (!delta) return;
            // 已到头则不拦截，让滚轮回归外层（列表继续竖向滚）
            var next = el.scrollLeft + delta;
            if (next <= 0 || next >= max) return;
            e.preventDefault();
            el.scrollLeft = next;
        }, { passive: false });

        el.addEventListener('scroll', function () { syncHScrollState(el); }, { passive: true });

        // ② 按住拖拽平移（鼠标为主；触控/笔走原生滚动不干预）
        var drag = null;
        el.addEventListener('pointerdown', function (e) {
            if (e.pointerType !== 'mouse' || e.button !== 0) return;
            if (el.scrollWidth - el.clientWidth <= 0) return;
            drag = { x: e.clientX, left: el.scrollLeft, moved: false, id: e.pointerId };
        });
        el.addEventListener('pointermove', function (e) {
            if (!drag || e.pointerId !== drag.id) return;
            var dx = e.clientX - drag.x;
            if (!drag.moved && Math.abs(dx) < 4) return;   // 4px 阈值：纯点击不算拖拽
            drag.moved = true;
            el.classList.add('is-dragging');
            el.scrollLeft = drag.left - dx;
        });

        /* 拖拽结束后必须抑制随之而来的 click，否则会选中「拖拽终点下的那个 chip」。
         * suppressClick 在 pointerup（捕获阶段，早于 click）置位；
         * click 处理器也在捕获阶段，所以能在业务委托（$skillsCategoryBar.on('click', ...)）
         * 之前 stopPropagation 拦下。setTimeout 兜底：若浏览器未派发 click（拖出容器松手），
         * 标记也必须自行过期，否则下一次正常点击会被误吞。 */
        var suppressClick = false;
        el.addEventListener('pointerup', function (e) {
            if (!drag || e.pointerId !== drag.id) return;
            var moved = drag.moved;
            drag = null;
            el.classList.remove('is-dragging');
            if (!moved) return;
            suppressClick = true;
            syncHScrollState(el);
            setTimeout(function () { suppressClick = false; }, 0);
        }, true);
        el.addEventListener('pointercancel', function () {
            drag = null;
            el.classList.remove('is-dragging');
        });
        el.addEventListener('pointerleave', function () {
            // 拖出容器：结束拖拽（不抑制 click，因为松手点已不在 chips 上）
            if (!drag) return;
            drag = null;
            el.classList.remove('is-dragging');
        });
        el.addEventListener('click', function (e) {
            if (!suppressClick) return;
            suppressClick = false;
            e.preventDefault();
            e.stopPropagation();
        }, true);

        syncHScrollState(el);
    }

    // 容器尺寸变化（窗口缩放/侧栏折叠/语言切换）后重算溢出态
    if (typeof ResizeObserver === 'function') {
        var _hScrollRO = new ResizeObserver(function (entries) {
            entries.forEach(function (en) { syncHScrollState(en.target); });
        });
        ['#skillsCategoryBar', '#skillsViewTabs'].forEach(function (sel) {
            var el = document.querySelector(sel);
            if (el) { bindHScroll(el); bindHScrollNav(el); _hScrollRO.observe(el); }
        });
    } else {
        ['#skillsCategoryBar', '#skillsViewTabs'].forEach(function (sel) {
            var el = document.querySelector(sel);
            if (el) { bindHScroll(el); bindHScrollNav(el); }
        });
        $(window).on('resize', function () {
            syncHScrollState(document.querySelector('#skillsCategoryBar'));
            syncHScrollState(document.querySelector('#skillsViewTabs'));
        });
    }

    // 视图标签页（已安装 + 各市场）
    $skillsViewTabs.on('click', '.skills-view-tab', function () {
        switchView($(this).attr('data-view'));
    });

    // 分类 chips
    $skillsCategoryBar.on('click', '.skills-category-chip', function () {
        var cat = $(this).attr('data-cat') || '';
        if (cat === _currentCategory) return;
        _currentCategory = cat;
        $skillsCategoryBar.find('.skills-category-chip').removeClass('active');
        $(this).addClass('active');
        loadSkillsList(_currentQuery, false);
    });

    // 卡片「+」一键安装
    $skillsList.on('click', '.skill-card-add', function (e) {
        e.stopPropagation();
        var $btn = $(this);
        if ($btn.hasClass('installing')) return;
        $btn.html(SPIN_SVG);
        installSkill($btn.attr('data-slug'), $btn.attr('data-market'), $btn);
    });

    // 启禁用开关
    $skillsList.on('click', '.skill-toggle', function (e) {
        e.stopPropagation();
        toggleSkill($(this));
    });

    // 市场卡片点击 → 详情弹窗
    $skillsList.on('click', '.skill-card:not(.skill-card-installed)', function () {
        openDetail($(this).attr('data-slug'), $(this).attr('data-market'));
    });

    // 详情弹窗
    $('#skillDetailClose').on('click', closeDetail);
    $detailOverlay.on('click', function (e) {
        if (e.target === this) closeDetail();
    });
    $(document).on('keydown', function (e) {
        if (e.key === 'Escape' && $detailOverlay.is(':visible')) closeDetail();
    });
    $('#skillDetailInstallBtn').on('click', function () {
        if (!_detailCtx || _detailCtx.installed) return;
        var $btn = $(this);
        $btn.addClass('installing').text(GourdI18n.t('settings.skills.loading'));
        installSkill(_detailCtx.slug, _detailCtx.market, null);
        // installSkill 的 $btn 态由 _detailCtx 分支处理弹窗按钮
        $btn.prop('disabled', true);
    });

    // 搜索（回车触发；已安装视图本地过滤）
    $skillsSearchInput.on('input', function () {
        var val = $(this).val().trim();
        $skillsSearchClear.toggle(val.length > 0);
    }).on('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            var val = $(this).val().trim();
            _currentQuery = val || null;
            if (_currentView === VIEW_INSTALLED) {
                renderInstalledList(_currentQuery);
            } else {
                loadSkillsList(_currentQuery, false);
            }
        }
    });
    $skillsSearchClear.on('click', function () {
        $skillsSearchInput.val('').focus();
        $(this).hide();
        _currentQuery = null;
        if (_currentView === VIEW_INSTALLED) renderInstalledList(null);
        else loadSkillsList(null, false);
    });

    // 底部"加载失败，点击重试"
    $skillsList.on('click', '.skills-list-footer.error', function (e) {
        e.stopPropagation();
        loadSkillsList(_currentQuery, true);
    });

    // markets 端点失败时的顶部错误条：点击整体重拉（列表级失败走上面的 footer 重试）
    $skillsError.on('click', function () {
        if (_marketsLoadFailed) {
            _marketsLoadFailed = false;
            resetAndLoad();
        }
    });

    // ==================== 无限滚动 ====================

    function isSkillsViewActive() {
        return $('#skillsView').hasClass('active');
    }

    function tryLoadNextPage() {
        if (!_hasMore || _isLoadingMore) return;
        if (!isSkillsViewActive()) return;
        if (_currentView === VIEW_INSTALLED) return;
        loadSkillsList(_currentQuery, true);
    }

    var _scrollTick = false;
    $('#skillsScroll').on('scroll', function () {
        if (_scrollTick) return;
        _scrollTick = true;
        var el = this;
        requestAnimationFrame(function () {
            _scrollTick = false;
            if (!isSkillsViewActive()) return;
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
                tryLoadNextPage();
            }
        });
    });

    function maybeAutoFill() {
        if (!_hasMore || _isLoadingMore) return;
        if (!isSkillsViewActive()) return;
        var body = document.querySelector('#skillsScroll');
        if (body && body.scrollHeight <= body.clientHeight + 4) {
            loadSkillsList(_currentQuery, true);
        }
    }

    // ==================== 视图入口 ====================

    function resetAndLoad() {
        _currentQuery = null;
        _nextCursor = null;
        _hasMore = true;
        _isLoadingMore = false;
        _currentCategory = '';
        closeDetail();

        loadMarkets(function () {
            if (!_markets.length) {
                // markets 端点失败：不能留白屏——渲染标签页骨架（仅已安装）并给出错误态，
                // 用户仍可进已安装视图管理技能，或点错误条重试
                _marketsLoadFailed = true;
                renderTabs();
                $skillsList.empty();
                $skillsLoading.hide();
                $skillsStatus.show();
                $skillsError.text(GourdI18n.t('settings.skills.load_failed_retry')).show();
                return;
            }
            _marketsLoadFailed = false;
            // 默认进入第一个市场标签页（市场浏览是主场景；已安装是同级的第一个标签）
            var target = _markets[0].name;
            _currentView = VIEW_INSTALLED; // 先置回，保证 switchView 不短路
            switchView(target);
        });
        loadInstalledIndex(null);
    }

    function openSkills() {
        if (typeof window.exitCodeMode === 'function' && window.appMode === 'code') {
            window.exitCodeMode();
        }
        if (typeof window.closeAutomation === 'function') window.closeAutomation();
        if (typeof window.closeChannel === 'function') window.closeChannel();
        if (typeof window.closeModelSettings === 'function') window.closeModelSettings();
        if (typeof window.closeMemoryView === 'function') window.closeMemoryView();
        if (typeof window.closeUsage === 'function') window.closeUsage();
        $('#welcomeView').hide();
        $('#chatView').removeClass('active');
        $('#skillsView').addClass('active');
        $('.main-nav-item').removeClass('active');
        $('#skillsNavBtn').addClass('active');

        window.inChatMode = false;

        if (typeof window.closeSettings === 'function') window.closeSettings();
        else if ($('#settingsOverlay').is(':visible')) $('#settingsCloseBtn').trigger('click');

        resetAndLoad();
    }

    function closeSkills() {
        $('#skillsView').removeClass('active');
        $('#skillsNavBtn').removeClass('active');
    }

    window.openSkills = openSkills;
    window.closeSkills = closeSkills;
    window.isSkillsOpen = function () { return $('#skillsView').hasClass('active'); };

    // 语言切换后重绘当前页（列表内容是动态渲染的，静态翻译无法覆盖）
    document.addEventListener('i18n:localeChanged', function () {
        if ($('#skillsView').hasClass('active')) {
            resetAndLoad();
        } else {
            renderTabs();
            renderCategoryBar();
        }
    });

})();
