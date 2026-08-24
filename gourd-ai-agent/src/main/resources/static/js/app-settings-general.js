/**
 * app-settings-general.js — 通用设置模块
 *
 * 依赖：layui.js（jQuery）
 * 交互模式：触发即生效并持久化（无需手动保存）
 */
(function () {
    'use strict';

    function showToast(msg, type) {
        if (typeof window.showToast === 'function') {
            window.showToast(msg, type === 'error' ? 'error' : 'success');
        } else {
            layAlert(msg);
        }
    }

    // 解析数字字符串（支持千位分隔符 _ 和 ,，用于兼容旧数据）
    function parseNumStr(s) {
        if (!s) return null;
        var n = parseInt(s.replace(/[, _]/g, ''), 10);
        return isNaN(n) ? null : n;
    }

    // =========================================================
    // 防抖定时器（用于数字输入框，避免频繁请求）
    // =========================================================
    var saveDebounceTimer = null;
    var isSaving = false;
    var savePending = false; // 保存进行中又收到保存请求时挂起，完成后补发，避免开关状态丢失

    /**
     * 触发保存请求
     * @param {boolean} immediate 是否立即执行（跳过防抖）
     *
     * 注意：表单快照一律在 doSave 真正发请求的瞬间收集，而不是在触发点提前捕获——
     * 否则防抖窗口内或并发挂起期间用户又改了值，会保存陈旧状态。
     */
    function saveGeneralSettings(immediate) {
        if (!immediate) {
            // 防抖：500ms 内重复触发则重置定时器
            clearTimeout(saveDebounceTimer);
            saveDebounceTimer = setTimeout(function () {
                doSave();
            }, 500);
            return;
        }
        doSave();
    }

    function collectFormPayload() {
        return {
            historyWindowSize: parseNumStr($('#generalHistoryWindowSize').val().trim()),
            compressionRatio: (function () {
                var v = parseNumStr($('#generalCompressionRatio').val().trim());
                return (v != null && v >= 1 && v <= 100) ? v : null;
            })(),
            sandboxMode: $('#generalSandboxMode').is(':checked'),
            sandboxAllowUserHome: $('#generalSandboxAllowUserHome').is(':checked'),
            sandboxSystemRestrict: $('#generalSandboxSystemRestrict').is(':checked'),
            apiRetries: parseNumStr($('#generalApiRetries').val().trim()),
            mcpRetries: parseNumStr($('#generalMcpRetries').val().trim()),
            modelRetries: parseNumStr($('#generalModelRetries').val().trim()),
            mcpEnabled: $('#generalMcpEnabled').is(':checked'),
            openApiEnabled: $('#generalOpenApiEnabled').is(':checked'),
            bashAsyncEnabled: $('#generalBashAsyncEnabled').is(':checked'),
            subagentEnabled: $('#generalSubagentEnabled').is(':checked'),
            lspEnabled: $('#generalLspEnabled').is(':checked'),
            cliPrintSimplified: $('#generalCliPrintSimplified').is(':checked'),
            darkMode: $('#generalDarkMode').is(':checked'),
            locale: $('#generalLocale').val()
        };
    }

    function doSave() {
        if (isSaving) { savePending = true; return; } // 防止并发请求；完成后补发（重新收集最新值）
        isSaving = true;

        var bodyObj = collectFormPayload(); // 发请求瞬间收集，避免陈旧快照
        $.ajax({ url: '/web/settings/general/save', method: 'POST', data: JSON.stringify(bodyObj), contentType: 'application/json', dataType: 'json' })
            .done(function (resp) {
                if (resp.code === 200) {
                    window.cliPrintSimplified = bodyObj.cliPrintSimplified;
                }
            })
            .fail(function (jqXHR) {
                showToast('设置保存失败', 'error');
                console.error('[Settings] Save failed:', jqXHR.status, jqXHR.responseText);
            })
            .always(function () {
                isSaving = false;
                if (savePending) {
                    savePending = false;
                    saveGeneralSettings(true); // 补发被挂起的保存
                }
            });
    }

    // =========================================================
    // layui form 初始化（事件监听 + 模块就绪标记）
    // =========================================================
    var formReady = false;
    var layuiForm = null;

    // ===== 开关类（switch）：变化即保存（即时，无防抖）=====
    // 这些开关是自定义 .toggle-switch 样式的原生 checkbox：既不在 .layui-form 容器内、
    // 也没有 lay-filter 属性，layui 不会渲染它们，form.on('switch(...)') 事件永不触发
    // （此前 bug 根因：关闭开关后根本没有发起保存）。改用原生 change 事件委托。
    var switchIds = [
        'generalDarkMode',
        'generalSandboxMode',
        'generalSandboxAllowUserHome',
        'generalSandboxSystemRestrict',
        'generalCliPrintSimplified',
        'generalBashAsyncEnabled',
        'generalSubagentEnabled',
        'generalMcpEnabled',
        'generalOpenApiEnabled',
        'generalLspEnabled'
    ];

    $(document).on('change', '#' + switchIds.join(', #'), function () {
        saveGeneralSettings(true); // 即时保存
    });

    function ensureFormReady(done) {
        if (formReady && done) { done(); return; }
        layui.use('form', function () {
            layuiForm = layui.form;
            formReady = true;

            // ===== 语言选择：变化即保存（即时）=====
            layuiForm.on('select(generalLocale)', function (data) {
                var newLocale = data.value;
                if (window.GourdI18n) { GourdI18n.setLocale(newLocale); }
                saveGeneralSettings(true); // 即时保存
            });

            if (done) done();
        });
    }

    // ===== 数字输入框：input 事件 + 防抖 =====
    $(document).on('input', '#generalHistoryWindowSize, #generalCompressionRatio, #generalModelRetries, #generalMcpRetries, #generalApiRetries', function () {
        saveGeneralSettings(false); // 防抖保存
    });

    function loadGeneralSettings() {
        $.get('/web/settings/general', function (resp) {
            if (resp.code === 200 && resp.data) {
                var d = resp.data;
                $('#generalHistoryWindowSize').val(d.historyWindowSize != null ? d.historyWindowSize : '');
                $('#generalCompressionRatio').val(d.compressionRatio != null ? d.compressionRatio : '');
                $('#generalSandboxMode').prop('checked', !!d.sandboxMode);
                $('#generalSandboxAllowUserHome').prop('checked', d.sandboxAllowUserHome !== false);
                $('#generalSandboxSystemRestrict').prop('checked', !!d.sandboxSystemRestrict);
                $('#generalApiRetries').val(d.apiRetries != null ? d.apiRetries : '');
                $('#generalMcpRetries').val(d.mcpRetries != null ? d.mcpRetries : '');
                $('#generalModelRetries').val(d.modelRetries != null ? d.modelRetries : '');
                $('#generalMcpEnabled').prop('checked', d.mcpEnabled !== false);
                $('#generalOpenApiEnabled').prop('checked', d.openApiEnabled !== false);
                $('#generalBashAsyncEnabled').prop('checked', !!d.bashAsyncEnabled);
                $('#generalSubagentEnabled').prop('checked', d.subagentEnabled !== false);
                $('#generalLspEnabled').prop('checked', !!d.lspEnabled);
                $('#generalCliPrintSimplified').prop('checked', d.cliPrintSimplified !== false);
                $('#generalDarkMode').prop('checked', !!d.darkMode);
                window.cliPrintSimplified = d.cliPrintSimplified !== false;

                // 语言选择：优先取 localStorage，后端有值才覆盖
                var currentLocale = GourdI18n ? GourdI18n.getLocale() : 'zh-CN';
                if (d.locale) {
                    currentLocale = d.locale;
                    if (window.GourdI18n) GourdI18n.setLocale(d.locale);
                }

                // 确保 form 模块就绪后赋值 + 渲染
                ensureFormReady(function () {
                    $('#generalLocale').val(currentLocale);
                    layuiForm.render('select');
                });
            }
        }).fail(function () { console.error('[Settings] Failed to load general settings'); });
    }

    window._settingsGeneral = {
        load: loadGeneralSettings,
        save: saveGeneralSettings
    };
})();