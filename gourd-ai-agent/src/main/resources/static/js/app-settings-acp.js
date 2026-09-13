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
        models: [],          // [{name, provider, standard, thinkingLevels}, ...]
        current: '',         // 存储值 acpModel（''=未显式选择，跟随默认）
        defaultModel: '',    // 后端解析后的实际生效模型名（与会话页 selected 同口径）
        currentStandard: '', // 当前生效模型对应的接口类型（仅供后端未下发 thinkingLevels 时的兜底档位集）
        thinking: 'auto'
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

    function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

    /* 查模型「真正可区分的思考档位」编码表（后端能力元数据，由低到高，不含 auto）。
     * 返回 null 有明确语义：后端未下发该字段（旧接口）→ 调用方走兜底档位集；
     * 返回 [] 同样有明确语义：该模型无可调档位 → 调用方应隐藏整个档位选择器。
     * 两者不可混淆，故此处不把 null 折叠成空数组。 */
    function thinkingLevelsOfAcpModel(name) {
        if (!name) return null;
        for (var i = 0; i < acpState.models.length; i++) {
            if (acpState.models[i].name === name) return acpState.models[i].thinkingLevels;
        }
        return null;
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

        // 归一化：models 兼容旧后端的字符串数组与新后端的 {name, provider, standard, thinkingLevels} 对象数组
        acpState.models = [];
        for (var n = 0; n < rawModels.length; n++) {
            var raw = rawModels[n];
            if (typeof raw === 'string') acpState.models.push({ name: raw, provider: '', standard: '', thinkingLevels: null });
            else acpState.models.push({
                name: raw.name || '',
                provider: raw.provider || '',
                standard: raw.standard || '',
                // 字段缺失 → null（走兜底档位集）；[] → 该模型无可调档位（隐藏档位选择器）
                thinkingLevels: isArray(raw.thinkingLevels) ? raw.thinkingLevels : null
            });
        }

        acpState.current = info.acpModel || '';
        acpState.defaultModel = info.defaultModel || '';
        acpState.thinking = normalizeThinking(info.acpThinkingDepth);
        // 接口类型：优先从列表查生效模型；若该模型未在可见列表中（已启用但隐藏）则用后端解析值
        acpState.currentStandard = standardOfAcpModel(effectiveModel()) || info.acpModelStandard || '';

        var body = renderAcpSelectorHtml();

        if (acpState.models.length === 0) {
            body += '<div class="acp-model-empty">' + escapeHtml(t('settings.acp.model_none')) + '</div>';
        }

        return body;
    }

    /* 兜底档位集（不含 auto）：仅当后端未随 models 下发 thinkingLevels 时使用。
     * /web/settings/acp/info 目前尚未下发该字段（见文件末尾 TODO），故暂保留本表作为过渡；
     * 后端补齐后本函数将不再被触发，可整体删除。
     * 与统一后的档位枚举对齐：不再有 'minimal' 档（后端已将其归入 'low'）。 */
    function fallbackThinkingLevels(standard) {
        var s = (standard || '').toLowerCase();
        if (s.indexOf('anthropic') >= 0 || s.indexOf('claude') >= 0) {
            return ['low', 'medium', 'high', 'xhigh', 'max'];
        }
        // gemini / google / openai / openai-responses / ollama / 其它
        return ['low', 'medium', 'high'];
    }

    /* 思考档位选项集（能力元数据驱动）。
     * 首项固定为「默认」（auto：不注入参数，跟随模型默认行为）；
     * 其余项由该模型的 thinkingLevels 动态生成 —— 后端只下发该模型「真正可区分」的档位
     * （由低到高，不含 auto），因此用户永远选不到无效档位。
     * 返回长度为 1（仅「默认」）即表示该模型无可调档位，调用方应隐藏整个档位选择器。 */
    function getThinkingOptions(modelName) {
        var opts = [{ value: 'auto', label: t('history.thinking.auto.label') }];
        var levels = thinkingLevelsOfAcpModel(modelName);
        // null = 后端未下发该字段 → 走兜底；[] = 明确无可调档位 → 保持为空
        if (levels == null) levels = fallbackThinkingLevels(standardOfAcpModel(modelName) || acpState.currentStandard);
        for (var i = 0; i < levels.length; i++) {
            var code = levels[i];
            if (!code || code === 'auto') continue; // auto 已固定置顶，防御后端重复下发
            opts.push({ value: code, label: t('history.thinking.' + code + '.label') });
        }
        return opts;
    }

    // 按钮内思考档位小标签：当前值为默认（auto）或不在档位集内时不显示，其余显示短标签
    function acpThinkingTag() {
        if (!acpState.thinking || acpState.thinking === 'auto') return '';
        var opts = getThinkingOptions(effectiveModel());
        for (var k = 0; k < opts.length; k++) {
            if (opts[k].value === acpState.thinking) return opts[k].label;
        }
        return '';
    }

    // 关联思考档位区（内嵌在当前选中模型项下）：首项为「默认」（auto，跟随模型默认行为）
    function acpThinkingChipsHtml(modelName) {
        var opts = getThinkingOptions(modelName);

        // 该模型无可区分档位（后端下发空数组）：只剩「默认」一项，选择器无意义 → 不渲染这一行
        if (opts.length <= 1) return '';

        // 当前档位是否在本模型档位集内（切换模型后旧值可能不适用 → 视作默认）
        var valid = 'auto';
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
                    + (active ? acpThinkingChipsHtml(m.name) : '')
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

    /* TODO(后端待补下发)：/web/settings/acp/info 的 models 项目前仅下发 {name, provider, standard}，
     * 尚未像 /web/chat/models 一样带上 thinkingLevels。建议在
     *   WebSettingsController#codingInfo() 的 models 循环里补一行（紧跟 item.put("standard", ...) 之后）：
     *   item.put("thinkingLevels", ThinkingDepth.selectableCodes(
     *           config.getStandardOrProvider(), config.getModel(), config.getCapabilities()));
     * 补齐后本页无需再改（getThinkingOptions 已优先消费该字段），
     * 并可直接删除上方 fallbackThinkingLevels() 及其在 getThinkingOptions 中的唯一调用。 */

    window._settingsAcp = { load: load };
})();
