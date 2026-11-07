/* 内联 SVG 图标库：线性描边 1.8px，currentColor 继承主题色。
 * 选中态 Tab 使用独立实心变体（*Solid），对应参考图 75/77/80/81 的黑色实心图标。
 */
(function (global) {
  'use strict';

  function svg(body, viewBox) {
    return '<svg class="icon" viewBox="' + (viewBox || '0 0 24 24') + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }

  var ICONS = {
    // 顶部
    menu: svg('<path d="M5 8h14"/><path d="M5 16h11"/>'),
    cloud: svg('<path d="M7.5 18h9a4 4 0 0 0 .5-7.97A6 6 0 0 0 5.3 11.2 3.5 3.5 0 0 0 7.5 18Z"/>'),
    cloudArrow: svg('<path d="M7.5 18h9a4 4 0 0 0 .5-7.97A6 6 0 0 0 5.3 11.2 3.5 3.5 0 0 0 7.5 18Z"/><path d="M9 14.2a3 3 0 0 1 5.2-1.2"/><path d="m14.2 10.6.1 2.6-2.5.2"/>'),
    chevRight: svg('<path d="m9 5 7 7-7 7"/>'),
    chevDown: svg('<path d="m5 9 7 7 7-7"/>'),
    plus: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
    close: svg('<path d="M6 6l12 12"/><path d="M18 6 6 18"/>'),
    check: svg('<path d="m4 12.5 5 5L20 6.5"/>'),

    // 底部 4 Tab
    tabTask: svg('<path d="M4.5 5.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4.5 3v-3H4.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z"/><path d="M9 9.5h3"/><path d="m9 12.8 1.7 1.7L14 11"/>'),
    tabLoop: svg('<circle cx="12" cy="12.5" r="7.2"/><path d="m9.5 11.4 1.9 1.9 3.3-3.6"/><path d="M6.2 4.2 4 6.3"/><path d="M17.8 4.2 20 6.3"/>'),
    tabDiscover: svg('<circle cx="12" cy="12" r="8.5"/><path d="m15.6 8.4-2.1 5.1-5.1 2.1 2.1-5.1 5.1-2.1Z"/>'),
    tabMine: svg('<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>'),

    /* 选中态实心图标（参考图 75/77/80/81：黑色实心 + 反白细节）。
     * 命名规则：TABS[].icon + 'Solid'（驼峰），renderTabbar 选中时自动切换。
     * 实心 path 用 fill=currentColor；内部反白细节用 var(--bg)。 */
    tabTaskSolid: svg(
      '<path d="M4.5 5.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4.5 3v-3H4.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" fill="currentColor" stroke="none"/>' +
      '<path d="M8.5 9.5h4M9 12.8l1.7 1.7L14 11" fill="none" stroke="var(--bg)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'),
    tabLoopSolid: svg(
      '<path d="M6.2 4.2 4 6.3M17.8 4.2 20 6.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
      '<circle cx="12" cy="12.5" r="8.2" fill="currentColor" stroke="none"/>' +
      '<path d="m9 12.5 2.2 2.2 3.9-4.2" fill="none" stroke="var(--bg)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
    tabDiscoverSolid: svg(
      '<circle cx="12" cy="12" r="9" fill="currentColor" stroke="none"/>' +
      '<path d="m15.6 8.4-2.1 5.1-5.1 2.1 2.1-5.1 5.1-2.1Z" fill="var(--bg)" stroke="none"/>'),
    tabMineSolid: svg(
      '<circle cx="12" cy="7.8" r="4" fill="currentColor" stroke="none"/>' +
      '<path d="M3.8 20.5c0-4.3 3.7-7.2 8.2-7.2s8.2 2.9 8.2 7.2Z" fill="currentColor" stroke="none"/>'),

    // 建议胶囊 / 发现 / 扩展面板
    chart: svg('<path d="M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z"/><path d="M12 3.5v8.5h8.5"/>'),
    doc: svg('<path d="M6 3.5h8l4 4v13H6a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z"/><path d="M14 3.5v4h4"/><path d="M8.5 12h6"/><path d="M8.5 16h6"/>'),
    slides: svg('<rect x="3.5" y="4.5" width="17" height="12" rx="1.5"/><path d="M12 16.5V20"/><path d="M8 20h8"/><path d="M7 8.5h6"/>'),
    grid: svg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.3"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.3"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.3"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.3"/>'),
    refresh: svg('<path d="M19 11a7 7 0 1 0-2 5.7"/><path d="M19 5.5V11h-5.5"/>'),

    // 输入区
    voice: svg('<circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none"/><path d="M9.5 8.5a5 5 0 0 1 0 7"/><path d="M12.5 5.8a8.5 8.5 0 0 1 0 12.4"/>'),
    send: svg('<path d="M5.5 12 19 5.5 15.5 19 12 13.2 5.5 12Z" fill="currentColor" stroke="none"/>'),
    hy: svg('<circle cx="12" cy="12" r="9"/><path d="M15.5 6.8a6.2 6.2 0 0 0-7.7 8.7"/><path d="M8.5 17.2a6.2 6.2 0 0 0 7.7-8.7"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>'),

    // 发现 / 我的
    library: svg('<path d="M12 6.5C10 5 7 4.5 4 5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5Z"/><path d="M12 6.5v13"/>'),
    expert: svg('<path d="M5 7.5a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2a3 3 0 0 1-1 5.9V17a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3v-1.6A3 3 0 0 1 5 9.5Z"/><circle cx="9.5" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="10" r="1" fill="currentColor" stroke="none"/><path d="M12 3.5v2"/>'),
    skill: svg('<path d="M6 18 16.5 7.5"/><path d="m13.5 5 5.5 5.5"/><path d="m4 15.5 4.5 4.5"/><path d="m17 3 .8 2.2L20 6l-2.2.8L17 9l-.8-2.2L14 6l2.2-.8L17 3Z"/>'),
    connector: svg('<path d="M9.5 14.5 14.5 9.5"/><path d="M7.8 10.2 6 12a3.5 3.5 0 0 0 5 5l1.8-1.8"/><path d="M16.2 13.8 18 12a3.5 3.5 0 0 0-5-5l-1.8 1.8"/>'),
    project: svg('<circle cx="7" cy="7" r="2.4"/><circle cx="17" cy="7" r="2.4"/><circle cx="12" cy="17.5" r="2.4"/><path d="m8.9 8.6 2.1 6.6"/><path d="m15.1 8.6-2.1 6.6"/><path d="M9.4 7h5.2"/>'),
    flower: svg('<path d="M12 8.5c-1.6-2.6-4.6-1.8-4.6.4 0 1.7 2.2 2.7 4.6 3 2.4-.3 4.6-1.3 4.6-3 0-2.2-3-3-4.6-.4Z"/><path d="M12 12c-2.6-1.6-3.6-4.6-1.4-4.6 1.7 0 2.7 2.2 3 4.6"/><path d="M12 12c1.6-2.6 4.6-3.6 4.6-1.4 0 1.7-2.2 2.7-4.6 3"/>'),
    monitor: svg('<rect x="3.5" y="4.5" width="17" height="12" rx="1.6"/><path d="M9 20h6"/><path d="M12 16.5V20"/>'),
    camera: svg('<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.2"/><path d="M18 4v2.4"/><path d="M16.8 5.2h2.4"/>'),
    photo: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m4.5 17 5-5 4 3.5 2.5-2 3.5 3.5"/>'),
    attach: svg('<path d="M9.5 14.5 15 9a3 3 0 0 0-4.2-4.2L5.2 10.4a4.5 4.5 0 0 0 6.4 6.4l5.6-5.6a2.5 2.5 0 0 0-3.5-3.5L8 13.4"/>'),
    clockPlus: svg('<circle cx="12" cy="12.5" r="7.2"/><path d="m9.5 11.4 1.9 1.9 3.3-3.6"/><path d="M6.2 4.2 4 6.3"/><path d="M17.8 4.2 20 6.3"/>'),
    mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3"/>'),
    offlinePc: svg('<rect x="3.5" y="4.5" width="17" height="12" rx="1.6"/><path d="M9 20h6"/><path d="M12 16.5V20"/>'),
    newTask: svg('<path d="M4.5 5.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4.5 3v-3H4.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z"/><path d="M12 9.2v5"/><path d="M9.5 11.7h5"/>'),
    emptyRobot: svg('<path d="M8 5.5 6 3.5l1 4"/><path d="M16 5.5 18 3.5l-1 4"/><rect x="5" y="6" width="14" height="12" rx="6"/><circle cx="9.5" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="12" r="1.1" fill="currentColor" stroke="none"/><path d="M12 3.2v1.4"/><path d="M11 2.2h2"/>'),

    // 模型列表
    bolt: svg('<path d="M13 2.5 5.5 13.5H11l-1 8 7.5-11H12l1-8Z"/>'),
    balance: svg('<circle cx="12" cy="12" r="8.5"/><path d="m8 12.2 2.6 2.6L16.5 9"/>'),
    diamond: svg('<path d="m12 3 8 6-8 12L4 9l8-6Z"/><path d="M4 9h16"/>'),
    deepseek: svg('<path d="M4 14c3-6 9-8 16-6-4 0-6 2-7 4 3-1 5 0 6 2-5-1-9 1-11 5"/><path d="M4 17c2-2 4-2.5 6-2"/>'),
    glm: svg('<path d="M5 5h14L8 19h11"/><path d="M5 19h5"/>'),
    more: svg('<path d="m5 9 7 7 7-7"/>')
  };

  global.GWorkIcons = {
    get: function (name) { return ICONS[name] || ''; },
    all: function () { return Object.keys(ICONS); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
