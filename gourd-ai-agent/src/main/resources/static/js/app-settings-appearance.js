/**
 * app-settings-appearance.js — 外观设置模块
 *
 * 明暗模式（system|light|dark）+ 强调色预设 + 界面语言。
 * 主题引擎在 app-ui.js（window.__themeApi），本模块只做 UI 呈现与事件转发：
 *   - 模式/主题切换立即生效并本地持久化（__themeApi 内部处理）；
 *   - 语言选择即时保存后端（与原通用设置行为一致，自该模块迁入）。
 * 依赖：layui.js（jQuery）、app-ui.js、app-i18n.js
 */
(function () {
    'use strict';

    var gridBuilt = false;

    function api() { return window.__themeApi; }

    function refreshModeUI() {
        var mode = api().getThemeMode();
        $('#appearanceModeRow .appearance-mode-btn').removeClass('active')
            .filter('[data-mode="' + mode + '"]').addClass('active');
    }

    function refreshGridUI() {
        var cur = api().getAccent();
        $('#appearanceThemeGrid .appearance-theme-card').each(function () {
            $(this).toggleClass('selected', $(this).attr('data-accent') === cur);
        });
    }

    /* 主题网格：卡片挂 data-accent="<id>"，theme.css 的预设规则同时匹配
       「[data-theme] 后代中带 data-accent 的节点」，因此色板自动呈现
       该预设在当前明暗模式下的成色，无需在此重复任何色值。 */
    function buildGrid() {
        if (gridBuilt) return;
        var $grid = $('#appearanceThemeGrid');
        if (!$grid.length) return;
        var html = '';
        api().accents.forEach(function (id) {
            html += '<button type="button" class="appearance-theme-card" data-accent="' + id + '">'
                + '<span class="atc-swatch">'
                + '<span class="atc-sw atc-sw-accent"></span>'
                + '<span class="atc-sw atc-sw-soft"></span>'
                + '<span class="atc-sw atc-sw-bg"></span>'
                + '</span>'
                + '<span class="atc-name" data-i18n="settings.appearance.theme.' + id + '"></span>'
                + '</button>';
        });
        $grid.html(html);
        gridBuilt = true;
        if (window.GourdI18n) GourdI18n.translateDOM();
    }

    $(document).on('click', '.appearance-mode-btn', function () {
        var mode = $(this).attr('data-mode');
        if (!mode) return;
        api().applyThemeMode(mode);
        refreshModeUI();
    });

    $(document).on('click', '.appearance-theme-card', function () {
        api().applyAccent($(this).attr('data-accent'));
        refreshGridUI();
    });

    // 面板打开期间主题被外部改变（如 system 模式下 OS 明暗切换）时同步控件状态
    document.addEventListener('theme:changed', function () { refreshModeUI(); });
    document.addEventListener('accent:changed', function () { refreshGridUI(); });

    // ===== 界面语言：变化即保存（即时）=====
    var formReady = false;
    function ensureFormReady(done) {
        if (formReady && done) { done(); return; }
        layui.use('form', function () {
            if (!formReady) {
                formReady = true;
                layui.form.on('select(generalLocale)', function (data) {
                    if (window.GourdI18n) GourdI18n.setLocale(data.value);
                    $.ajax({ url: '/web/settings/general/save', method: 'POST', data: JSON.stringify({ locale: data.value }), contentType: 'application/json', dataType: 'json' });
                });
            }
            if (done) done();
        });
    }

    function load() {
        buildGrid();
        refreshModeUI();
        refreshGridUI();

        // 语言：优先取本地，后端有值才覆盖（与原通用设置行为一致）
        var currentLocale = window.GourdI18n ? GourdI18n.getLocale() : 'zh-CN';
        ensureFormReady(function () {
            $('#generalLocale').val(currentLocale);
            layui.form.render('select');
        });
        $.get('/web/settings/general', function (resp) {
            if (resp.code === 200 && resp.data && resp.data.locale) {
                if (window.GourdI18n) GourdI18n.setLocale(resp.data.locale);
                ensureFormReady(function () {
                    $('#generalLocale').val(resp.data.locale);
                    layui.form.render('select');
                });
            }
        }).fail(function () { console.error('[Settings] Failed to load general settings for appearance'); });
    }

    window._settingsAppearance = {
        load: load
    };
})();
