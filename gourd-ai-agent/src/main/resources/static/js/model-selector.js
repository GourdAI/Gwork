/* model-selector.js — 统一模型选择器公共组件：当前按钮 + 搜索下拉 + 思考档位 + 上下文窗口
 *
 * 行为基准为对话页（app-history.js）的模型选择器：去供应商前缀的短名展示、
 * 搜索/服务商分组折叠/打开定位、关联在当前选中模型项下的思考档位与上下文窗口 chips、
 * 回车选中首项 / Escape 逐级清退 / 外部点击收起。对话页保留其本地实现不动
 * （其行为由上下文选择器与下拉契约测试逐条锁定），自动化页与 ACP 设置页改由本组件统一驱动。
 *
 * 组成：
 *   1) 纯工具（与聊天页同名同口径）：parseContextLengthValue / normalizeContextLength /
 *      contextLengthLabel / normalizeThinkingCode / fallbackThinkingLevels
 *   2) 档位与 chips 构建：thinkingOptionsFor / thinkingChipsHtml / contextChipsHtml / thinkingTagLabel
 *   3) 实例化组件：GourdModelSelector.create({...}) → { update, destroy, close }
 *
 * 依赖（运行时全局，均为本仓库既有模块，加载顺序见 app-bootstrap.js）：
 *   - GourdModelDropdown：搜索/分组/折叠/定位渲染器（model-dropdown-ui.js）
 *   - ModelListOrder：按接口顺序保序分段（model-list-order.js）
 *   - GourdI18n：文案（app-i18n.js；缺省时文案回落为 key 字面量）
 *   - jQuery：$（layui 内置）
 *
 * DOM 契约（调用方提供骨架，组件只更新内容并绑定事件）：
 *   .model-selector（根）
 *     .model-selector-current        ← 点击开合
 *       .model-name / .model-thinking-tag / .model-context-tag
 *     .model-dropdown.has-search
 *       .model-dropdown-search > .model-search-input / .model-search-clear
 *       .model-dropdown-list         ← 列表层由组件重绘
 */
(function (root, factory) {
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.GourdModelSelector = api;
})(typeof window !== 'undefined' ? window : this, function (root) {
    'use strict';

    // ===================== 常量 =====================

    var DEFAULT_CONTEXT_LENGTH = 256000;
    var CONTEXT_LENGTH_OPTIONS = [128000, 256000, 512000, 1000000];
    var CONTEXT_LENGTH_LABELS = {
        128000: '128K',
        256000: '256K',
        512000: '512K',
        1000000: '1M'
    };
    var THINKING_AUTO = 'auto';

    // ===================== 通用小工具 =====================

    // 文案读取：语言包未就绪或缺失时回落为 key 字面量（各调用点均在渲染时求值，不缓存）
    function t(key) {
        return (root && root.GourdI18n && root.GourdI18n.t) ? root.GourdI18n.t(key) : key;
    }

    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/\x3c/g, '&lt;')
            .replace(/\x3e/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function isArray(v) {
        return Object.prototype.toString.call(v) === '[object Array]';
    }

    // ===================== 上下文窗口工具（与 app-history.js 同口径） =====================

    // 接受后端常见的数字、"256K"、"1M" 表示，最终统一为 token 数；非法输入返回 0。
    function parseContextLengthValue(value) {
        if (typeof value === 'number' && isFinite(value)) return Math.round(value);
        var raw = String(value == null ? '' : value).trim().replace(/[, _]/g, '');
        if (!raw) return 0;
        var matchK = raw.match(/^(\d+(?:\.\d+)?)k$/i);
        var matchM = raw.match(/^(\d+(?:\.\d+)?)m$/i);
        if (matchK) return Math.round(parseFloat(matchK[1]) * 1000);
        if (matchM) return Math.round(parseFloat(matchM[1]) * 1000000);
        var parsed = Number(raw);
        return isFinite(parsed) ? Math.round(parsed) : 0;
    }

    // 未知值一律回退产品默认 256K（与后端 ContextLengthPolicy.normalize 同口径）
    function normalizeContextLength(value, options) {
        var parsed = parseContextLengthValue(value);
        var opts = options && options.length ? options : CONTEXT_LENGTH_OPTIONS;
        for (var i = 0; i < opts.length; i++) {
            if (opts[i] === parsed) return parsed;
        }
        return DEFAULT_CONTEXT_LENGTH;
    }

    function contextLengthLabel(value) {
        var normalized = parseContextLengthValue(value);
        return CONTEXT_LENGTH_LABELS[normalized] || String(normalized);
    }

    // ===================== 思考档位工具（与 app-history.js 同口径） =====================

    // 历史档位值归一：'off' 是 'auto' 的旧名；'minimal' 已取消，就近归入 'low'。
    function normalizeThinkingCode(depth) {
        var d = String(depth == null ? '' : depth).toLowerCase();
        if (!d || d === 'off') return THINKING_AUTO;
        if (d === 'minimal') return 'low';
        return d;
    }

    // 兜底档位集（不含 auto）：仅当后端未下发 thinkingLevels 时使用
    function fallbackThinkingLevels(standard) {
        var s = (standard || '').toLowerCase();
        if (s.indexOf('anthropic') >= 0 || s.indexOf('claude') >= 0) {
            return ['low', 'medium', 'high', 'xhigh', 'max'];
        }
        return ['low', 'medium', 'high'];
    }

    // ===================== 模型行归一 =====================

    /* 兼容三种进料：后端 /web/chat/models 行（description/name/model）、
     * ACP 设置行（name/provider/standard/thinkingLevels）、裸字符串（旧接口）。
     * thinkingLevels 语义：null = 后端未下发（走兜底）；[] = 明确不可调（隐藏档位行）。 */
    function normalizeRow(raw) {
        if (typeof raw === 'string') return { name: raw, model: raw, desc: '', standard: '', provider: '', thinkingLevels: null };
        raw = raw || {};
        var name = raw.name || raw.model || '';
        return {
            name: name,
            model: raw.model || name,
            desc: raw.desc || raw.description || '',
            standard: raw.standard || '',
            provider: raw.provider || '',
            thinkingLevels: isArray(raw.thinkingLevels) ? raw.thinkingLevels : null
        };
    }

    function normalizeRows(list) {
        var out = [];
        for (var i = 0; i < (list || []).length; i++) out.push(normalizeRow(list[i]));
        return out;
    }

    function findModel(models, name) {
        for (var i = 0; i < (models || []).length; i++) {
            if (models[i] && models[i].name === name) return models[i];
        }
        return null;
    }

    // ===================== 档位选项与 chips =====================

    /* 指定模型的思考档位选项集：auto 置顶；其后为模型「真正可区分」的档位
     * （由调用方数据里的 thinkingLevels 提供，由低到高、不含 auto）。
     * null（未下发）→ 按接口类型兜底；[]（明确不可调）→ 仅剩 auto。
     * 每次调用都重建，保证国际化文案取最新语言包。 */
    function thinkingOptionsFor(models, modelName, tFn) {
        var tt = tFn || t;
        var opts = [{
            value: THINKING_AUTO,
            label: tt('history.thinking.auto.label'),
            desc: tt('history.thinking.auto.desc')
        }];
        var row = findModel(models, modelName);
        var levels = row ? row.thinkingLevels : null;
        if (levels == null) levels = fallbackThinkingLevels(row ? row.standard : '');
        for (var i = 0; i < levels.length; i++) {
            var code = levels[i];
            if (!code || code === THINKING_AUTO) continue;
            opts.push({
                value: code,
                label: tt('history.thinking.' + code + '.label'),
                desc: tt('history.thinking.' + code + '.desc')
            });
        }
        return opts;
    }

    // 关联思考档位区（内嵌在当前选中模型项下）：首项为「默认」（auto，跟随模型默认行为）
    function thinkingChipsHtml(models, modelName, value, tFn) {
        var tt = tFn || t;
        var opts = thinkingOptionsFor(models, modelName, tt);

        // 该模型无可区分档位（后端下发空数组）：只剩「默认」一项，选择器无意义 → 不渲染这一行
        if (opts.length <= 1) return '';

        // 当前档位是否在本模型档位集内（切换模型后旧值可能不适用 → 视作默认）
        var valid = THINKING_AUTO;
        for (var k = 0; k < opts.length; k++) {
            if (opts[k].value === value) { valid = value; break; }
        }

        var html = '<div class="model-thinking-opts"><span class="model-thinking-label">'
            + escapeHtml(tt('app.thinking_label')) + '</span>';
        for (var i = 0; i < opts.length; i++) {
            var o = opts[i];
            var cls = o.value === valid ? ' active' : '';
            html += '<span class="model-thinking-chip' + cls + '" data-thinking="' + escapeHtml(o.value) + '"'
                + (o.desc ? ' title="' + escapeHtml(o.desc) + '"' : '')
                + '>' + escapeHtml(o.label) + '</span>';
        }
        html += '</div>';
        return html;
    }

    // 关联上下文窗口区（内嵌在当前选中模型项下）：固定显示可用档位
    function contextChipsHtml(value, options, tFn) {
        var tt = tFn || t;
        var opts = (options && options.length) ? options : CONTEXT_LENGTH_OPTIONS;
        var current = normalizeContextLength(value, opts);
        var html = '<div class="model-context-opts"><span class="model-context-label">'
            + escapeHtml(tt('app.context_label')) + '</span>';
        for (var i = 0; i < opts.length; i++) {
            var v = opts[i];
            var cls = v === current ? ' active' : '';
            html += '<span class="model-context-chip' + cls + '" data-context="' + v + '"'
                + ' title="' + escapeHtml(contextLengthLabel(v)) + '"'
                + '>' + escapeHtml(contextLengthLabel(v)) + '</span>';
        }
        html += '</div>';
        return html;
    }

    // 按钮内思考档位小标签：当前值为默认（auto）或不在档位集内时不显示
    function thinkingTagLabel(models, modelName, value, tFn) {
        var tt = tFn || t;
        if (!value || value === THINKING_AUTO) return '';
        var opts = thinkingOptionsFor(models, modelName, tt);
        for (var i = 0; i < opts.length; i++) {
            if (opts[i].value === value) return opts[i].label;
        }
        return '';
    }

    // ===================== 实例化组件 =====================

    var seq = 0;
    var instances = [];   // 打开互斥：新开一个实例时收起其它实例

    /**
     * 创建绑定到单个 DOM 根的选择器实例。
     * @param cfg {
     *   root           : 根节点（css 选择器 / Element / jQuery）
     *   models         : function() -> 模型行数组（组件内部做归一）
     *   currentModel   : function() -> 当前生效模型名（active 高亮与点击判定）
     *   onSelect       : function(name) 选中非当前模型时回调（回调后组件自动重绘）
     *   onOpen         : function() 下拉展开时回调（可借机收起调用方自家其它浮层）
     *   thinking       : null | { value: function() -> code, onChange: function(code) }
     *   context        : null | { value: function() -> number|'', options?: function() -> [number], onChange: function(v) }
     *   showDesc       : 是否渲染描述行（默认 false）
     *   truncateName   : 按钮内名称截断长度（0 = 不截断）
     * }
     * @return { update, destroy, close }
     */
    function create(cfg) {
        cfg = cfg || {};
        var ns = '.gmsel' + (++seq);
        var $root = resolveRoot(cfg.root);
        var filterText = '';
        var firstMatch = null;
        var alive = true;

        function resolveRoot(v) {
            if (v && v.jquery) return v;
            return $(v);
        }

        function rowModels() {
            return normalizeRows(cfg.models ? cfg.models() : []);
        }

        function currentModel() {
            return cfg.currentModel ? (cfg.currentModel() || '') : '';
        }

        function contextOptionsOf() {
            return (cfg.context && cfg.context.options) ? cfg.context.options() : null;
        }

        function contextValue() {
            return normalizeContextLength(cfg.context.value(), contextOptionsOf());
        }

        // ---- 渲染：按钮层（名称 + 档位/上下文小标签） ----
        function renderButton() {
            var models = rowModels();
            var current = currentModel();
            var row = findModel(models, current);
            // 工具栏按钮显示去前缀短名，避免「GWork-xxx」过长截断
            var display = row ? GourdModelDropdown.shortName(row.name, row.provider) : current;
            if (cfg.truncateName && display && display.length > cfg.truncateName) {
                display = display.substring(0, cfg.truncateName) + '...';
            }
            if (!display) display = t('history.default_model');
            $root.find('.model-selector-current .model-name').text(display);

            var $thinkTag = $root.find('.model-selector-current .model-thinking-tag');
            var tag = cfg.thinking ? thinkingTagLabel(models, current, cfg.thinking.value()) : '';
            $thinkTag.text(tag).toggle(!!tag);

            var $ctxTag = $root.find('.model-selector-current .model-context-tag');
            if (cfg.context) {
                var label = contextLengthLabel(contextValue());
                $ctxTag.text(label).attr('title', t('app.context_label') + ' ' + label).toggle(!!label);
            } else {
                $ctxTag.hide();
            }
        }

        // ---- 渲染：列表层（只动列表 HTML，搜索框保持焦点与已输入内容） ----
        function renderList() {
            var $list = $root.find('.model-dropdown-list');
            if (!$list.length) return;
            var models = rowModels();
            var current = currentModel();
            var currentRow = findModel(models, current);
            // 严格保持接口顺序；仅当 provider 与紧邻上一模型不同时插入标题（允许同一 provider 重复出现）
            var result = GourdModelDropdown.render({
                segments: GourdModelDropdown.toSegments(ModelListOrder.buildEntries(models)),
                query: filterText,
                currentModel: current,
                currentProvider: currentRow ? (currentRow.provider || '') : '',
                otherLabel: t('history.model_group_other'),
                emptyText: t('history.model_search_empty'),
                toggleTitle: t('history.model_group_toggle'),
                itemHtml: function (m, active, provider) {
                    var shortName = GourdModelDropdown.shortName(m.name, provider || m.provider);
                    // 描述与模型 ID 相同时属冗余信息（名称行已展示），不再重复渲染第二行
                    var desc = m.desc || '';
                    if (desc && m.model && desc === m.model) desc = '';
                    var html = '<div class="model-dropdown-item' + (active ? ' active' : '') + '" data-model="' + escapeHtml(m.name) + '">'
                        + '<span class="model-item-name">' + escapeHtml(shortName) + '</span>'
                        + ((cfg.showDesc && desc) ? '<span class="model-item-desc">' + escapeHtml(desc) + '</span>' : '');
                    // 关联选择：思考档位与上下文窗口内嵌在当前选中模型项下，跟随所选模型展示
                    if (active) {
                        if (cfg.thinking) html += thinkingChipsHtml(models, m.name, cfg.thinking.value());
                        if (cfg.context) html += contextChipsHtml(contextValue(), contextOptionsOf());
                    }
                    return html + '</div>';
                }
            });
            $list.html(result.html);
            firstMatch = result.firstModel;
        }

        function render() {
            if (!alive || !$root.length) return;
            renderButton();
            renderList();
        }

        // ---- 开合 ----
        function closeSelf() {
            $root.removeClass('open');
        }

        function openSelf() {
            // 打开互斥：同一时刻只保留一个展开的选择器
            for (var i = 0; i < instances.length; i++) {
                if (instances[i] !== handle) instances[i].close();
            }
            // 打开前回调：调用方可借机收起自家其它浮层（如自动化页的工作空间下拉）
            if (cfg.onOpen) cfg.onOpen();
            $root.addClass('open');
            // 每次打开都从完整列表开始：清空上次关键词并自动聚焦，可直接敲字筛选
            if (filterText) { filterText = ''; renderList(); }
            var $input = $root.find('.model-search-input');
            $input.val('');
            $root.find('.model-search-clear').hide();
            // 打开即定位到当前选中模型（居中）；无选中项/所在组被折叠时退回置顶
            var listEl = $root.find('.model-dropdown-list')[0];
            if (listEl && !GourdModelDropdown.scrollToActive(listEl)) listEl.scrollTop = 0;
            setTimeout(function () { try { $input.focus(); } catch (err) {} }, 0);
        }

        // ---- 事件（全部委托到根节点，带命名空间便于 destroy） ----
        function bind() {
            if (!$root.length) return;

            $root.on('click' + ns, '.model-selector-current', function (e) {
                e.stopPropagation();
                if ($root.hasClass('open')) closeSelf();
                else openSelf();
            });

            // 搜索框：输入即过滤（只重绘列表层，不动搜索框，焦点与光标位置不丢）
            $root.on('input' + ns, '.model-search-input', function () {
                filterText = $(this).val() || '';
                $root.find('.model-search-clear').toggle(!!filterText);
                renderList();
                $root.find('.model-dropdown-list').scrollTop(0);
            });

            $root.on('keydown' + ns, '.model-search-input', function (e) {
                if (e.key === 'Escape' || e.keyCode === 27) {
                    e.stopPropagation();
                    // 有关键词时先清空关键词，再按一次才收起下拉
                    if (filterText) {
                        filterText = '';
                        $(this).val('');
                        $root.find('.model-search-clear').hide();
                        renderList();
                    } else {
                        closeSelf();
                    }
                    return;
                }
                if (e.key === 'Enter' || e.keyCode === 13) {
                    e.preventDefault();
                    e.stopPropagation();
                    // 回车选中当前过滤结果的首项；与当前生效模型相同时视为确认收起
                    if (firstMatch && firstMatch !== currentModel()) {
                        if (cfg.onSelect) cfg.onSelect(firstMatch);
                        render();
                    } else {
                        closeSelf();
                    }
                }
            });

            $root.on('click' + ns, '.model-dropdown', function (e) {
                // 下拉内部点击一律不冒泡：否则点搜索框/组头/空白处会被外部收起器关闭（搜索框将无法输入）
                e.stopPropagation();

                // 清空按钮
                if ($(e.target).closest('.model-search-clear').length) {
                    filterText = '';
                    var $input = $root.find('.model-search-input');
                    $input.val('').focus();
                    $root.find('.model-search-clear').hide();
                    renderList();
                    return;
                }

                // 服务商组头：折叠/展开（状态持久化，与聊天页共享）
                var $group = $(e.target).closest('.model-dropdown-group');
                if ($group.length) {
                    var $wrap = $group.closest('.model-dropdown-group-wrap');
                    GourdModelDropdown.setCollapsed($group.attr('data-provider') || '', !$wrap.hasClass('collapsed'));
                    renderList();
                    return;
                }

                // 关联上下文窗口 chip：仅设值，不切模型；保持下拉打开便于连续调整
                var $ctxChip = $(e.target).closest('.model-context-chip');
                if ($ctxChip.length && cfg.context) {
                    var v = normalizeContextLength($ctxChip.attr('data-context'), contextOptionsOf());
                    if (v !== contextValue()) {
                        cfg.context.onChange(v);
                        render();
                    }
                    return;
                }

                // 关联思考档位 chip：仅设值，不切模型；保持下拉打开便于连续调整
                var $chip = $(e.target).closest('.model-thinking-chip');
                if ($chip.length && cfg.thinking) {
                    var depth = $chip.attr('data-thinking');
                    if (depth != null && depth !== cfg.thinking.value()) {
                        cfg.thinking.onChange(depth);
                        render();
                    }
                    return;
                }

                var $item = $(e.target).closest('.model-dropdown-item');
                if (!$item.length) return;
                var name = $item.attr('data-model');
                if (name == null) return;
                // 点当前已选模型项：视为「确认/收起」动作，关闭下拉；切换模型则保持打开，
                // 让用户继续在新模型项下选择思考档位（关联选择）
                if (name === currentModel()) { closeSelf(); return; }
                if (cfg.onSelect) cfg.onSelect(name);
                render();
            });

            // 外部点击收起（本实例只收自己；stopPropagation 已挡下拉内部与按钮）
            $(document).on('click' + ns, function (e) {
                if (!$(e.target).closest($root).length) closeSelf();
            });
        }

        function destroy() {
            alive = false;
            $root.off(ns);
            $(document).off(ns);
            var idx = instances.indexOf(handle);
            if (idx >= 0) instances.splice(idx, 1);
            $root.removeClass('open');
        }

        var handle = { update: render, destroy: destroy, close: closeSelf };
        instances.push(handle);
        bind();
        return handle;
    }

    // 语言切换：重绘所有存活实例（无需各页自行注册）
    if (root && root.document && root.document.addEventListener) {
        root.document.addEventListener('i18n:localeChanged', function () {
            for (var i = 0; i < instances.length; i++) {
                try { instances[i].update(); } catch (e) { console.error('[i18n] model selector update failed:', e); }
            }
        });
    }

    return {
        DEFAULT_CONTEXT_LENGTH: DEFAULT_CONTEXT_LENGTH,
        CONTEXT_LENGTH_OPTIONS: CONTEXT_LENGTH_OPTIONS,
        CONTEXT_LENGTH_LABELS: CONTEXT_LENGTH_LABELS,
        THINKING_AUTO: THINKING_AUTO,
        escapeHtml: escapeHtml,
        parseContextLengthValue: parseContextLengthValue,
        normalizeContextLength: normalizeContextLength,
        contextLengthLabel: contextLengthLabel,
        normalizeThinkingCode: normalizeThinkingCode,
        fallbackThinkingLevels: fallbackThinkingLevels,
        normalizeRow: normalizeRow,
        normalizeRows: normalizeRows,
        thinkingOptionsFor: thinkingOptionsFor,
        thinkingChipsHtml: thinkingChipsHtml,
        contextChipsHtml: contextChipsHtml,
        thinkingTagLabel: thinkingTagLabel,
        create: create
    };
});
