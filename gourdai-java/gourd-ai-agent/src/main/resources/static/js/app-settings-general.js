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
            compressionTargetRatio: (function () {
                var v = parseNumStr($('#generalCompressionTargetRatio').val().trim());
                return (v != null && v >= 10 && v <= 95) ? v : null;
            })(),
            compressionReservedOutputTokens: (function () {
                var v = parseNumStr($('#generalCompressionReservedOutputTokens').val().trim());
                return (v != null && v >= 1000) ? v : null;
            })(),
            intentChainEnabled: $('#generalIntentChainEnabled').is(':checked'),
            // 技能清单预算两旋钮：越界一律传 null（= 不修改），让后端回落默认值。
            // 不在前端钳制：后端 SkillListingPolicy.normalizeFraction 是单一真源，
            // 两边各钳一次会出现「页面显示的值」与「实际生效的值」不一致。
            skillListingBudgetFraction: (function () {
                var v = parseNumStr($('#generalSkillListingBudgetFraction').val().trim());
                return (v != null && v >= 1 && v <= 10) ? v : null;
            })(),
            skillListingMaxDescChars: (function () {
                var v = parseNumStr($('#generalSkillListingMaxDescChars').val().trim());
                return (v != null && v >= 16 && v <= 8192) ? v : null;
            })(),
            apiRetries: parseNumStr($('#generalApiRetries').val().trim()),
            mcpRetries: parseNumStr($('#generalMcpRetries').val().trim()),
            modelRetries: parseNumStr($('#generalModelRetries').val().trim())
        };
    }

    function doSave() {
        if (isSaving) { savePending = true; return; } // 防止并发请求；完成后补发（重新收集最新值）
        isSaving = true;

        var bodyObj = collectFormPayload(); // 发请求瞬间收集，避免陈旧快照
        $.ajax({ url: '/web/settings/general/save', method: 'POST', data: JSON.stringify(bodyObj), contentType: 'application/json', dataType: 'json' })
            .done(function () { })
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

    // ===== 开关类（switch）：变化即保存（即时，无防抖）=====
    // 自定义 .toggle-switch 样式的原生 checkbox 既不在 .layui-form 容器内、也没有
    // lay-filter 属性，layui 不会渲染它们，form.on('switch(...)') 事件永不触发
    // （此前 bug 根因：关闭开关后根本没有发起保存）。改用原生 change 事件委托。
    // 注：明暗模式与主题在外观设置（app-settings-appearance.js）。
    $(document).on('change', '#generalIntentChainEnabled', function () {
        saveGeneralSettings(true); // 即时保存
    });

    // ===== 界面语言：变化即保存（即时）=====
    var localeFormReady = false;
    function ensureLocaleFormReady(done) {
        if (localeFormReady && done) { done(); return; }
        layui.use('form', function () {
            if (!localeFormReady) {
                localeFormReady = true;
                layui.form.on('select(generalLocale)', function (data) {
                    if (window.GourdI18n) GourdI18n.setLocale(data.value);
                    $.ajax({ url: '/web/settings/general/save', method: 'POST', data: JSON.stringify({ locale: data.value }), contentType: 'application/json', dataType: 'json' });
                });
            }
            if (done) done();
        });
    }

    // ===== 数字输入框：input 事件 + 防抖 =====
    $(document).on('input', '#generalHistoryWindowSize, #generalCompressionRatio, #generalCompressionTargetRatio, #generalCompressionReservedOutputTokens, #generalModelRetries, #generalMcpRetries, #generalApiRetries, #generalSkillListingBudgetFraction, #generalSkillListingMaxDescChars', function () {
        saveGeneralSettings(false); // 防抖保存
    });

    function loadGeneralSettings() {
        // 语言：优先取本地，后端有值才覆盖
        var currentLocale = window.GourdI18n ? GourdI18n.getLocale() : 'zh-CN';
        ensureLocaleFormReady(function () {
            $('#generalLocale').val(currentLocale);
            layui.form.render('select');
        });
        $.get('/web/settings/general', function (resp) {
            if (resp.code === 200 && resp.data) {
                var d = resp.data;
                $('#generalHistoryWindowSize').val(d.historyWindowSize != null ? d.historyWindowSize : '');
                $('#generalCompressionRatio').val(d.compressionRatio != null ? d.compressionRatio : '');
                $('#generalCompressionTargetRatio').val(d.compressionTargetRatio != null ? d.compressionTargetRatio : '');
                $('#generalCompressionReservedOutputTokens').val(d.compressionReservedOutputTokens != null ? d.compressionReservedOutputTokens : '');
                $('#generalIntentChainEnabled').prop('checked', d.intentChainEnabled !== false);
                $('#generalSkillListingBudgetFraction').val(d.skillListingBudgetFraction != null ? d.skillListingBudgetFraction : '');
                $('#generalSkillListingMaxDescChars').val(d.skillListingMaxDescChars != null ? d.skillListingMaxDescChars : '');
                $('#generalApiRetries').val(d.apiRetries != null ? d.apiRetries : '');
                $('#generalMcpRetries').val(d.mcpRetries != null ? d.mcpRetries : '');
                $('#generalModelRetries').val(d.modelRetries != null ? d.modelRetries : '');
                if (d.locale) {
                    if (window.GourdI18n) GourdI18n.setLocale(d.locale);
                    ensureLocaleFormReady(function () {
                        $('#generalLocale').val(d.locale);
                        layui.form.render('select');
                    });
                }
            }
        }).fail(function () { console.error('[Settings] Failed to load general settings'); });
    }

    window._settingsGeneral = {
        load: loadGeneralSettings,
        save: saveGeneralSettings
    };
})();