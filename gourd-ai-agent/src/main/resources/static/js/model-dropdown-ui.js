/* model-dropdown-ui.js — 模型下拉框公共能力：关键词搜索 + 服务商分组折叠
 *
 * 供三处选择器复用（聊天页 app-history.js / 定时任务 app-automation.js / ACP 设置 app-settings-acp.js）：
 *   - searchHtml()      : 吸顶搜索框骨架（带 data-i18n-placeholder，语言切换自动跟随）
 *   - render()          : 统一渲染分组 + 折叠 wrapper + 条目 + 空态，返回命中信息
 *   - toSegments()      : 把 ModelListOrder.buildEntries 的扁平 entries 折成分段（保序，不聚合）
 *   - 折叠态            : localStorage 持久化，按 provider 记录「用户显式操作」；未操作过的组走默认策略
 *
 * 设计约定：
 *   1. 分组语义不在本模块决定 —— 调用方传入 segments，保序（聊天/定时任务）或 map 聚合（ACP）都支持。
 *   2. 搜索期间忽略折叠态，命中组一律展开，避免「搜到了但看不见」。
 *   3. provider 命中关键词时整组视为命中，方便「按服务商筛选」。
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.GourdModelDropdown = api;
})(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    var STORE_KEY = 'gourd-model-group-collapsed';
    // 服务商数量达到该阈值时，未被用户显式操作过的组默认折叠（只留当前模型所在组展开）
    var AUTO_COLLAPSE_THRESHOLD = 3;

    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /* ===================== 折叠态持久化 ===================== */

    // 仅记录用户显式折叠/展开过的 provider：{ "<provider>": true|false }
    // 未出现在表中的组交给默认策略，从而「服务商变多时自动收起」与「用户手动指定」互不打架。
    function readStore() {
        try {
            var raw = localStorage.getItem(STORE_KEY);
            if (!raw) return {};
            var obj = JSON.parse(raw);
            return (obj && typeof obj === 'object') ? obj : {};
        } catch (e) { return {}; }
    }

    function writeStore(store) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* 存储不可用时忽略 */ }
    }

    function groupKey(provider) {
        return provider || '__other__';
    }

    /**
     * 该组当前是否折叠。
     * @param provider 服务商名（空串表示「其他」组）
     * @param ctx      { groupCount, currentProvider } 用于默认策略
     */
    function isCollapsed(provider, ctx) {
        ctx = ctx || {};
        var store = readStore();
        var key = groupKey(provider);
        if (typeof store[key] === 'boolean') return store[key];
        // 默认策略：服务商较多时只展开当前模型所在组；较少时全展开（贴近改造前行为）
        if ((ctx.groupCount || 0) < AUTO_COLLAPSE_THRESHOLD) return false;
        return (provider || '') !== (ctx.currentProvider || '');
    }

    function setCollapsed(provider, collapsed) {
        var store = readStore();
        store[groupKey(provider)] = !!collapsed;
        writeStore(store);
    }

    /** 切换并返回切换后的折叠状态 */
    function toggleCollapsed(provider, ctx) {
        var next = !isCollapsed(provider, ctx);
        setCollapsed(provider, next);
        return next;
    }

    /* ===================== 关键词匹配 ===================== */

    // 空格分词后按 AND 匹配：「aws son」可同时约束服务商与模型名
    function parseQuery(query) {
        var text = String(query == null ? '' : query).toLowerCase().trim();
        if (!text) return [];
        return text.split(/\s+/);
    }

    function haystackOf(model, provider) {
        var parts = [
            model && model.name,
            model && model.model,
            model && model.desc,
            model && model.description,
            (model && model.provider) || provider
        ];
        var s = '';
        for (var i = 0; i < parts.length; i++) {
            if (parts[i]) s += String(parts[i]).toLowerCase() + ' ';
        }
        return s;
    }

    function matchTerms(haystack, terms) {
        for (var i = 0; i < terms.length; i++) {
            if (haystack.indexOf(terms[i]) === -1) return false;
        }
        return true;
    }

    /** 单个模型是否命中关键词（provider 作为可搜索字段之一） */
    function matchModel(model, query, provider) {
        var terms = parseQuery(query);
        if (!terms.length) return true;
        return matchTerms(haystackOf(model, provider), terms);
    }

    /* ===================== 数据整形 ===================== */

    /**
     * 把 ModelListOrder.buildEntries() 的扁平结果折成分段。
     * 严格保序、不做跨段聚合：同一 provider 交错出现时仍是多段（与既有不变式一致）。
     */
    function toSegments(entries) {
        var segments = [];
        for (var i = 0; i < (entries || []).length; i++) {
            var entry = entries[i];
            if (!entry) continue;
            if (entry.type === 'provider') {
                segments.push({ provider: entry.provider || '', models: [] });
                continue;
            }
            if (entry.type === 'model') {
                if (!segments.length) segments.push({ provider: (entry.model && entry.model.provider) || '', models: [] });
                segments[segments.length - 1].models.push(entry.model);
            }
        }
        return segments;
    }

    /** 去掉「服务商-」前缀的展示短名（分组标题已展示服务商，条目内不重复） */
    function shortName(name, provider) {
        var p = provider || '';
        if (p && name && String(name).indexOf(p + '-') === 0) {
            var rest = String(name).substring(p.length + 1);
            if (rest) return rest;
        }
        return name;
    }

    /* ===================== 渲染 ===================== */

    function searchHtml(placeholder, i18nKey) {
        return '<div class="model-dropdown-search">'
            + '<svg class="model-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>'
            + '<input type="text" class="model-search-input" autocomplete="off" spellcheck="false"'
            + ' data-i18n-placeholder="' + escapeHtml(i18nKey || 'history.model_search_placeholder') + '"'
            + ' placeholder="' + escapeHtml(placeholder || '') + '" />'
            + '<span class="model-search-clear" style="display:none">&#10005;</span>'
            + '</div>';
    }

    /**
     * 渲染分组列表。
     * @param opts {
     *   segments        : [{provider, models:[...]}]
     *   query           : 搜索关键词
     *   currentModel    : 当前选中模型名（用于 active 态与默认展开组）
     *   currentProvider : 当前选中模型的服务商
     *   otherLabel      : 空 provider 组的标题文案
     *   emptyText       : 无命中时的空态文案
     *   toggleTitle     : 组头 title 提示
     *   itemHtml        : function(model, active, provider) -> string  条目内部 HTML（由各页决定）
     * }
     * @return { html, matched, firstModel }
     */
    function render(opts) {
        opts = opts || {};
        var segments = opts.segments || [];
        var terms = parseQuery(opts.query);
        var searching = terms.length > 0;
        var currentModel = opts.currentModel;
        var html = '';
        var matched = 0;
        var firstModel = null;

        var ctx = { groupCount: segments.length, currentProvider: opts.currentProvider || '' };

        for (var gi = 0; gi < segments.length; gi++) {
            var seg = segments[gi] || {};
            var provider = seg.provider || '';
            var models = seg.models || [];

            // 服务商名命中时整组保留，便于「按服务商筛选」
            var providerHit = searching && matchTerms(provider.toLowerCase(), terms);
            var visible = [];
            for (var mi = 0; mi < models.length; mi++) {
                var m = models[mi];
                if (!searching || providerHit || matchTerms(haystackOf(m, provider), terms)) visible.push(m);
            }
            if (!visible.length) continue;

            // 搜索期间忽略折叠态：命中组一律展开
            var collapsed = searching ? false : isCollapsed(provider, ctx);
            var label = provider || opts.otherLabel || '';

            html += '<div class="model-dropdown-group-wrap' + (collapsed ? ' collapsed' : '') + '"'
                + ' data-provider="' + escapeHtml(provider) + '">'
                + '<div class="model-dropdown-group" data-provider="' + escapeHtml(provider) + '"'
                + (opts.toggleTitle ? ' title="' + escapeHtml(opts.toggleTitle) + '"' : '') + '>'
                + '<svg class="model-group-arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
                + '<polyline points="6 4 10 8 6 12"/></svg>'
                + '<span class="model-group-name">' + escapeHtml(label) + '</span>'
                + '<span class="model-group-count">' + visible.length + '</span>'
                + '</div>'
                + '<div class="model-dropdown-group-items">';

            for (var vi = 0; vi < visible.length; vi++) {
                var model = visible[vi];
                var active = model && model.name === currentModel;
                if (firstModel === null && model) firstModel = model.name;
                matched++;
                html += opts.itemHtml ? opts.itemHtml(model, !!active, provider) : '';
            }

            html += '</div></div>';
        }

        if (!matched) {
            html += '<div class="model-dropdown-empty">' + escapeHtml(opts.emptyText || '') + '</div>';
        }

        return { html: html, matched: matched, firstModel: firstModel };
    }

    return {
        STORE_KEY: STORE_KEY,
        AUTO_COLLAPSE_THRESHOLD: AUTO_COLLAPSE_THRESHOLD,
        escapeHtml: escapeHtml,
        isCollapsed: isCollapsed,
        setCollapsed: setCollapsed,
        toggleCollapsed: toggleCollapsed,
        parseQuery: parseQuery,
        matchModel: matchModel,
        toSegments: toSegments,
        shortName: shortName,
        searchHtml: searchHtml,
        render: render
    };
});
