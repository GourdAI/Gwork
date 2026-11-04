/**
 * app-settings-appearance.js — 外观设置模块
 *
 * 明暗模式（system|light|dark）+ 强调色预设。
 * 主题引擎在 app-ui.js（window.__themeApi），本模块只做 UI 呈现与事件转发：
 *   模式/主题切换立即生效并本地持久化（__themeApi 内部处理）。
 * 界面语言在通用设置（app-settings-general.js）。
 * 依赖：layui.js（jQuery）、app-ui.js
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

    function load() {
        buildGrid();
        refreshModeUI();
        refreshGridUI();
    }

    window._settingsAppearance = {
        load: load
    };
})();
