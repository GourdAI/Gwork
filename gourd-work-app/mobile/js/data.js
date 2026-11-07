/* 静态 UI 契约数据 —— 逐项对照 WorkBuddy 9 张参考截图，供测试与渲染共用单一数据源 */
(function (global) {
  'use strict';

  var TABS = [
    { id: 'tasks', label: '任务', icon: 'tabTask' },
    { id: 'loop', label: '定时任务', icon: 'tabLoop' },
    { id: 'discover', label: '发现', icon: 'tabDiscover' },
    { id: 'mine', label: '我的', icon: 'tabMine' }
  ];

  var SUGGESTIONS = [
    [
      { label: '进行数据分析及可视化', icon: 'chart' },
      { label: '进行文档处理', icon: 'doc' },
      { label: '做一份幻灯片', icon: 'slides' },
      { label: '制作工作台', icon: 'grid' }
    ],
    [
      { label: '整理会议纪要', icon: 'doc' },
      { label: '生成周报', icon: 'chart' },
      { label: '调研竞品并对比', icon: 'project' },
      { label: '搭建知识库', icon: 'library' }
    ]
  ];

  var DISCOVER_GROUPS = [
    [{ id: 'library', label: '资料库', icon: 'library' }],
    [
      { id: 'expert', label: '专家', icon: 'expert' },
      { id: 'skill', label: '技能', icon: 'skill' },
      { id: 'connector', label: '连接器', icon: 'connector' }
    ],
    [{ id: 'project', label: '项目', icon: 'project' }]
  ];

  var SETTINGS_ROWS = [
    { id: 'language', label: '语言', value: '跟随系统', chevron: true },
    { id: 'fontSize', label: '字体大小', chevron: true },
    { id: 'readAloud', label: '朗读设置', chevron: true },
    { id: 'haptics', label: '触感反馈', toggle: true },
    { id: 'storage', label: '存储空间', chevron: true },
    { id: 'notifications', label: '消息通知设置', chevron: true }
  ];

  var QUICK_ACTIONS = [
    { id: 'camera', label: '拍照', icon: 'camera' },
    { id: 'photo', label: '照片 / 视频', icon: 'photo' },
    { id: 'file', label: '添加文件', icon: 'attach' }
  ];

  var SHEET_LIST_ROWS = [
    { id: 'expert', label: '专家', icon: 'expert' },
    { id: 'skill', label: '技能', icon: 'skill' },
    { id: 'connector', label: '连接器', icon: 'connector' },
    { id: 'loop', label: '定时任务', icon: 'clockPlus' },
    { id: 'recorder', label: '录音笔', icon: 'mic' }
  ];

  var DEVICES = [
    { id: 'cloud', label: '云端', icon: 'cloud', selected: true },
    { id: 'laptop', label: 'LAPTOP-0GMU4KOI', icon: 'offlinePc', offline: true }
  ];

  var MODELS = [
    { id: 'fast', name: '快速', ratio: '0.21x', icon: 'bolt' },
    { id: 'balanced', name: '均衡', ratio: '0.65x', icon: 'balance' },
    { id: 'ultra', name: '极致', ratio: '1.20x', icon: 'diamond' },
    { id: 'hy4', name: 'Hy4 preview', ratio: '0.29x', icon: 'hy' },
    { id: 'hy3', name: 'Hy3', ratio: '0.00x', icon: 'hy', free: true, selected: true },
    { id: 'ds', name: 'DeepSeek-V4.1-Flash', ratio: '0.11x', icon: 'deepseek' },
    { id: 'glm', name: 'GLM-5.3', ratio: '0.69x', icon: 'glm' },
    { id: 'glmflash', name: 'GLM-5.3-Flash', ratio: '0.08x', icon: 'glm' }
  ];

  /* 品牌：界面显示 GWork 自有商标（图 75/79 的顶栏标题与欢迎语位置）。
   * name/welcome 为文案，logo 为官方图形商标资源路径（与桌面 UI 的 /img/favicon.png 同源）。
   * 渲染与测试共用同一数据源；换品牌只改这一处 + assets/gwork-logo.png。 */
  var BRAND = {
    name: 'GWork',
    device: '云电脑',
    welcome: 'GWork，我帮你',
    logo: './assets/gwork-logo.png'
  };

  var DATA = {
    TABS: TABS,
    SUGGESTIONS: SUGGESTIONS,
    DISCOVER_GROUPS: DISCOVER_GROUPS,
    SETTINGS_ROWS: SETTINGS_ROWS,
    QUICK_ACTIONS: QUICK_ACTIONS,
    SHEET_LIST_ROWS: SHEET_LIST_ROWS,
    DEVICES: DEVICES,
    MODELS: MODELS,
    BRAND: BRAND,
    THEMES: ['system', 'light', 'dark'],
    THEME_LABELS: { system: '系统', light: '浅色', dark: '深色' },
    DEFAULT_THEME: 'system',
    ACCENT: '#0fbc9b'
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DATA;
  global.GWorkData = DATA;
})(typeof window !== 'undefined' ? window : globalThis);
