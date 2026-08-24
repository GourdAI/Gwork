/**
 * 模型配置独立主视图（左侧栏「模型配置」入口）
 *
 * 双栏 Master-Detail 交互：左栏供应商列表（内置/自定义分组 + 启用开关），
 * 右栏详情/表单常驻——点击左栏项或「添加供应商」时右栏原地切换，无列表/表单往返。
 * 编辑模式所有字段变更即时保存；新增模式走底部「添加供应商」按钮。
 * 复用 /web/settings/providers 系列 API；DOM id 统一 ms 前缀。
 */
;(function () {
    'use strict';

    var core = window._settingsCore || {};
    var postJson = core.postJson;
    var escapeAttr = core.escapeAttr || function (s) { return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    var escapeHtml = core.escapeHtml || function (s) { return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
    var showToast = core.showToast || function (msg, type) { layAlert(msg); };

    // ==================== 状态管理 ====================
    var LS_PROVIDER_ORDER = 'gourdai-provider-order'; // 自定义供应商拖拽排序持久化（仅本地展示顺序，不影响后端按名称存储）
    var providers = [];
    var currentProvider = null; // 当前编辑的连接（null 表示新增）
    var fetchedModels = []; // 已拉取/已配置的模型列表
    var selectedName = null; // 左栏选中项（'__add__' 表示右侧为新增表单）
    // 左栏是否展示内置供应商（当前按产品要求暂屏蔽，需恢复时改为 true）
    var SHOW_BUILTIN_PROVIDERS = false;

    // 接口类型选项（按模型单独配置）
    var STANDARD_OPTIONS = [
        { value: 'openai', label: 'OpenAI (Chat Completions)' },
        { value: 'openai-responses', label: 'OpenAI (Responses)' },
        { value: 'anthropic', label: 'Anthropic (Messages)' },
        { value: 'gemini', label: 'Google (Gemini)' }
    ];
    var DEFAULT_STANDARD = 'openai';

    // ==================== DOM 元素 ====================
    var $view = $('#modelSettingsView');
    var $groupBuiltin = $('#msGroupBuiltin');
    var $customGroup = $('#msGroupCustom');
    var $builtinList = $('#msBuiltinList');
    var $customList = $('#msCustomList');
    var $formTitle = $('#msProviderFormTitle');
    var $formDesc = $('#msProviderFormDesc');
    var $modelsList = $('#msProviderModelsList');
    var $modelsEmpty = $('#msProviderModelsEmpty');

    // ==================== 初始化 ====================
    function init() {
        bindEvents();
        // 桌面端冷启动时后端 jar 尚未就绪，直接拉取会失败并弹“加载失败”。
        // 与其它启动即拉取的模块一致，改经 __whenBackendReady 门闸延后到后端就绪再发。
        __whenBackendReady(loadProvidersList);
    }

    function bindEvents() {
        // 添加供应商按钮（右栏切换为新增表单）
        $('#msProviderAddBtn').on('click', function () {
            selectAdd();
        });

        // 拉取模型列表
        $('#msProviderFetchModelsBtn').on('click', function () {
            fetchModels();
        });

        // 清空模型列表
        $('#msProviderClearModelsBtn').on('click', function () {
            if (fetchedModels.length === 0) return;
            var tConfirm = GourdI18n.t('settings.confirm_delete') + GourdI18n.t('settings.providers.model_management') + '？' + GourdI18n.t('settings.providers.add_model') + GourdI18n.t('common.delete');
            layConfirm(tConfirm, function () {
                fetchedModels = [];
                renderModelsList();
                if (currentProvider) {
                    persistProvider();
                }
            });
        });

        // 手动添加模型
        $('#msProviderAddModelBtn').on('click', function () {
            openModelDialog(null);
        });

        // 模型列表 - 删除手动模型
        $modelsList.on('click', '.provider-model-remove-btn', function () {
            var modelId = $(this).closest('.provider-model-item').data('model-id');
            removeManualModel(modelId);
        });

        // 模型列表 - 点击模型信息，弹出修改配置弹框
        $modelsList.on('click', '.provider-model-info', function () {
            var modelId = $(this).closest('.provider-model-item').data('model-id');
            var model = null;
            for (var i = 0; i < fetchedModels.length; i++) {
                if (String(fetchedModels[i].id) === String(modelId)) {
                    model = fetchedModels[i];
                    break;
                }
            }
            if (model) openModelDialog(model);
        });

        // 保存按钮
        $('#msProviderSaveBtn').on('click', function () {
            saveProvider();
        });

        // 删除按钮
        $('#msProviderFormDeleteBtn').on('click', function () {
            deleteProvider();
        });

        // 供应商项点击（选中 -> 右栏详情原地切换）：左栏容器为静态 DOM，事件委托一次即可
        $('.model-settings-left').on('click', '.ms-provider-item', function (e) {
            // 忽略启用/禁用开关与拖拽手柄点击
            if ($(e.target).closest('.toggle-switch, .ms-provider-drag-handle').length) return;
            selectProvider($(this).data('name'));
        });

        // ===== 自定义供应商拖拽排序（HTML5 原生 DnD，无第三方依赖）=====
        var dragState = null;
        var $dragIndicator = null;

        // 仅当按住手柄时才给项加 draggable，避免干扰点击选中与开关操作
        // 注意：此处绝不能 e.preventDefault()——取消 mousedown 默认行为会阻止浏览器发起 HTML5 拖拽；
        // 防文本选择改由 CSS user-select: none 承担
        $('.model-settings-left').on('mousedown', '.ms-provider-drag-handle', function () {
            $(this).closest('.ms-provider-item').attr('draggable', 'true');
        });
        $(document).on('mouseup', function () {
            $('.ms-provider-item[draggable]').removeAttr('draggable');
        });

        function cleanupDrag() {
            $customList.find('.ms-provider-item').removeClass('dragging').removeAttr('draggable');
            if ($dragIndicator) $dragIndicator.remove();
            dragState = null;
        }

        function customNamesInDomOrder() {
            var names = [];
            $customList.find('.ms-provider-item').each(function () { names.push($(this).data('name')); });
            return names;
        }

        $customList.on('dragstart', '.ms-provider-item', function (e) {
            var $item = $(this);
            dragState = $item.data('name');
            e.originalEvent.dataTransfer.effectAllowed = 'move';
            try { e.originalEvent.dataTransfer.setData('text/plain', dragState); } catch (err) { /* 旧内核兼容 */ }
            // 延迟加类，保证拖拽快照（drag image）是正常外观
            setTimeout(function () { $item.addClass('dragging'); }, 0);
        });

        $customList.on('dragover', '.ms-provider-item', function (e) {
            if (!dragState) return;
            e.preventDefault();
            e.originalEvent.dataTransfer.dropEffect = 'move';
            var $self = $(this);
            if ($self.data('name') === dragState) {
                if ($dragIndicator) $dragIndicator.remove();
                return;
            }
            var rect = this.getBoundingClientRect();
            var after = (e.originalEvent.clientY - rect.top) > rect.height / 2;
            if (!$dragIndicator) $dragIndicator = $('<div class="ms-drag-indicator"></div>');
            if (after) { $self.after($dragIndicator); } else { $self.before($dragIndicator); }
        });

        $customList.on('drop', '.ms-provider-item', function (e) {
            if (!dragState) return;
            e.preventDefault();
            e.stopImmediatePropagation(); // 阻止下方容器级「拖到空白=末尾」兜底逻辑重复执行
            var from = dragState;
            cleanupDrag();
            var to = $(this).data('name');
            if (from === to) return;
            var rect = this.getBoundingClientRect();
            var after = (e.originalEvent.clientY - rect.top) > rect.height / 2;
            var names = customNamesInDomOrder();
            var fromIdx = names.indexOf(from);
            if (fromIdx === -1) return;
            names.splice(fromIdx, 1);
            var toIdx = names.indexOf(to);
            if (toIdx === -1) return;
            names.splice(after ? toIdx + 1 : toIdx, 0, from);
            saveProviderOrder(names);
            renderProviderList();
        });

        $customList.on('dragend', '.ms-provider-item', cleanupDrag);

        // 容器级兜底：落在指示线/项间隙/列表末尾空白处
        $customList.on('dragover', function (e) {
            if (!dragState) return;
            e.preventDefault();
            e.originalEvent.dataTransfer.dropEffect = 'move';
        });
        $customList.on('drop', function (e) {
            if (!dragState) return;
            e.preventDefault();
            var from = dragState;
            // 指示线存在 = 按指示线位置插入（统计指示线前的供应商项数）；
            // 无指示线（落在列表末尾空白）= 移到末尾
            var insertAt = null;
            if ($dragIndicator && $dragIndicator.length && $dragIndicator[0].parentNode === $customList[0]) {
                insertAt = 0;
                $customList.children().each(function () {
                    if (this === $dragIndicator[0]) return false;
                    if ($(this).hasClass('ms-provider-item')) insertAt++;
                });
            }
            cleanupDrag();
            var names = customNamesInDomOrder();
            var fromIdx = names.indexOf(from);
            if (fromIdx === -1) return;
            names.splice(fromIdx, 1);
            if (insertAt === null) insertAt = names.length;
            else if (fromIdx < insertAt) insertAt--;
            names.splice(insertAt, 0, from);
            saveProviderOrder(names);
            renderProviderList();
        });

        // 启用/禁用开关（状态直接在左栏项上呈现）
        $('.model-settings-left').on('change', '.provider-toggle', function () {
            var name = $(this).closest('.ms-provider-item').data('name');
            var enabled = $(this).prop('checked');
            toggleProvider(name, enabled);
        });

        // 模型列表 - 启用/禁用开关
        $modelsList.on('change', '.provider-model-toggle', function () {
            var modelId = $(this).closest('.provider-model-item').data('model-id');
            var enabled = $(this).prop('checked');
            var llmName = $(this).data('llm-name');
            var isSynced = $(this).data('synced') === true || $(this).data('synced') === 'true';
            toggleProviderModel(modelId, enabled, llmName, isSynced);
        });

        // 模型列表 - 接口类型切换（按模型，layui select）：编辑模式下即时生效
        if (typeof layui !== 'undefined' && layui.form) {
            layui.form.on('select(msModelStd)', function (data) {
                var modelId = $(data.elem).data('model-id');
                var std = data.value;
                for (var i = 0; i < fetchedModels.length; i++) {
                    if (fetchedModels[i].id === modelId) {
                        fetchedModels[i].standard = std;
                        break;
                    }
                }
                if (currentProvider) {
                    persistProvider();
                }
            });
        }

        // 连接基础字段（作用域/模型列表接口/API 地址/密钥/超时）：编辑模式下变更即时保存；新增模式仍走保存按钮
        $('.settings-scope-toggle[data-target="msProviderScope"]').on('click', '.settings-scope-btn', function () {
            if (currentProvider) {
                // 先同步隐藏域，再持久化（通用作用域切换 handler 在 app-settings.js，两者幂等）
                $('#msProviderScope').val($(this).data('scope'));
                persistProvider();
            }
        });
        $('input[name="msProviderStandard"]').on('change', function () {
            if (currentProvider) persistProvider();
        });
        $('#msProviderApiUrl, #msProviderApiKey, #msProviderTimeout').on('change', function () {
            if (currentProvider) persistProvider();
        });

        // 批量选择菜单
        $('#msProviderModelsSelectToggle').on('click', function (e) {
            e.stopPropagation();
            $('#msProviderModelsActionMenu').toggleClass('show');
        });

        $(document).on('click', function (e) {
            if ($(e.target).closest('.provider-model-menu-wrap').length === 0) {
                $('#msProviderModelsActionMenu').removeClass('show');
            }
        });

        $('#msProviderModelsSelectAll, #msProviderModelsSelectNone, #msProviderModelsInvert').on('click', function () {
            var action = this.id;
            var changed = false;

            $modelsList.find('.provider-model-toggle').each(function () {
                var $toggle = $(this);
                var nextChecked = $toggle.prop('checked');

                if (action === 'msProviderModelsSelectAll') {
                    nextChecked = true;
                } else if (action === 'msProviderModelsSelectNone') {
                    nextChecked = false;
                } else if (action === 'msProviderModelsInvert') {
                    nextChecked = !$toggle.prop('checked');
                }

                if ($toggle.prop('checked') !== nextChecked) {
                    changed = true;
                    $toggle.prop('checked', nextChecked).trigger('change');
                }
            });

            $('#msProviderModelsActionMenu').removeClass('show');
        });

        // 作用域切换（app-settings.js 的通用 handler 仅管 active 态与隐藏域同步，
        // 此处自绑一份保证主视图独立可用，与设置弹框原行为一致）
        $('.settings-scope-toggle[data-target="msProviderScope"]').on('click', '.settings-scope-btn', function () {
            var $toggle = $(this).closest('.settings-scope-toggle');
            var target = $toggle.data('target');
            var scope = $(this).data('scope');
            $toggle.find('.settings-scope-btn').removeClass('active');
            $(this).addClass('active');
            $('#' + target).val(scope);
        });
    }

    // ==================== 视图入口（独立主视图，与自动化/技能/远控通道同构） ====================

    /** 打开模型配置视图（由左侧栏「模型配置」导航触发） */
    function openModelSettings() {
        // 与聊天/欢迎/自动化/技能/远控通道视图互斥：隐藏它们，显示本视图
        if (typeof window.exitCodeMode === 'function' && window.appMode === 'code') {
            window.exitCodeMode();
        }
        if (typeof window.closeAutomation === 'function') window.closeAutomation();
        if (typeof window.closeSkills === 'function') window.closeSkills();
        if (typeof window.closeChannel === 'function') window.closeChannel();
        if (typeof window.closeMemoryView === 'function') window.closeMemoryView();
        $('#welcomeView').hide();
        $('#chatView').removeClass('active');
        $('#modelSettingsView').addClass('active');
        $('.main-nav-item').removeClass('active');
        $('#modelConfigNavBtn').addClass('active');

        // 独立视图既不属于 chat 也不属于 welcome，必须让出 inChatMode（与 automation 一致），
        // 否则切回聊天时 #chatView 拿不回 .active（主区停留白屏）
        window.inChatMode = false;

        // 关掉可能打开的设置浮层（浮层为高 z-index 遮罩，会盖住本视图）
        if (typeof window.closeSettings === 'function') window.closeSettings();
        else if ($('#settingsOverlay').is(':visible')) $('#settingsCloseBtn').trigger('click');

        // 默认右栏为「添加供应商」表单（对齐参考交互），左栏列表异步加载
        selectAdd();
        loadProvidersList();
    }

    /** 离开模型配置视图（切回聊天/欢迎/自动化/技能时由对应切换函数调用） */
    function closeModelSettings() {
        $('#modelSettingsView').removeClass('active');
        $('#modelConfigNavBtn').removeClass('active');
        currentProvider = null;
        fetchedModels = [];
        selectedName = null;
        $('#msProviderModelsActionMenu').removeClass('show');
        // 通知聊天组件刷新模型下拉
        if (typeof window.reloadModels === 'function') {
            window.reloadModels();
        }
    }

    // ==================== 左栏供应商列表 ====================
    /** 读取本地保存的自定义供应商展示顺序 */
    function readProviderOrder() {
        try {
            var raw = localStorage.getItem(LS_PROVIDER_ORDER);
            var arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
    }

    /** 按本地保存顺序重排 providers（内置组保持后端原顺序且恒在上方） */
    function applyProviderOrder() {
        var saved = readProviderOrder();
        if (!saved.length) return;
        var rank = {};
        saved.forEach(function (n, i) { rank[n] = i; });
        providers.sort(function (a, b) {
            if (!!a.builtin !== !!b.builtin) return a.builtin ? -1 : 1;
            if (a.builtin) return 0;
            return (rank[a.name] !== undefined ? rank[a.name] : 9999) - (rank[b.name] !== undefined ? rank[b.name] : 9999);
        });
    }

    /** 持久化展示顺序：裁剪已删除的名称，并追加新增的自定义供应商 */
    function saveProviderOrder(names) {
        var valid = {};
        providers.forEach(function (p) { if (!p.builtin) valid[p.name] = true; });
        var pruned = (names || []).filter(function (n) { return valid[n]; });
        providers.forEach(function (p) {
            if (!p.builtin && pruned.indexOf(p.name) === -1) pruned.push(p.name);
        });
        try { localStorage.setItem(LS_PROVIDER_ORDER, JSON.stringify(pruned)); } catch (e) { /* 存储不可用时忽略 */ }
    }

    function loadProvidersList(onDone) {
        $.ajax({
            url: '/web/settings/providers',
            method: 'GET',
            success: function (res) {
                if (res.code === 200) {
                    providers = res.data || [];
                    // 若当前选中项仍存在于新列表（且未被屏蔽）中则保持选中，否则回落到「添加供应商」表单
                    if (selectedName !== '__add__') {
                        var stillExists = false;
                        providers.forEach(function (p) { if (p.name === selectedName && (!p.builtin || SHOW_BUILTIN_PROVIDERS)) stillExists = true; });
                        if (!stillExists) {
                            selectedName = '__add__';
                        }
                    }
                    renderProviderList();
                    // 右栏详情仅在视图已打开时同步（冷启动预载/视图未激活时只更新左栏，
                    // 打开视图时 openModelSettings 会显式 selectAdd + 重新拉取）
                    if ($view.hasClass('active')) {
                        if (selectedName === '__add__') {
                            selectAdd();
                        } else {
                            fillDetailFromCache(selectedName);
                        }
                    }
                }
            },
            error: function () {
                showToast(GourdI18n.t('common.loading') + GourdI18n.t('settings.providers.title') + GourdI18n.t('settings.loop.operation_failed'), 'error');
            },
            complete: function () {
                if (onDone) onDone();
            }
        });
    }

    function renderProviderList() {
        applyProviderOrder();
        var builtinHtml = '';
        var customHtml = '';
        var hasBuiltin = false;
        var hasCustom = false;

        providers.forEach(function (provider) {
            // 内置供应商暂屏蔽：不渲染、不计入分组（内置分组标签随 hasBuiltin 自动隐藏）
            if (provider.builtin && !SHOW_BUILTIN_PROVIDERS) return;
            var item = renderProviderItem(provider);
            if (provider.builtin) {
                builtinHtml += item;
                hasBuiltin = true;
            } else {
                customHtml += item;
                hasCustom = true;
            }
        });

        $groupBuiltin.toggle(hasBuiltin);
        $customGroup.toggle(hasCustom);
        $builtinList.html(builtinHtml);
        $customList.html(customHtml);
    }

    function renderProviderItem(provider) {
        var modelsCount = (provider.models || []).length;
        var selected = (selectedName === provider.name) ? ' selected' : '';
        // 拖拽手柄：仅自定义供应商渲染（内置项不可排序）
        var dragHandle = provider.builtin ? '' :
            '<span class="ms-provider-drag-handle"><svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="2.5" cy="2.5" r="1.4"/><circle cx="7.5" cy="2.5" r="1.4"/><circle cx="2.5" cy="7" r="1.4"/><circle cx="7.5" cy="7" r="1.4"/><circle cx="2.5" cy="11.5" r="1.4"/><circle cx="7.5" cy="11.5" r="1.4"/></svg></span>';
        return '<div class="ms-provider-item' + selected + (provider.enabled === false ? ' disabled' : '') + '" data-name="' + escapeAttr(provider.name) + '">' +
            dragHandle +
            '<div class="ms-provider-icon' + (provider.builtin ? ' builtin' : ' custom') + '">' + escapeHtml((provider.name || 'B')[0].toUpperCase()) + '</div>' +
            '<div class="ms-provider-info">' +
                '<div class="ms-provider-name">' + escapeHtml(provider.name) + '</div>' +
                '<div class="ms-provider-count">' + modelsCount + ' ' + GourdI18n.t('settings.providers.title') + '</div>' +
            '</div>' +
            '<label class="toggle-switch">' +
                '<input type="checkbox" ' + (provider.enabled ? 'checked' : '') + ' data-name="' + escapeAttr(provider.name) + '" class="provider-toggle"/>' +
                '<span class="toggle-slider"></span>' +
            '</label>' +
            '<span class="ms-provider-dot' + (provider.enabled !== false ? ' on' : '') + '"></span>' +
        '</div>';
    }

    // ==================== 右栏详情/表单（Master-Detail：原地切换，不隐藏左栏） ====================
    /** 右栏切换为「添加供应商」表单（新增态） */
    function selectAdd() {
        selectedName = '__add__';
        currentProvider = null;
        fetchedModels = [];
        // 左栏选中态同步
        $('.ms-provider-item').removeClass('selected');
        renderDetailForm(null);
    }

    /** 选中左栏某供应商：右栏切换为其编辑详情 */
    function selectProvider(name) {
        if (selectedName === name) return; // 已选中，避免重复拉取
        selectedName = name;
        $('.ms-provider-item').removeClass('selected');
        $('.ms-provider-item[data-name="' + escapeAttr(name) + '"]').addClass('selected');
        fillDetailFromCache(name);
    }

    /** 填充右栏：先用列表缓存快速回填基础字段，再拉取后端详情（含未脱敏密钥与完整模型列表）覆盖 */
    function fillDetailFromCache(name) {
        var cached = null;
        providers.forEach(function (p) { if (p.name === name) cached = p; });
        if (cached) {
            renderDetailForm(cached);
            // 列表接口返回的 apiKey 是脱敏值：清空输入框等待详情接口回填真实密钥，
            // 防止脱敏值进入右栏后被即时保存写回后端污染真实密钥
            $('#msProviderApiKey').val('');
        }
        editProvider(name);
    }

    /** 填充右栏详情表单（provider 为 null 表示新增态） */
    function renderDetailForm(provider) {
        currentProvider = provider;
        // 复制模型列表，并为每个模型补齐接口类型（缺省 openai）
        fetchedModels = (provider && provider.models) ? provider.models.map(function (m) {
            return {
                id: m.id,
                manual: m.manual || false,
                standard: m.standard || (provider.standard || DEFAULT_STANDARD),
                maxInputTokens: m.maxInputTokens,
                enabled: m.enabled !== false
            };
        }) : [];

        // 标题与描述：新增态=添加模型供应商；编辑态=编辑「名称」
        if (provider) {
            $formTitle.text(GourdI18n.t('settings.providers.edit_title') + '：' + provider.name);
            $formDesc.text(provider.apiUrl || '');
        } else {
            $formTitle.text(GourdI18n.t('settings.providers.add_provider_title'));
            $formDesc.text(GourdI18n.t('settings.providers.add_provider_desc'));
        }

        // 填充表单
        var isBuiltin = !!(provider && provider.builtin);
        $('#msProviderName').val(provider ? provider.name : '').prop('readonly', !!provider);
        var stdVal = provider ? (provider.standard || DEFAULT_STANDARD) : DEFAULT_STANDARD;
        $('input[name="msProviderStandard"]').prop('checked', false)
            .filter('[value="' + stdVal + '"]').prop('checked', true);
        // 内置连接：API 地址锁定只读（名称已在编辑态 readonly）
        $('#msProviderApiUrl').val(provider ? provider.apiUrl : '').prop('readonly', isBuiltin);
        $('#msProviderApiKey').val(provider ? provider.apiKey : '');
        $('#msProviderTimeout').val(provider && provider.timeout ? provider.timeout : '');
        $('#msProviderScope').val(provider ? (provider.scope || 'user') : 'user');

        // 内置连接不可删除：隐藏删除按钮（其余字段照常可编辑）
        $('#msProviderFormActions').toggle(!!provider && !isBuiltin);

        // 仅内置服务商（GWork 官方托管）显示"访问官网获取 API 密钥"提示，其它自定义服务商不显示
        $('#msProviderBuiltinKeyHint').toggle(isBuiltin);

        // 设置作用域按钮状态
        var scope = provider ? (provider.scope || 'user') : 'user';
        $('.settings-scope-toggle[data-target="msProviderScope"] .settings-scope-btn').removeClass('active');
        $('.settings-scope-toggle[data-target="msProviderScope"] .settings-scope-btn[data-scope="' + scope + '"]').addClass('active');

        // 渲染"模型列表接口" layui 单选，使皮肤与选中态同步
        if (typeof layui !== 'undefined' && layui.form) {
            layui.form.render('radio', 'msProviderStandardForm');
        }

        // 编辑模式：页面内操作均即时生效，隐藏提交行（新增模式保留「添加供应商」按钮）
        $('#msProviderFormSubmitRow').toggle(!provider);

        // 加载 LLM 模型缓存后渲染模型列表
        loadLlmModelsCache(function () {
            renderModelsList();
        });
    }

    // ==================== 模型列表 ====================
    var llmModelsCache = {}; // 缓存 LLM 模型列表，用于判断是否已同步

    // 将 token 数格式化为便于阅读的输入值（128000 -> "128k"）
    function formatTokensInput(n) {
        if (!n || n <= 0) return '';
        if (n % 1000000 === 0) return (n / 1000000) + 'm';
        if (n % 1000 === 0) return (n / 1000) + 'k';
        return String(n);
    }

    // 解析上下文长度输入（"128k"/"1m"/数字 -> token 数），无效返回 undefined
    function parseTokensInput(raw) {
        var maxTokens = (raw || '').trim();
        if (!maxTokens) return undefined;
        var trimmed = maxTokens.replace(/[, _]/g, '');
        var matchK = trimmed.match(/^(\d+\.?\d*)k$/i);
        var matchM = trimmed.match(/^(\d+\.?\d*)m$/i);
        if (matchK) return Math.round(parseFloat(matchK[1]) * 1000);
        if (matchM) return Math.round(parseFloat(matchM[1]) * 1000000);
        if (parseInt(trimmed, 10) > 0) return parseInt(trimmed, 10);
        return undefined;
    }

    // 添加 / 修改模型弹框（model 为 null 表示新增，否则为编辑）
    // 结构与设置弹框完全一致（model-add-* 组件类），id 加 ms 前缀避免与设置弹框弹框冲突
    function openModelDialog(model) {
        var isEdit = !!model;
        var curStd = isEdit ? (model.standard || DEFAULT_STANDARD) : DEFAULT_STANDARD;
        var manualStdOptions = '';
        STANDARD_OPTIONS.forEach(function (opt) {
            manualStdOptions += '<option value="' + opt.value + '"' + (opt.value === curStd ? ' selected' : '') + '>' + opt.label + '</option>';
        });
        var nameVal = isEdit ? escapeAttr(model.id) : '';
        var tokensVal = isEdit ? escapeAttr(formatTokensInput(model.maxInputTokens)) : '';
        var dialogHtml = '<div class="model-add-overlay" id="msModelAddOverlay">'
            + '<div class="model-add-dialog">'
            + '<div class="model-add-header">'
             + '<span class="model-add-title">' + (isEdit ? GourdI18n.t('common.edit') + GourdI18n.t('settings.providers.model_management') : GourdI18n.t('settings.providers.add_model')) + '</span>'
            + '<button class="model-add-close" id="msModelAddClose">&times;</button>'
            + '</div>'
            + '<div class="model-add-body">'
            + '<div class="form-group">'
             + '<label>' + GourdI18n.t('settings.providers.model_name') + ' <span class="required">*</span></label>'
             + '<input type="text" id="msManualModelName" placeholder="' + GourdI18n.t('settings.providers.model_id') + ' (e.g. gpt-4o-mini)" value="' + nameVal + '">'
            + '</div>'
            + '<div class="form-group layui-form" lay-filter="msManualModelForm">'
             + '<label>' + GourdI18n.t('settings.providers.model_standard') + ' <span class="required">*</span></label>'
             + '<select id="msManualModelStandard" lay-filter="msManualModelStandard">' + manualStdOptions + '</select>'
            + '</div>'
            + '<div class="form-group">'
             + '<label>' + GourdI18n.t('settings.providers.model_context') + '</label>'
             + '<input type="text" id="msManualModelTokens" inputmode="numeric" placeholder="' + GourdI18n.t('settings.providers.model_context') + '" list="msManualContextLengthList" autocomplete="off" value="' + tokensVal + '">'
            + '<datalist id="msManualContextLengthList">'
            + '<option value="128k">'
            + '<option value="256k">'
            + '<option value="512k">'
            + '<option value="1m">'
            + '</datalist>'
            + '</div>'
            + '</div>'
            + '<div class="model-add-footer">'
             + '<button class="btn-secondary" id="msModelAddCancel">' + GourdI18n.t('common.cancel') + '</button>'
             + '<button class="btn-primary" id="msModelAddConfirm">' + (isEdit ? GourdI18n.t('common.save') + GourdI18n.t('common.edit') : GourdI18n.t('common.confirm') + GourdI18n.t('common.add')) + '</button>'
            + '</div>'
            + '</div>'
            + '</div>';

        $('body').append(dialogHtml);

        var $overlay = $('#msModelAddOverlay');

        // 渲染弹框内的 layui 接口类型下拉
        var manualStandard = curStd;
        if (typeof layui !== 'undefined' && layui.form) {
            layui.form.render('select');
            layui.form.on('select(msManualModelStandard)', function (data) {
                manualStandard = data.value;
            });
        }

        function doSave() {
            var modelId = $overlay.find('#msManualModelName').val().trim();
            var maxInputTokens = parseTokensInput($overlay.find('#msManualModelTokens').val());

            if (!modelId) {
                showToast(GourdI18n.t('settings.providers.model_name') + GourdI18n.t('common.required'), 'error');
                return;
            }

            // 名称重复校验（编辑时排除自身）
            var exists = fetchedModels.some(function (m) {
                return m.id === modelId && (!isEdit || m.id !== model.id);
            });
            if (exists) {
                showToast(GourdI18n.t('settings.providers.model_name') + ' "' + modelId + '" ' + GourdI18n.t('settings.providers.model_exists'), 'error');
                return;
            }

            if (isEdit) {
                model.id = modelId;
                model.standard = manualStandard || DEFAULT_STANDARD;
                if (maxInputTokens) {
                    model.maxInputTokens = maxInputTokens;
                } else {
                    delete model.maxInputTokens;
                }
            } else {
                var newModel = { id: modelId, manual: true, standard: manualStandard || DEFAULT_STANDARD };
                if (maxInputTokens) newModel.maxInputTokens = maxInputTokens;
                fetchedModels.push(newModel);
            }
            renderModelsList();
            // 编辑模式下即时生效（新增模式仍随保存按钮一并提交）
            if (currentProvider) {
                persistProvider();
            }
            $overlay.remove();
        }

        $('#msModelAddConfirm').on('click', doSave);
        $('#msModelAddCancel, #msModelAddClose').on('click', function () {
            $overlay.remove();
        });
        $overlay.on('keypress', 'input', function (e) {
            if (e.which === 13) doSave();
        });
        setTimeout(function () {
            $overlay.find('#msManualModelName').focus();
        }, 100);
    }

    function removeManualModel(modelId) {
        fetchedModels = fetchedModels.filter(function (m) {
            return m.id !== modelId;
        });
        renderModelsList();
        if (currentProvider) {
            persistProvider();
        }
    }

    function fetchModels() {
        var apiUrl = $('#msProviderApiUrl').val();
        var apiKey = $('#msProviderApiKey').val();
        var standard = $('input[name="msProviderStandard"]:checked').val() || DEFAULT_STANDARD;

        if (!apiUrl) {
            showToast(GourdI18n.t('settings.providers.api_url') + GourdI18n.t('common.required'), 'error');
            return;
        }

        var $btn = $('#msProviderFetchModelsBtn');
        $btn.prop('disabled', true).html('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>');

        $.ajax({
            url: '/web/settings/providers/fetch',
            method: 'POST',
            data: {
                apiUrl: apiUrl,
                apiKey: apiKey,
                standard: standard
            },
            success: function (res) {
                $btn.prop('disabled', false).html('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>');
                if (res.code === 200) {
                    try {
                        var data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
                        var models = data.data || data.models || data || [];
                        // 记录已有模型的接口类型，拉取后尽量沿用
                        var prevStandards = {};
                        var prevEnabled = {};
                        fetchedModels.forEach(function (m) {
                            if (m.standard) prevStandards[m.id] = m.standard;
                            prevEnabled[m.id] = m.enabled !== false;
                        });
                        // 保留手动添加的模型，合并拉取的模型
                        var manualModels = fetchedModels.filter(function (m) {
                            return m.manual === true;
                        });
                        var fetchedMapped = models.map(function (m) {
                            var id = m.id || m.name || m;
                            // 接口类型优先级：用户此前手动设定 > 后端按 supported_endpoint_types 推断 > 默认 openai
                            var std = prevStandards[id] || m.standard || DEFAULT_STANDARD;
                            return { id: id, manual: false, standard: std, enabled: prevEnabled[id] !== false };
                        });
                        // 手动模型去重：如果手动模型 id 已在拉取列表中，保留手动标记
                        var fetchedIds = {};
                        fetchedMapped.forEach(function (m) { fetchedIds[m.id] = m; });
                        manualModels.forEach(function (mm) {
                            if (fetchedIds[mm.id]) {
                                fetchedIds[mm.id].manual = true;
                                if (mm.standard) fetchedIds[mm.id].standard = mm.standard;
                                if (mm.maxInputTokens) {
                                    fetchedIds[mm.id].maxInputTokens = mm.maxInputTokens;
                                }
                                if (mm.enabled !== undefined) {
                                    fetchedIds[mm.id].enabled = mm.enabled;
                                }
                            } else {
                                fetchedMapped.push(mm);
                            }
                        });
                        fetchedModels = fetchedMapped;
                        // 加载 LLM 模型列表缓存，用于判断同步状态
                        loadLlmModelsCache(function () {
                            renderModelsList();
                            // 编辑模式下拉取结果即时生效
                            if (currentProvider) {
                                persistProvider();
                            }
                        });
                        showToast(GourdI18n.t('settings.providers.fetch_models_success').replace('{0}', fetchedModels.length), 'success');
                    } catch (e) {
                        showToast(GourdI18n.t('settings.providers.fetch_models') + GourdI18n.t('settings.loop.operation_failed'), 'error');
                    }
                } else {
                    showToast(res.msg || GourdI18n.t('settings.providers.fetch_models') + GourdI18n.t('settings.loop.operation_failed'), 'error');
                }
            },
            error: function (xhr) {
                $btn.prop('disabled', false).html('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>');
                showToast(GourdI18n.t('settings.providers.fetch_models') + GourdI18n.t('settings.loop.operation_failed') + ': ' + (xhr.responseText || GourdI18n.t('settings.network_error')), 'error');
            }
        });
    }

    // 加载 LLM 模型列表缓存
    function loadLlmModelsCache(callback) {
        $.get('/web/settings/llm/models', function (res) {
            if (res.code === 200 && res.data) {
                var list = res.data.list || (Array.isArray(res.data) ? res.data : []);
                llmModelsCache = {};
                list.forEach(function (item) {
                    if (item.name) {
                        llmModelsCache[item.name] = item;
                    }
                });
            }
            if (callback) callback();
        }).fail(function () {
            if (callback) callback();
        });
    }

    function renderModelsList() {
        if (fetchedModels.length === 0) {
            $modelsEmpty.show();
            $modelsList.hide();
            return;
        }

        $modelsEmpty.hide();
        $modelsList.show();

        var providerName = $('#msProviderName').val() || '';
        var providerEnabled = currentProvider ? currentProvider.enabled !== false : true;
        var html = '';
        fetchedModels.forEach(function (model) {
            // 检查是否已同步到 LLM
            var llmName = providerName ? providerName + '-' + model.id : model.id;
            var syncedModel = llmModelsCache[llmName];
            var isSynced = !!syncedModel;
            // 设置端点返回全量模型，enabled 已综合 visibled 与连接启用状态
            var enabled = isSynced ? syncedModel.enabled !== false : providerEnabled;

            var manualTag = model.manual ? ' <span class="provider-model-manual-tag">' + GourdI18n.t('settings.providers.model_manual') + '</span>' : '';
            var removeBtn = model.manual
                ? '<button class="provider-model-remove-btn" title="' + GourdI18n.t('common.delete') + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
                : '';

            // 上下文长度提示（若已配置）
            var tokensHint = model.maxInputTokens
                ? '<div class="provider-model-sub">' + GourdI18n.t('settings.providers.model_context') + ' ' + escapeAttr(formatTokensInput(model.maxInputTokens)) + '</div>'
                : '';

            // 接口类型下拉（按模型，layui 样式）
            var curStd = model.standard || DEFAULT_STANDARD;
            var stdOptions = '';
            STANDARD_OPTIONS.forEach(function (opt) {
                stdOptions += '<option value="' + opt.value + '"' + (opt.value === curStd ? ' selected' : '') + '>' + opt.label + '</option>';
            });
            var stdSelect = '<div class="provider-model-standard-wrap">' +
                '<select lay-filter="msModelStd" data-model-id="' + escapeAttr(model.id) + '">' + stdOptions + '</select>' +
                '</div>';

            html += '<div class="provider-model-item' + (!enabled ? ' disabled' : '') + '" data-model-id="' + escapeAttr(model.id) + '">' +
                '<div class="provider-model-info" title="' + GourdI18n.t('common.edit') + GourdI18n.t('settings.providers.model_management') + '">' +
                     '<div class="provider-model-name">' + escapeHtml(model.id) + manualTag + (isSynced ? ' <span class="provider-model-synced">' + GourdI18n.t('settings.providers.synced') + '</span>' : '') + '</div>' +
                    tokensHint +
                '</div>' +
                '<div class="provider-model-actions">' +
                    stdSelect +
                    removeBtn +
                     '<label class="toggle-switch">' +
                        '<input type="checkbox" ' + (enabled ? 'checked' : '') + ' class="provider-model-toggle" data-synced="' + isSynced + '" data-llm-name="' + escapeAttr(llmName) + '"/>' +
                        '<span class="toggle-slider"></span>' +
                     '</label>' +
                '</div>' +
            '</div>';
        });
        $modelsList.html(html);
        // 渲染 layui 下拉（切换事件在 bindEvents 里按 lay-filter=msModelStd 全局绑定一次）
        if (typeof layui !== 'undefined' && layui.form) {
            layui.form.render('select');
        }
    }

    function toggleProviderModel(modelId, enabled, llmName, isSynced) {
        // 记录按模型的启用状态
        var model = null;
        for (var i = 0; i < fetchedModels.length; i++) {
            if (String(fetchedModels[i].id) === String(modelId)) {
                model = fetchedModels[i];
                break;
            }
        }
        if (model) {
            model.enabled = enabled;
        }

        // 如果已同步到模型列表，直接调用后端接口即时更新运行时状态
        if (isSynced && llmName) {
            postJson('/web/settings/llm/models/toggle', { name: llmName, enabled: enabled }, function (resp) {
                if (resp.code === 200) {
                    // 通知聊天组件刷新模型下拉列表（设置页缓存由后续 persistProvider 链路刷新）
                    if (typeof window.reloadModels === 'function') {
                        window.reloadModels();
                    }
                } else {
                    showToast(GourdI18n.t('settings.loop.operation_failed') + ': ' + (resp.message || GourdI18n.t('common.unknown_error')), 'error');
                    // 回滚状态
                    if (model) model.enabled = !enabled;
                    renderModelsList();
                    return;
                }
                // 持久化按模型启用状态，避免后续同步把开关状态改回去
                if (currentProvider) {
                    persistProvider();
                }
            });
        } else if (currentProvider) {
            // 未同步：即时持久化并触发后端同步生成运行时模型
            persistProvider();
        }
    }

    // ==================== CRUD 操作 ====================
    /** 拉取供应商详情（含未脱敏密钥）并填充右栏 */
    function editProvider(name) {
        $.ajax({
            url: '/web/settings/providers/get',
            method: 'GET',
            data: { name: name },
            success: function (res) {
                if (res.code === 200) {
                    // 详情拉回后同步 providers 缓存项（模型数/启用态与后端一致），重绘左栏
                    var idx = -1;
                    providers.forEach(function (p, i) { if (p.name === name) idx = i; });
                    if (idx >= 0) providers[idx] = res.data;
                    renderProviderList();
                    // 若期间用户已切走（selectedName 变了）则不覆盖右栏
                    if (selectedName === name) {
                        renderDetailForm(res.data);
                    }
                } else {
                    showToast(res.msg || GourdI18n.t('settings.loop.operation_failed'), 'error');
                }
            },
            error: function () {
                showToast(GourdI18n.t('settings.loop.operation_failed'), 'error');
            }
        });
    }

    // 持久化连接及其模型列表（保存成功不弹提示，仅失败时提示）
    function persistProvider() {
        var name = $('#msProviderName').val();
        var standard = $('input[name="msProviderStandard"]:checked').val() || DEFAULT_STANDARD;
        var apiUrl = $('#msProviderApiUrl').val();
        var apiKey = $('#msProviderApiKey').val();
        var scope = $('#msProviderScope').val();
        var timeout = ($('#msProviderTimeout').val() || '').trim();
        var models = fetchedModels.map(function (m) {
            var model = { id: m.id, manual: m.manual || false, standard: m.standard || DEFAULT_STANDARD, enabled: m.enabled !== false };
            if (m.maxInputTokens) {
                model.maxInputTokens = m.maxInputTokens;
            }
            return model;
        });

        if (!name) {
            showToast(GourdI18n.t('common.name') + GourdI18n.t('common.required'), 'error');
            return;
        }
        if (!apiUrl) {
            showToast(GourdI18n.t('settings.providers.api_url') + GourdI18n.t('common.required'), 'error');
            return;
        }

        var data = {
            name: name,
            standard: standard,
            apiUrl: apiUrl,
            apiKey: apiKey,
            scope: scope,
            timeout: normalizeTimeout(timeout),
            models: models,
            // 编辑模式沿用当前连接的启用状态，避免即时保存时把已禁用的连接误开启
            enabled: currentProvider ? currentProvider.enabled !== false : true
        };

        // 如果是编辑模式，添加 originalName
        if (currentProvider) {
            data.originalName = currentProvider.name;
        }

        var url = currentProvider ? '/web/settings/providers/update' : '/web/settings/providers/add';

        $.ajax({
            url: url,
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify(data),
            success: function (res) {
                if (res.code === 200) {
                    if (currentProvider) {
                        // 列表接口返回的 apiKey 是脱敏值，回填真实密钥，避免下次即时保存把脱敏值写进去
                        currentProvider.apiKey = apiKey;
                        // 本地同步左栏缓存（模型数/接口/地址/超时/作用域/启用态）并重绘左栏，
                        // 不走整体 loadProvidersList，避免右栏重新渲染打断即时编辑
                        currentProvider.models = models;
                        currentProvider.standard = standard;
                        currentProvider.apiUrl = apiUrl;
                        currentProvider.scope = scope;
                        currentProvider.timeout = data.timeout;
                        currentProvider.enabled = data.enabled;
                        var pIdx = -1;
                        providers.forEach(function (p, i) { if (p.name === data.name) pIdx = i; });
                        if (pIdx >= 0) providers[pIdx] = currentProvider; else providers.push(currentProvider);
                        renderProviderList();
                        // 先同步生成运行时模型，再重载 LLM 缓存重绘模型列表，保证已同步徽标/开关态与运行时一致
                        syncModelsToLlm(data, function () {
                            loadLlmModelsCache(function () {
                                renderModelsList();
                            });
                        });
                    } else {
                        syncModelsToLlm(data, null);
                        // 新增成功：左栏刷新并选中新增项，右栏切换为其编辑详情
                        selectedName = data.name;
                        loadProvidersList();
                    }
                } else {
                    showToast(res.msg || GourdI18n.t('settings.save_failed'), 'error');
                }
            },
            error: function () {
                showToast(GourdI18n.t('settings.save_failed'), 'error');
            }
        });
    }

    // 保存按钮（新增模式使用；编辑模式隐藏该按钮，所有操作即时生效）
    function saveProvider() {
        persistProvider();
    }

    // 归一化超时输入：数字 -> "Ns"；已带 s 或空则原样返回
    function normalizeTimeout(t) {
        if (!t) return '';
        t = String(t).trim();
        if (/^\d+$/.test(t)) return t + 's';
        return t;
    }

    function syncModelsToLlm(providerData, onDone) {
        // 调用后端接口同步模型
        $.ajax({
            url: '/web/settings/providers/sync-models',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({
                providerName: providerData.name,
                models: providerData.models || []
            }),
            success: function (res) {
                if (res.code === 200) {
                    // 通知聊天组件刷新模型下拉列表（新增/更新/删除后都要刷新）
                    if (typeof window.reloadModels === 'function') {
                        window.reloadModels();
                    }
                }
                if (onDone) onDone();
            },
            error: function () {
                if (onDone) onDone();
            }
        });
    }

    function deleteProvider() {
        if (!currentProvider) return;

        layConfirm(GourdI18n.t('settings.confirm_delete') + GourdI18n.t('settings.providers.add_title') + ' "' + currentProvider.name + '"？', function () {
            $.ajax({
                url: '/web/settings/providers/remove',
                method: 'POST',
                data: { name: currentProvider.name },
                success: function (res) {
                    if (res.code === 200) {
                        showToast(GourdI18n.t('settings.loop.deleted'), 'success');
                        // 删除成功：左栏刷新，右栏回落到首个供应商或新增表单
                        selectedName = null;
                        loadProvidersList();
                    } else {
                        showToast(res.msg || GourdI18n.t('settings.loop.delete_failed'), 'error');
                    }
                },
                error: function () {
                    showToast(GourdI18n.t('settings.loop.delete_failed'), 'error');
                }
            });
        });
    }

    function toggleProvider(name, enabled) {
        $.ajax({
            url: '/web/settings/providers/toggle',
            method: 'POST',
            data: { name: name, enabled: enabled },
            success: function (res) {
                if (res.code === 200) {
                    showToast(enabled ? GourdI18n.t('settings.loop.enable') : GourdI18n.t('settings.loop.disable'), 'success');
                    // 刷新供应商列表（左栏圆点/计数同步）；若右栏正编辑该项，loadProvidersList 内部会回填其详情态
                    loadProvidersList();
                    // 通知聊天组件刷新模型下拉列表
                    if (typeof window.reloadModels === 'function') {
                        window.reloadModels();
                    }
                } else {
                    showToast(res.msg || GourdI18n.t('settings.loop.operation_failed'), 'error');
                    loadProvidersList();
                }
            },
            error: function () {
                showToast(GourdI18n.t('settings.loop.operation_failed'), 'error');
                loadProvidersList();
            }
        });
    }

    // ==================== 暴露全局接口 ====================
    window.openModelSettings = openModelSettings;
    window.closeModelSettings = closeModelSettings;
    window.isModelSettingsOpen = function () { return $view.hasClass('active'); };

    // Provider API Key 显示切换
    $(document).on('click', '#msProviderApiKeyToggle', function () {
        var $input = $('#msProviderApiKey');
        if ($input.attr('type') === 'password') {
            $input.attr('type', 'text');
            $(this).html('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>');
        } else {
            $input.attr('type', 'password');
            $(this).html('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>');
        }
    });

    // 自动初始化
    $(document).ready(function () {
        init();
    });
})();
