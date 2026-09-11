/* ===== tool-presentation.js ===== */
/* 工具卡展示模型：浏览器全局与 Node.js 契约测试共用，无第三方依赖。 */
(function(root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.GourdToolPresentation = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function() {
    'use strict';

    var TOOL_I18N_KEY = {
        read: 'chat.tool_read', write: 'chat.tool_write', edit: 'chat.tool_edit',
        glob: 'chat.tool_glob', grep: 'chat.tool_grep', ls: 'chat.tool_ls',
        bash: 'chat.tool_bash', bash_output: 'chat.tool_bash_output',
        skill: 'chat.tool_skill',
        todo: 'chat.tool_todo', todowrite: 'chat.tool_todo', todoread: 'chat.tool_todo',
        code: 'chat.tool_code', codesearch: 'chat.tool_codesearch',
        websearch: 'chat.tool_websearch', webfetch: 'chat.tool_webfetch',
        task: 'chat.tool_task', multitask: 'chat.tool_multitask', generate: 'chat.tool_generate',
        mcp: 'chat.tool_mcp', openapi: 'chat.tool_openapi', lsp: 'chat.tool_lsp', memory: 'chat.tool_memory'
    };

    /* 工具图标统一采用 currentColor 的线性 SVG，不使用 emoji：emoji 在不同系统上会
       以彩色字形渲染，和聊天区的灰阶卡片视觉不一致。图标只表达工具类别，不承担状态颜色。 */
    var TOOL_ICON = {
        edit: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 11.8-.6 2.1 2.1-.6L12.8 5a1.6 1.6 0 0 0-2.3-2.3L2.2 11.1Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="m9.5 3.5 3 3" stroke="currentColor" stroke-width="1.2"/></svg>',
        write: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 1.8h6l4 4v8.4H3z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 1.8v4h4M5 9h6M5 11.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
        read: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 3.2A5.5 5.5 0 0 1 8 4.8a5.5 5.5 0 0 1 5.5-1.6v9.6A5.5 5.5 0 0 0 8 14.4a5.5 5.5 0 0 0-5.5-1.6z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 4.8v9.6" stroke="currentColor" stroke-width="1.2"/></svg>',
        grep: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="6.8" cy="6.8" r="3.8" stroke="currentColor" stroke-width="1.2"/><path d="m9.7 9.7 3.5 3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
        glob: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 4a1 1 0 0 1 1-1h3.4L8 4.5h4a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
        ls: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 4a1 1 0 0 1 1-1h3.4L8 4.5h4a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
        bash: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="m4.5 6 2 2-2 2M8.5 10h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        bash_output: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 12.5V8M6.5 12.5V4M10 12.5V6M13 12.5V2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
        todowrite: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="m5 8 2 2 4-4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        todoread: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="M5 5.5h6M5 8h6M5 10.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
        websearch: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.2"/><path d="M2.8 8h10.4M8 2.5c1.5 1.5 2.2 3.3 2.2 5.5S9.5 12 8 13.5C6.5 12 5.8 10.2 5.8 8S6.5 4 8 2.5Z" stroke="currentColor" stroke-width="1.1"/></svg>',
        webfetch: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6.2 9.8 9.8 6.2M5 11H4a2.5 2.5 0 0 1 0-5h2M11 5h1a2.5 2.5 0 0 1 0 5h-2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
        codesearch: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="6.8" cy="6.8" r="3.8" stroke="currentColor" stroke-width="1.2"/><path d="m9.7 9.7 3.5 3.5M5.2 6.8h3.2M6.8 5.2v3.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
        skill: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m8 2 1.1 2.2 2.4.3-1.7 1.7.4 2.4L8 7.5 5.8 8.6l.4-2.4-1.7-1.7 2.4-.3zM3 10.5h10M4.5 13h7" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        task: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="5" r="2.5" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 13c.4-2.2 2-3.5 4.5-3.5s4.1 1.3 4.5 3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
        multitask: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="5" cy="5" r="2" stroke="currentColor" stroke-width="1.1"/><circle cx="11" cy="5" r="2" stroke="currentColor" stroke-width="1.1"/><path d="M2.5 12c.3-1.6 1.2-2.5 2.5-2.5s2.2.9 2.5 2.5M8.5 12c.3-1.6 1.2-2.5 2.2-2.5 1.3 0 2.2.9 2.8 2.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
        generate: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m8 2 .8 4.2L13 7l-4.2.8L8 12l-.8-4.2L3 7l4.2-.8zM12.5 11.5l.3 1.5 1.5.3-1.5.3-.3 1.4-.3-1.4-1.5-.3 1.5-.3z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>'
    };
    var DEFAULT_TOOL_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m9.2 2.2 4.6 4.6-2.1 2.1-1.1-1.1-4.4 4.4-2.2.2.2-2.2 4.4-4.4-1.1-1.1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';

    function text(value) {
        return value == null ? '' : String(value).trim();
    }

    function bareName(toolName, toolTitle) {
        var name = text(toolName);
        if (name) {
            var slash = name.lastIndexOf('/');
            return slash >= 0 ? (name.slice(slash + 1) || 'tool') : name;
        }
        var title = text(toolTitle);
        var titleSlash = title.lastIndexOf('/');
        return titleSlash >= 0 ? (title.slice(titleSlash + 1) || 'tool') : (title || 'tool');
    }

    function sourceFrom(value, bareToolName) {
        var candidate = text(value);
        var suffix = '/' + bareToolName;
        return candidate.length > suffix.length && candidate.slice(-suffix.length) === suffix
            ? candidate.slice(0, -suffix.length)
            : '';
    }

    function parseSource(toolName, toolTitle, bareToolName, explicitAgentName) {
        // 新协议优先从 title 取来源；兼容旧帧仅把 "source/tool" 放在 toolName 的输入。
        var source = sourceFrom(toolTitle, bareToolName) || sourceFrom(toolName, bareToolName);
        var agentName = text(explicitAgentName) || (source ? source.slice(source.lastIndexOf('/') + 1) : '');
        return { source: source, agentName: agentName };
    }

    /* action_start 的卡片选择是纯状态决策，供浏览器逻辑与 Node 回归测试共用。 */
    function resolveActionStartCardState(hasApprovedCard, actionId) {
        var reuseApprovedCard = hasApprovedCard === true;
        return {
            reuseApprovedCard: reuseApprovedCard,
            registerByActionId: reuseApprovedCard && !!text(actionId),
            usePendingPairing: reuseApprovedCard && !text(actionId)
        };
    }

    /* 普通工具标题接管 HITL 标题时必须移除的动态重译属性。 */
    function ordinaryToolNameCleanupAttributes() {
        return ['data-i18n-hitl', 'data-i18n-hitl-tool'];
    }

    function resolveToolPresentation(toolName, toolTitle, options) {
        options = options || {};
        var bareToolName = bareName(toolName, toolTitle);
        var parsed = parseSource(toolName, toolTitle, bareToolName, options.agentName);
        var nested = options.nested === true || options.internal === true;
        var translate = typeof options.translate === 'function' ? options.translate : null;
        var key = TOOL_I18N_KEY[bareToolName];
        var localized = key && translate ? translate(key) : bareToolName;
        if (!localized || localized === key) localized = bareToolName;
        return {
            bareToolName: bareToolName,
            toolName: bareToolName,
            displayName: (!nested && parsed.source ? parsed.source + '/' : '') + localized,
            icon: TOOL_ICON[bareToolName] || DEFAULT_TOOL_ICON,
            source: parsed.source,
            agentName: parsed.agentName,
            toolTitle: text(toolTitle),
            nested: nested,
            i18nKey: key || null
        };
    }

    return {
        TOOL_I18N_KEY: TOOL_I18N_KEY,
        TOOL_ICON: TOOL_ICON,
        DEFAULT_TOOL_ICON: DEFAULT_TOOL_ICON,
        resolveToolPresentation: resolveToolPresentation,
        resolveActionStartCardState: resolveActionStartCardState,
        ordinaryToolNameCleanupAttributes: ordinaryToolNameCleanupAttributes
    };
});
