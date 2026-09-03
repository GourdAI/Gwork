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
        // 骨架插入文档后统一填充选择器内容（与就地刷新共用同一渲染入口）
        updateAcpModelUI();
    }

    /* ===== 模型 + 思考深度合并关联选择器 =====
     * 与聊天页模型选择器同一套交互：
     * - 点击按钮开合下拉；
     * - 点其他模型项 → 切换并保持下拉打开，思考档位 chips 立即跟随新模型渲染；
     * - 点思考档位 chip → 仅设档位，保持打开；
     * - 点当前已选模型项 → 收起（确认）。
     * 保存走服务端 general.acpModel / general.acpThinkingDepth（ACP 子进程下次启动生效）。
     */

    // 页面状态（load() 时从 /web/settings/acp/info 重建）
    var acpState = {
        models: [],          // [{name, provider, standard}, ...]
        current: '',         // 存储值 acpModel（''=未显式选择，跟随默认）
        defaultModel: '',    // 后端解析后的实际生效模型名（与会话页 selected 同口径）
        currentStandard: '', // 当前生效模型对应的接口类型（决定思考档位选项集）
        thinking: 'off'
    };

    /* 展示用的生效模型：未显式选择时回落后端解析的默认模型。
     * 存储语义不变（'' 仍表示跟随默认，不主动回写），仅在 UI 上始终高亮一个具体模型，
     * 与会话页一致 —— 因此不需要「跟随默认模型」这个额外选项。 */
    function effectiveModel() {
        return acpState.current || acpState.defaultModel || '';
    }

    // 查模型对应的接口类型
    function standardOfAcpModel(name) {
        if (!name) return '';
        for (var i = 0; i < acpState.models.length; i++) {
            if (acpState.models[i].name === name) return acpState.models[i].standard || '';
        }
        return '';
    }

    // 去掉「供应商-」前缀的展示短名（分组标题已展示供应商，选项内不再重复）
    function modelShortName(name, provider) {
        if (provider && name && name.indexOf(provider + '-') === 0) {
            var rest = name.substring(provider.length + 1);
            if (rest) return rest;
        }
        return name;
    }

    function buildModelBody(info) {
        var rawModels = info.models || [];

        // 归一化：models 兼容旧后端的字符串数组与新后端的 {name, provider, standard} 对象数组
        acpState.models = [];
        for (var n = 0; n < rawModels.length; n++) {
            var raw = rawModels[n];
            if (typeof raw === 'string') acpState.models.push({ name: raw, provider: '', standard: '' });
            else acpState.models.push({ name: raw.name || '', provider: raw.provider || '', standard: raw.standard || '' });
        }

        acpState.current = info.acpModel || '';
        acpState.defaultModel = info.defaultModel || '';
        acpState.thinking = info.acpThinkingDepth || 'off';
        // 接口类型：优先从列表查生效模型；若该模型未在可见列表中（已启用但隐藏）则用后端解析值
        acpState.currentStandard = standardOfAcpModel(effectiveModel()) || info.acpModelStandard || '';

        var body = renderAcpSelectorHtml();

        if (acpState.models.length === 0) {
            body += '<div class="acp-model-empty">' + escapeHtml(t('settings.acp.model_none')) + '</div>';
        }

        return body;
    }

    // 根据接口类型获取思考档位选项集（首项为「默认」=off，跟随模型默认行为）
    function getThinkingOptions(standard) {
        var s = (standard || '').toLowerCase();
        var off = { value: 'off', label: t('history.thinking.off.label') };

        if (s.indexOf('anthropic') >= 0 || s.indexOf('claude') >= 0) {
            return [
                off,
                { value: 'low',    label: t('history.thinking.low.label') },
                { value: 'medium', label: t('history.thinking.medium.label') },
                { value: 'high',   label: t('history.thinking.high.label') },
                { value: 'xhigh',  label: t('history.thinking.xhigh.label') },
                { value: 'max',    label: t('history.thinking.max.label') }
            ];
        } else if (s.indexOf('gemini') >= 0 || s.indexOf('google') >= 0) {
            return [
                off,
                { value: 'minimal', label: t('history.thinking.minimal.label') },
                { value: 'low',     label: t('history.thinking.low.label') },
                { value: 'medium', label: t('history.thinking.medium.label') },
                { value: 'high',    label: t('history.thinking.high.label') }
            ];
        } else {
            // openai / openai-responses / ollama / 其它
            return [
                off,
                { value: 'minimal', label: t('history.thinking.minimal.label') },
                { value: 'low',     label: t('history.thinking.low.label') },
                { value: 'medium', label: t('history.thinking.medium.label') },
                { value: 'high',    label: t('history.thinking.high.label') }
            ];
        }
    }

    // 按钮内思考档位小标签：当前值为默认（off）或不在档位集内时不显示，其余显示短标签
    function acpThinkingTag() {
        if (!acpState.thinking || acpState.thinking === 'off') return '';
        var opts = getThinkingOptions(acpState.currentStandard);
        for (var k = 0; k < opts.length; k++) {
            if (opts[k].value === acpState.thinking) return opts[k].label;
        }
        return '';
    }

    // 关联思考档位区（内嵌在当前选中模型项下）：首项为「默认」（off，跟随模型默认行为）
    function acpThinkingChipsHtml() {
        var opts = getThinkingOptions(acpState.currentStandard);

        // 当前档位是否在本接口档位集内（切换模型后旧值可能不适用 → 视作默认）
        var valid = 'off';
        for (var k = 0; k < opts.length; k++) {
            if (opts[k].value === acpState.thinking) { valid = acpState.thinking; break; }
        }

        var html = '<div class="model-thinking-opts"><span class="model-thinking-label">'
            + escapeHtml(t('app.thinking_label')) + '</span>';
        for (var i = 0; i < opts.length; i++) {
            var o = opts[i];
            var cls = o.value === valid ? ' active' : '';
            html += '<span class="model-thinking-chip' + cls + '" data-thinking="' + escapeHtml(o.value) + '">'
                + escapeHtml(o.label) + '</span>';
        }
        html += '</div>';
        return html;
    }

    // 模型下拉搜索关键词（每次打开下拉时清空）与当前过滤首项
    var acpFilterText = '';
    var acpFirstMatch = null;

    function acpDropdownItemsHtml() {
        var current = effectiveModel();

        // 按供应商分组（map 归组，不依赖相邻性）；无 provider 的归入「其他」组
        var groups = [];
        var groupIndex = {};
        for (var i = 0; i < acpState.models.length; i++) {
            var g = acpState.models[i].provider || '';
            if (!(g in groupIndex)) { groupIndex[g] = groups.length; groups.push({ provider: g, models: [] }); }
            groups[groupIndex[g]].models.push(acpState.models[i]);
        }

        var result = GourdModelDropdown.render({
            segments: groups,
            query: acpFilterText,
            currentModel: current,
            currentProvider: providerOf(current),
            otherLabel: t('history.model_group_other'),
            emptyText: t('history.model_search_empty'),
            toggleTitle: t('history.model_group_toggle'),
            itemHtml: function (m, active, provider) {
                return '<div class="model-dropdown-item' + (active ? ' active' : '') + '" data-model="' + escapeHtml(m.name) + '">'
                    + '<span class="model-item-name">' + escapeHtml(modelShortName(m.name, provider)) + '</span>'
                    + (active ? acpThinkingChipsHtml() : '')
                    + '</div>';
            }
        });
        acpFirstMatch = result.firstModel;
        return result.html;
    }

    // 固定骨架（结构与聊天页选择器一致）：内容统一由 updateAcpModelUI 填充
    function renderAcpSelectorHtml() {
        // 骨架重建时搜索框回到空白，关键词必须同步重置，
        // 否则列表会按上次关键词过滤但输入框看上去是空的
        acpFilterText = '';
        acpFirstMatch = null;
        return '<div class="model-selector dropdown-down acp-model-selector" id="acpModelSelector">'
            + '<div class="model-selector-current">'
            + '<span class="model-name"></span>'
            + '<span class="model-thinking-tag" style="display:none"></span>'
            + '<span class="model-arrow">▾</span>'
            + '</div>'
            + '<div class="model-dropdown has-search">'
            + GourdModelDropdown.searchHtml(t('history.model_search_placeholder'))
            + '<div class="model-dropdown-list"></div>'
            + '</div>'
            + '</div>';
    }

    function providerOf(name) {
        for (var i = 0; i < acpState.models.length; i++) {
            if (acpState.models[i].name === name) return acpState.models[i].provider || '';
        }
        return '';
    }

    /* 就地刷新（对齐聊天页 renderModelUI）：只更新文本与下拉内部 HTML，
     * 不替换外层容器 —— open 状态、drop-up 入场动画、箭头旋转过渡均不被打断，
     * 点击模型/档位后不会闪烁跳动。 */
    function updateAcpModelUI() {
        var $sel = $('#acpModelSelector');
        if (!$sel.length) return;
        var effective = effectiveModel();
        var displayName = modelShortName(effective, providerOf(effective));
        var tag = acpThinkingTag();
        $sel.find('.model-selector-current .model-name').text(displayName);
        $sel.find('.model-selector-current .model-thinking-tag').text(tag).toggle(!!tag);
        // 只重绘列表层：搜索框为骨架静态节点，重绘会丢焦点与已输入内容
        $sel.find('.model-dropdown-list').html(acpDropdownItemsHtml());
    }

    // 保存到 general.acpModel。
    // 交互对齐聊天页 selectModel：先乐观更新 UI（零延迟反馈），请求失败回滚并提示。
    function saveAcpModel(value) {
        var prevModel = acpState.current;
        var prevStandard = acpState.currentStandard;
        acpState.current = value;
        acpState.currentStandard = standardOfAcpModel(value);
        updateAcpModelUI();
        $.post('/web/settings/acp/model/save', { acpModel: value }, function (resp) {
            if (!(resp && resp.code === 200)) rollbackModel(prevModel, prevStandard, (resp && resp.description) || t('settings.acp.model_save_failed'));
        }).fail(function () {
            rollbackModel(prevModel, prevStandard, t('settings.acp.model_save_failed'));
        });
    }

    function rollbackModel(prevModel, prevStandard, msg) {
        acpState.current = prevModel;
        acpState.currentStandard = prevStandard;
        updateAcpModelUI();
        showToast(msg, 'error');
    }

    // 保存到 general.acpThinkingDepth（同样先乐观更新，失败回滚）
    function saveAcpThinking(value) {
        var prevThinking = acpState.thinking;
        acpState.thinking = value;
        updateAcpModelUI();
        $.post('/web/settings/acp/thinking/save', { acpThinkingDepth: value }, function (resp) {
            if (!(resp && resp.code === 200)) rollbackThinking(prevThinking, (resp && resp.description) || t('settings.acp.thinking_save_failed'));
        }).fail(function () {
            rollbackThinking(prevThinking, t('settings.acp.thinking_save_failed'));
        });
    }

    function rollbackThinking(prevThinking, msg) {
        acpState.thinking = prevThinking;
        updateAcpModelUI();
        showToast(msg, 'error');
    }

    /* ===== 选择器事件（document 委托：render() 每次重建 HTML，无需重复绑定） ===== */
    $(document).on('click', '#' + CONTAINER + ' .model-selector-current', function (e) {
        e.stopPropagation();
        var willOpen = !$('#acpModelSelector').hasClass('open');
        $('#acpModelSelector').toggleClass('open');
        // 每次打开从完整列表开始：清空关键词并聚焦搜索框
        if (willOpen) {
            if (acpFilterText) { acpFilterText = ''; updateAcpModelUI(); }
            var $dd = $('#acpModelSelector').find('.model-dropdown');
            $dd.find('.model-search-input').val('');
            $dd.find('.model-search-clear').hide();
            setTimeout(function () { try { $dd.find('.model-search-input').focus(); } catch (err) {} }, 0);
        }
    });

    // 搜索：输入即过滤（只重绘列表层，焦点不丢）
    $(document).on('input', '#' + CONTAINER + ' .model-search-input', function () {
        acpFilterText = $(this).val() || '';
        $('#acpModelSelector').find('.model-search-clear').toggle(!!acpFilterText);
        updateAcpModelUI();
        $('#acpModelSelector').find('.model-dropdown-list').scrollTop(0);
    });

    $(document).on('keydown', '#' + CONTAINER + ' .model-search-input', function (e) {
        if (e.key === 'Escape' || e.keyCode === 27) {
            e.stopPropagation();
            if (acpFilterText) {
                acpFilterText = '';
                $(this).val('');
                $('#acpModelSelector').find('.model-search-clear').hide();
                updateAcpModelUI();
            } else {
                $('#acpModelSelector').removeClass('open');
            }
            return;
        }
        if (e.key === 'Enter' || e.keyCode === 13) {
            e.preventDefault();
            e.stopPropagation();
            // 回车选中过滤结果首项；与当前生效模型相同时视为确认收起
            if (acpFirstMatch != null && acpFirstMatch !== effectiveModel()) saveAcpModel(acpFirstMatch);
            else $('#acpModelSelector').removeClass('open');
        }
    });

    $(document).on('click', '#' + CONTAINER + ' .model-dropdown', function (e) {
        // 下拉内部点击一律不冒泡：否则点搜索框/组头/空白处会被外部收起器关闭
        e.stopPropagation();

        // 清空按钮
        if ($(e.target).closest('.model-search-clear').length) {
            acpFilterText = '';
            var $dd = $('#acpModelSelector').find('.model-dropdown');
            $dd.find('.model-search-input').val('').focus();
            $dd.find('.model-search-clear').hide();
            updateAcpModelUI();
            return;
        }

        // 服务商组头：折叠/展开（与聊天页共享持久化折叠态）
        var $group = $(e.target).closest('.model-dropdown-group');
        if ($group.length) {
            var $wrap = $group.closest('.model-dropdown-group-wrap');
            GourdModelDropdown.setCollapsed($group.attr('data-provider') || '', !$wrap.hasClass('collapsed'));
            updateAcpModelUI();
            return;
        }

        // 关联的思考档位 chip：仅设定档位，不切模型；保持下拉打开便于连续调整
        var $chip = $(e.target).closest('.model-thinking-chip');
        if ($chip.length) {
            var depth = $chip.attr('data-thinking');
            if (depth != null && depth !== acpState.thinking) {
                saveAcpThinking(depth);
            }
            return;
        }
        var $item = $(e.target).closest('.model-dropdown-item');
        if (!$item.length) return;
        var modelName = $item.attr('data-model');
        if (modelName == null) return;
        if (modelName === effectiveModel()) {
            // 点击当前已选模型项：视为「确认/收起」动作，关闭下拉。
            // 此时若存储值为空（未显式选择），保持不写入，继续跟随默认模型
            $('#acpModelSelector').removeClass('open');
            return;
        }
        // 切换模型后保持下拉打开：让用户继续在新模型项下选择思考档位（关联选择）
        saveAcpModel(modelName);
    });

    // 点击选择器外部时收起
    $(document).on('click', function (e) {
        if (!$(e.target).closest('#acpModelSelector').length) {
            $('#acpModelSelector').removeClass('open');
        }
    });

    // 国际化：语言切换后重建选择器文案（chips / 跟随默认标签随语言变）
    document.addEventListener('i18n:localeChanged', function () {
        if ($('#acpModelSelector').length) updateAcpModelUI();
    });

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

    window._settingsAcp = { load: load };
})();
