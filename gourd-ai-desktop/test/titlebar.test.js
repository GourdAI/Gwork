'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const titlebar = require('../main/titlebar');

const {
  THEME_COLORS,
  MIN_SYMBOL_GAP,
  parseColor,
  resolveOverlayColors,
  initWindowChrome,
  setWindowTheme,
  setWindowScrim,
  resetWindowScrim,
} = titlebar;

const SCRIM = 'rgba(0, 0, 0, 0.5)';

/** 假窗口：记录原生调用序列，用于断言"何时调了几次、参数是什么"。 */
function fakeWin({ overlay = true, buttons = false, destroyed = false, throws = false } = {}) {
  const win = {
    calls: [],
    isDestroyed: () => destroyed,
  };
  if (overlay) {
    win.setTitleBarOverlay = (opts) => {
      if (throws) throw new Error('boom');
      win.calls.push(['overlay', opts]);
    };
  }
  if (buttons) {
    win.setWindowButtonVisibility = (visible) => {
      if (throws) throw new Error('boom');
      win.calls.push(['buttons', visible]);
    };
  }
  return win;
}

function lum(hex) {
  const c = parseColor(hex);
  return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
}

test('parseColor accepts the formats getComputedStyle and the theme table actually emit', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('#1a1b1e'), { r: 26, g: 27, b: 30, a: 1 });
  assert.deepEqual(parseColor('rgba(0, 0, 0, 0.5)'), { r: 0, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(parseColor('rgb(18, 18, 20)'), { r: 18, g: 18, b: 20, a: 1 });
  assert.deepEqual(parseColor('rgba(0 0 0 / 0.85)'), { r: 0, g: 0, b: 0, a: 0.85 });
  assert.equal(parseColor('#00000080').a, 128 / 255, 'CSS 8 位十六进制是 #RRGGBBAA，alpha 在末位');
  assert.equal(parseColor('transparent').a, 0);
  // 渲染层传来的都是不可信输入：解析不了必须给 null，不能抛
  for (const bad of ['', 'red', 'var(--x)', 'rgba()', 'rgb(1,2)', null, undefined, 42, '#'.repeat(70)]) {
    assert.equal(parseColor(bad), null, String(bad));
  }
});

test('no scrim keeps the exact theme colors (never touch the normal look)', () => {
  assert.deepEqual(resolveOverlayColors('light', null), THEME_COLORS.light);
  assert.deepEqual(resolveOverlayColors('dark', null), THEME_COLORS.dark);
  // 未知主题回退 dark，绝不返回 undefined 字段
  assert.deepEqual(resolveOverlayColors('sepia', null), THEME_COLORS.dark);
  assert.deepEqual(resolveOverlayColors(undefined, null), THEME_COLORS.dark);
});

test('scrim premultiplies the button strip so it matches the dimmed page', () => {
  // 白底 + 50% 黑遮罩 = #808080，与网页里 rgba(0,0,0,.5) 压白底的效果一致
  const light = resolveOverlayColors('light', SCRIM);
  assert.equal(light.color, '#808080');
  assert.equal(light.symbolColor, '#0d0d17');
  assert.equal(light.height, THEME_COLORS.light.height);

  const dark = resolveOverlayColors('dark', SCRIM);
  assert.equal(dark.color, '#0d0e0f');
  assert.equal(dark.symbolColor, '#6e6f71');
});

test('very dark scrims are capped so window controls stay legible', () => {
  // 图片灯箱是 rgba(0,0,0,0.85)：等比压暗会让按钮黑到看不见，故截断到 0.6
  const light = resolveOverlayColors('light', 'rgba(0, 0, 0, 0.85)');
  assert.equal(light.color, '#666666');
  assert.notEqual(light.color, '#000000');

  // 不变量：任何遮罩下，符号与底色的亮度差都不得糊到看不清
  for (const theme of ['light', 'dark']) {
    for (const scrim of ['rgba(0,0,0,0.4)', SCRIM, 'rgba(0,0,0,0.85)', 'rgba(0,0,0,1)', 'rgba(255,255,255,0.9)']) {
      const o = resolveOverlayColors(theme, scrim);
      assert.ok(
        Math.abs(lum(o.symbolColor) - lum(o.color)) >= MIN_SYMBOL_GAP,
        `${theme} + ${scrim} -> ${o.color}/${o.symbolColor}`,
      );
    }
  }
});

test('unparsable / transparent scrim degrades safely instead of breaking the titlebar', () => {
  // 解析不了 → 按默认遮罩色处理（渲染层报了"有遮罩"，就该变暗）
  assert.deepEqual(resolveOverlayColors('light', 'var(--nope)'), resolveOverlayColors('light', SCRIM));
  // 全透明 → 等于没有遮罩
  assert.deepEqual(resolveOverlayColors('light', 'rgba(0,0,0,0)'), THEME_COLORS.light);
  assert.deepEqual(resolveOverlayColors('light', 'transparent'), THEME_COLORS.light);
});

test('win32/linux: scrim dims the WCO, closing it restores, repeats are deduped', () => {
  for (const platform of ['win32', 'linux']) {
    const win = fakeWin();
    initWindowChrome(win, 'light');
    // 构造函数已经应用过初始色，登记后不应该再多调一次
    assert.equal(win.calls.length, 0, platform);

    setWindowScrim(win, SCRIM, platform);
    assert.deepEqual(win.calls, [['overlay', { color: '#808080', symbolColor: '#0d0d17', height: 36 }]], platform);

    // 同一遮罩重复上报（rAF 多次触发）不得反复调原生 API
    setWindowScrim(win, SCRIM, platform);
    setWindowScrim(win, 'rgba(0, 0, 0, 0.5)', platform);
    assert.equal(win.calls.length, 1, platform);

    // 遮罩期间切主题：必须叠加后重算，而不是恢复成亮色
    setWindowTheme(win, 'dark', platform);
    assert.deepEqual(win.calls[1], ['overlay', { color: '#0d0e0f', symbolColor: '#6e6f71', height: 36 }], platform);

    // 关闭遮罩 → 回到当前主题原色
    setWindowScrim(win, null, platform);
    assert.deepEqual(win.calls[2], ['overlay', THEME_COLORS.dark], platform);
    assert.equal(win.calls.length, 3, platform);
  }
});

test('darwin: traffic lights hide during the scrim and come back after', () => {
  // mac 没有 setTitleBarOverlay（调了会抛 TypeError），只有红绿灯显隐
  const win = fakeWin({ overlay: false, buttons: true });
  initWindowChrome(win, 'dark');
  assert.equal(win.calls.length, 0);

  setWindowScrim(win, SCRIM, 'darwin');
  assert.deepEqual(win.calls, [['buttons', false]]);

  setWindowScrim(win, SCRIM, 'darwin');
  assert.equal(win.calls.length, 1, '重复上报不抖动红绿灯');

  // mac 上主题切换不涉及原生按钮，不应产生调用
  setWindowTheme(win, 'light', 'darwin');
  assert.equal(win.calls.length, 1);

  resetWindowScrim(win, 'darwin');
  assert.deepEqual(win.calls[1], ['buttons', true]);
  assert.equal(win.calls.length, 2);
});

test('reset always restores, even without a preceding close (reload / renderer crash)', () => {
  const mac = fakeWin({ overlay: false, buttons: true });
  initWindowChrome(mac, 'dark');
  setWindowScrim(mac, SCRIM, 'darwin');
  resetWindowScrim(mac, 'darwin');
  resetWindowScrim(mac, 'darwin');
  assert.deepEqual(mac.calls, [['buttons', false], ['buttons', true]], '复位幂等');

  const win = fakeWin();
  initWindowChrome(win, 'light');
  setWindowScrim(win, SCRIM, 'win32');
  resetWindowScrim(win, 'win32');
  assert.deepEqual(win.calls[1], ['overlay', THEME_COLORS.light]);
});

test('missing APIs / destroyed windows / throwing natives never bubble up', () => {
  // 装饰只是观感：任何异常都不允许打断调用方（历史教训：mac 上直接调
  // setTitleBarOverlay 抛 TypeError，连带中断了后端引导）
  const noApi = fakeWin({ overlay: false });
  initWindowChrome(noApi, 'light');
  assert.doesNotThrow(() => setWindowScrim(noApi, SCRIM, 'win32'));
  assert.doesNotThrow(() => setWindowScrim(noApi, SCRIM, 'darwin'));
  assert.equal(noApi.calls.length, 0);

  const dead = fakeWin({ destroyed: true });
  initWindowChrome(dead, 'light');
  setWindowScrim(dead, SCRIM, 'win32');
  assert.equal(dead.calls.length, 0);

  const boom = fakeWin({ throws: true });
  initWindowChrome(boom, 'light');
  assert.doesNotThrow(() => setWindowScrim(boom, SCRIM, 'win32'));

  const boomMac = fakeWin({ overlay: false, buttons: true, throws: true });
  initWindowChrome(boomMac, 'dark');
  assert.doesNotThrow(() => setWindowScrim(boomMac, SCRIM, 'darwin'));
  // 调用抛错时不得记为"已隐藏"，否则后续复位会被 dedupe 吃掉，红绿灯永久消失
  assert.doesNotThrow(() => resetWindowScrim(boomMac, 'darwin'));

  assert.doesNotThrow(() => setWindowScrim(null, SCRIM, 'win32'));
  assert.doesNotThrow(() => setWindowTheme(undefined, 'light', 'darwin'));
});
