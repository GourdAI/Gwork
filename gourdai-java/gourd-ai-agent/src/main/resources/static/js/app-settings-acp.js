/* app-settings-acp.js — 编码工具接入（ACP）设置页 */
(function () {
    'use strict';

    var CONTAINER = 'settingsTabAcp';
    var core = window._settingsCore || {};
    var escapeHtml = core.escapeHtml || function (s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };

    function t(key, args) { return window.GourdI18n ? GourdI18n.t(key, args) : key; }

    function showToast(msg, type) {
        if (typeof window.showToast === 'function') window.showToast(msg, type === 'error' ? 'error' : 'success');
    }

    function $c() { return $('#' + CONTAINER); }

    // ACP 采用 stdio 传输：编辑器作为客户端自行 spawn `gwork acp` 子进程，无端口。
    // 本页仅拉取环境事实（启动器绝对路径 / 就绪状态）用于生成各编辑器配置片段。
    function load() {
        $.get('/web/settings/acp/info', function (resp) {
            if (resp && resp.code === 200 && resp.data) {
                render(resp.data);
            } else {
                renderError();
            }
        }).fail(renderError);
    }

    function renderError() {
        // 进入错误态前销毁选择器实例：document 级监听必须显式解绑，避免指向已被替换的旧骨架
        if (acpSelector) { acpSelector.destroy(); acpSelector = null; }
        $c().html('<div class="settings-section"><div class="settings-section-desc">' +
            escapeHtml(t('settings.acp.load_failed')) + '</div></div>');
    }

    function codeBlock(id, content) {
        return '<div class="acp-codeblock">' +
            '<button class="acp-copy-btn" data-copy-target="' + id + '">' + escapeHtml(t('settings.acp.copy')) + '</button>' +
            '<pre id="' + id + '">' + escapeHtml(content) + '</pre>' +
            '</div>';
    }

    // 通用卡片外壳：标题 + 说明 + 主体，复用通用设置页的卡片视觉
    function card(title, desc, body) {
        var h = '<div class="general-card"><div class="general-card-header"><div class="general-card-text">';
        h += '<div class="general-card-title">' + escapeHtml(title) + '</div>';
        if (desc) h += '<div class="general-card-desc">' + escapeHtml(desc) + '</div>';
        h += '</div></div><div class="general-card-body">' + body + '</div></div>';
        return h;
    }

    function render(info) {
        var command = info.command || 'gwork';
        var args = info.args || ['acp'];
        var ready = !!info.ready;
        var argsJson = JSON.stringify(args);

        var html = '';

        // 页头
        html += '<div class="settings-section-header settings-section-header-flat"><div>';
        html += '<span class="settings-section-title">' + escapeHtml(t('settings.acp.title')) + '</span>';
        html += '<div class="settings-section-desc">' + escapeHtml(t('settings.acp.desc')) + '</div>';
        html += '</div></div>';

        // 就绪状态横幅
        if (ready) {
            html += '<div class="acp-status acp-status-ok">' +
                '<div class="acp-status-line"><span class="acp-status-dot"></span>' +
                escapeHtml(t('settings.acp.ready')) + '</div></div>';
        } else {
            html += '<div class="acp-status acp-status-warn">' +
                '<div class="acp-status-line"><span class="acp-status-dot"></span>' +
                escapeHtml(t('settings.acp.not_ready')) + '</div>' +
                '<div class="acp-status-sub">' + escapeHtml(t('settings.acp.not_ready_desc')) + '</div></div>';
        }

        // 卡片组
        html += '<div class="general-card-group">';

        // 模型 + 思考深度：合并为关联选择器（思考档位内嵌在当前模型项下）
        html += card(t('settings.acp.model_title'), t('settings.acp.model_desc'), buildModelBody(info));

        // 工作原理
        html += card(t('settings.acp.how_title'), '',
            '<div class="acp-how-text">' + escapeHtml(t('settings.acp.how_desc')) + '</div>');

        // 编辑器集成配置（各 ACP 编辑器通用 JSON 配置块）
        html += card(t('settings.acp.generic_title'), t('settings.acp.zed_integration_desc'),
            buildIntegrationBody(command, argsJson));

        html += '</div>'; // /card-group

        $c().html(html);
        // 骨架插入文档后创建/重建公共组件实例（与就地刷新共用同一入口）
        setupAcpSelector();
    }

    /* ===== 模型 + 思考 + 上下文窗口合并选择器（公共组件驱动） =====
     * 与聊天页模型选择器同一套交互，行为由 GourdModelSelector（model-selector.js）统一提供：
     * - 点击按钮开合下拉；
     * - 点其他模型项 → 切换并保持下拉打开，思考档位 chips 立即跟随新模型渲染；
     * - 点思考档位 / 上下文 chip → 仅设值，保持打开；
     * - 点当前已选模型项 → 收起（确认）。
     * 保存走服务端 general.acpModel / general.acpThinkingDepth / general.acpContextLength
     * （ACP 子进程下次启动生效）。
     */

    // 页面状态（load() 时从 /web/settings/acp/info 重建）
    var acpState = {
        models: [],          // [{name, provider, standard, thinkingLevels}, ...]
        current: '',         // 存储值 acpModel（''=未显式选择，跟随默认）
        defaultModel: '',    // 后端解析后的实际生效模型名（与会话页 selected 同口径）
        thinking: 'auto',
        contextLength: null  // 存储值 acpContextLength（null=未显式设置，跟随默认 256K）
    };

    /* 展示用的生效模型：未显式选择时回落后端解析的默认模型；
     * 已保存模型被删除/禁用时同样回落——ACP 实际运行会回退到 defaultModel/首个启用模型
     * （AcpLink.resolveChatModel），界面必须与之一致，避免「显示已失效模型、实际跑默认」的割裂。
     * 存储语义不变（'' 仍表示跟随默认，不主动回写），仅在 UI 上始终高亮一个具体模型。 */
    function effectiveModel() {
        var cur = acpState.current || '';
        if (cur && acpState.models.length) {
            for (var i = 0; i < acpState.models.length; i++) {
                if (acpState.models[i].name === cur) return cur;
            }
            return acpState.defaultModel || cur;
        }
        return cur || acpState.defaultModel || '';
    }

    /* 历史落盘档位值归一（与后端 ThinkingDepth.normalize 同口径，仅影响回显、不回写）：
     * 'off' 是 'auto' 的旧名（语义一直是「不注入参数、跟随模型默认」）；
     * 'minimal' 档已取消，后端静默归入 'low'。 */
    function normalizeThinking(depth) {
        var d = String(depth == null ? '' : depth).toLowerCase();
        if (!d || d === 'off') return 'auto';
        if (d === 'minimal') return 'low';
        return d;
    }

    function buildModelBody(info) {
        // 归一化：兼容旧后端的字符串数组与新后端的 {name, provider, standard, thinkingLevels} 对象数组
        acpState.models = GourdModelSelector.normalizeRows(info.models || []);
        acpState.current = info.acpModel || '';
        acpState.defaultModel = info.defaultModel || '';
        acpState.thinking = normalizeThinking(info.acpThinkingDepth);
        // 上下文窗口：未设置（null/空/非选项值）一律视为「跟随默认」，与后端校验口径一致
        var ctxLen = GourdModelSelector.parseContextLengthValue(info.acpContextLength);
        acpState.contextLength = (ctxLen && GourdModelSelector.CONTEXT_LENGTH_OPTIONS.indexOf(ctxLen) >= 0) ? ctxLen : null;

        var body = renderAcpSelectorHtml();

        if (acpState.models.length === 0) {
            body += '<div class="acp-model-empty">' + escapeHtml(t('settings.acp.model_none')) + '</div>';
        }

        return body;
    }

    /* 思考档位选项集与 chips、上下文窗口 chips、兜底档位集已统一收归公共组件
     * GourdModelSelector（model-selector.js，thinkingOptionsFor / thinkingChipsHtml / contextChipsHtml），
     * 本页不再自行维护档位表与行内渲染逻辑。 */

    var acpSelector = null;

    /** 创建/重建选择器实例（整页 render 后调用）。先销毁旧实例：document 级收起监听必须显式解绑，
     * 否则每次 load 都会泄漏一份。 */
    function setupAcpSelector() {
        if (acpSelector) { acpSelector.destroy(); acpSelector = null; }
        if (!$('#acpModelSelector').length) return;
        acpSelector = GourdModelSelector.create({
            root: '#acpModelSelector',
            models: function () { return acpState.models; },
            currentModel: effectiveModel,
            onSelect: function (name) { saveAcpModel(name); },
            thinking: {
                value: function () { return acpState.thinking; },
                onChange: function (v) { saveAcpThinking(v); }
            },
            context: {
                value: function () { return acpState.contextLength; },
                onChange: function (v) { saveAcpContext(v); }
            }
        });
        acpSelector.update();
    }

    function refreshAcpSelector() {
        if (acpSelector) acpSelector.update();
    }

    // 固定骨架（结构与聊天页选择器一致）：内容统一由公共组件刷新
    function renderAcpSelectorHtml() {
        return '<div class="model-selector dropdown-down acp-model-selector" id="acpModelSelector">'
            + '<div class="model-selector-current">'
            + '<span class="model-name"></span>'
            + '<span class="model-thinking-tag" style="display:none"></span>'
            + '<span class="model-context-tag" style="display:none"></span>'
            + '<span class="model-arrow">▾</span>'
            + '</div>'
            + '<div class="model-dropdown has-search">'
            + GourdModelDropdown.searchHtml(t('history.model_search_placeholder'))
            + '<div class="model-dropdown-list"></div>'
            + '</div>'
            + '</div>';
    }

    // 保存到 general.acpModel。
    // 交互对齐聊天页 selectModel：先乐观更新状态（零延迟反馈），请求失败回滚并提示。
    // （组件在 onSelect 回调后自动重绘；此处只需更新状态与提交）
    function saveAcpModel(value) {
        var prevModel = acpState.current;
        acpState.current = value;
        $.post('/web/settings/acp/model/save', { acpModel: value }, function (resp) {
            if (!(resp && resp.code === 200)) rollbackModel(prevModel, (resp && resp.description) || t('settings.acp.model_save_failed'));
        }).fail(function () {
            rollbackModel(prevModel, t('settings.acp.model_save_failed'));
        });
    }

    function rollbackModel(prevModel, msg) {
        acpState.current = prevModel;
        refreshAcpSelector();
        showToast(msg, 'error');
    }

    // 保存到 general.acpThinkingDepth（同样先乐观更新，失败回滚）
    function saveAcpThinking(value) {
        var prevThinking = acpState.thinking;
        acpState.thinking = value;
        $.post('/web/settings/acp/thinking/save', { acpThinkingDepth: value }, function (resp) {
            if (!(resp && resp.code === 200)) rollbackThinking(prevThinking, (resp && resp.description) || t('settings.acp.thinking_save_failed'));
        }).fail(function () {
            rollbackThinking(prevThinking, t('settings.acp.thinking_save_failed'));
        });
    }

    function rollbackThinking(prevThinking, msg) {
        acpState.thinking = prevThinking;
        refreshAcpSelector();
        showToast(msg, 'error');
    }

    // 保存到 general.acpContextLength（同样先乐观更新，失败回滚）
    function saveAcpContext(value) {
        var prevContext = acpState.contextLength;
        acpState.contextLength = value;
        $.post('/web/settings/acp/context/save', { acpContextLength: value }, function (resp) {
            if (!(resp && resp.code === 200)) rollbackContext(prevContext, (resp && resp.description) || t('settings.acp.context_save_failed'));
        }).fail(function () {
            rollbackContext(prevContext, t('settings.acp.context_save_failed'));
        });
    }

    function rollbackContext(prevContext, msg) {
        acpState.contextLength = prevContext;
        refreshAcpSelector();
        showToast(msg, 'error');
    }

    /* ===== 选择器事件：开合/搜索/分组/档位与上下文 chips 全部由公共组件接管 =====
     * （document 级外部点击收起由组件的命名空间监听处理；render() 重建骨架后由 setupAcpSelector 重新绑定。） */

    // 编辑器集成配置：生成 agent_servers 完整 JSON 配置块（各 ACP 编辑器通用）
    function buildIntegrationBody(command, argsJson) {
        var json = '{\n'
            + '  "agent_servers": {\n'
            + '    "GWork": {\n'
            + '      "command": ' + JSON.stringify(command) + ',\n'
            + '      "args": ' + argsJson + ',\n'
            + '      "env": {}\n'
            + '    }\n'
            + '  }\n'
            + '}';
        return '<div class="acp-field"><label>' + escapeHtml(t('settings.acp.integration_json')) + '</label>' + codeBlock('acpIntegration', json) + '</div>';
    }

    // 复制（navigator.clipboard 优先，execCommand 兜底）
    function copyText(text, cb) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { cb(true); }, function () { cb(fallbackCopy(text)); });
        } else {
            cb(fallbackCopy(text));
        }
    }

    function fallbackCopy(text) {
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            var ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch (e) { return false; }
    }

    $(document).on('click', '#' + CONTAINER + ' .acp-copy-btn', function () {
        var self = this;
        var targetId = $(self).attr('data-copy-target');
        var text = $('#' + targetId).text();
        copyText(text, function (ok) {
            if (ok) {
                var old = $(self).text();
                $(self).text(t('settings.acp.copied')).addClass('copied');
                setTimeout(function () { $(self).text(old).removeClass('copied'); }, 1500);
            } else {
                showToast(t('settings.acp.copy_failed'), 'error');
            }
        });
    });

    /* 注：/web/settings/acp/info 的 models 项目前已下发 {name, provider, standard, thinkingLevels}，
     * 档位与兜底逻辑由公共组件 GourdModelSelector 统一消费，本页不再需要自行兜底。 */

    window._settingsAcp = { load: load };
})();
