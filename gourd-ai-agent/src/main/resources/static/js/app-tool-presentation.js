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

    var TOOL_ICON = {
        edit: '\u270f\ufe0f', write: '\ud83d\udcdd', read: '\ud83d\udcd6', grep: '\ud83d\udd0d',
        glob: '\ud83d\udcc1', ls: '\ud83d\udcc1', bash: '\u26a1', bash_output: '\ud83d\udcca',
        todowrite: '\u2705', todoread: '\u2705', websearch: '\ud83c\udf10', webfetch: '\ud83d\udd17',
        codesearch: '\ud83d\udd0e', skill: '\ud83e\udde9', task: '\ud83e\udd16',
        multitask: '\ud83e\udd16', generate: '\u2728'
    };

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
            icon: TOOL_ICON[bareToolName] || '\ud83d\udd27',
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
        resolveToolPresentation: resolveToolPresentation,
        resolveActionStartCardState: resolveActionStartCardState,
        ordinaryToolNameCleanupAttributes: ordinaryToolNameCleanupAttributes
    };
});
