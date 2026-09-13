/* ============================================================
   GWork 官网脚本
   - 多端下载：读取 downloads/tauri/downloads.json（随发版与安装包同目录上传）动态渲染，
     发新版只需上传产物，本文件与页面零改动
   - Hero 应用窗口 Agent 任务演示（时间轴动画，可重播）
   - 滚动显现 / UA 识别下载平台
   - 光标追光（背景光晕跟随鼠标，惯性平滑）
   ============================================================ */

'use strict';

/* ================= 多端下载（清单驱动） ================= */
// 下载清单 downloads.json 由发版流水线生成（gourd-ai-tauri/cmd/generate-latest-json.js
// 的 --site-out），与安装包同放 downloads/tauri/ 并一起上传服务器。
// 发新版 = 把产物传上去，本文件与页面零改动；清单加载失败时全部置「即将推出」，
// 绝不产生指向不存在文件的坏链。
const DOWNLOADS_BASE = 'downloads/tauri/';
const DOWNLOADS_MANIFEST = DOWNLOADS_BASE + 'downloads.json';

// 展示映射：把清单 files[] 里的 {os, arch, kind} 映射到下载行。
// 上新平台 / 改产物命名时只动这里，普通发版无需任何改动。
// （字段契约见生成器头注释；对应契约测试 gourd-ai-tauri/test/release-manifest-contract.js）
const DOWNLOAD_PLATFORMS = [
  {
    id: 'windows',
    name: 'Windows',
    rows: [
      { label: 'Windows（64 位）', fmt: '.exe', match: { os: 'windows', arch: 'x64', kind: 'exe' } }
    ]
  },
  {
    id: 'macos',
    name: 'macOS',
    rows: [
      { label: 'macOS（Apple 芯片）', fmt: '.dmg', match: { os: 'macos', arch: 'arm64', kind: 'dmg' } },
      { label: 'macOS（Intel 芯片）', fmt: '.dmg', match: { os: 'macos', arch: 'x64', kind: 'dmg' } }
    ]
  },
  {
    id: 'linux',
    name: 'Linux',
    rows: [
      { label: 'Linux x64（免安装）', fmt: '.AppImage', match: { os: 'linux', arch: 'x64', kind: 'appimage' } },
      { label: 'Linux x64（Debian/Ubuntu）', fmt: '.deb', match: { os: 'linux', arch: 'x64', kind: 'deb' } }
    ]
  }
];

/* 平台图标（单色，随 currentColor） */
const PLATFORM_ICONS = {
  windows: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/></svg>',
  macos: '<svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><path d="M25.547 11.131a5.89 5.89 0 0 0-2.814 4.955 5.73 5.73 0 0 0 3.488 5.257 13.7 13.7 0 0 1-1.786 3.69c-1.112 1.601-2.275 3.202-4.044 3.202-1.77 0-2.225-1.028-4.264-1.028-1.988 0-2.696 1.062-4.314 1.062s-2.746-1.483-4.044-3.303a15.96 15.96 0 0 1-2.713-8.61c0-5.056 3.286-7.735 6.521-7.735 1.72 0 3.152 1.128 4.23 1.128 1.028 0 2.629-1.196 4.584-1.196a6.13 6.13 0 0 1 5.156 2.578m-6.083-4.718a5.8 5.8 0 0 0 1.382-3.622 2.5 2.5 0 0 0-.05-.522A5.82 5.82 0 0 0 16.97 4.24a5.65 5.65 0 0 0-1.432 3.522q0 .239.05.472.176.033.354.034a5.05 5.05 0 0 0 3.522-1.855"/></svg>',
  linux: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m7 9 2 2-2 2"/><path d="M12 13h5"/></svg>'
};

function detectPlatformId() {
  const ua = navigator.userAgent || '';
  if (/windows|win32|win64/i.test(ua)) return 'windows';
  if (/mac os|macintosh|iphone|ipad/i.test(ua)) return 'macos';
  if (/linux/i.test(ua)) return 'linux';
  return 'windows';
}

async function loadDownloadsManifest() {
  try {
    // no-cache：清单要随发版即时更新，不能被浏览器缓存钉死。
    const res = await fetch(DOWNLOADS_MANIFEST, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data || !Array.isArray(data.files)) throw new Error('清单格式不符');
    return data;
  } catch (e) {
    console.warn('[downloads] 下载清单加载失败:', e && e.message ? e.message : e);
    return null;
  }
}

function matchDownloadFile(manifest, match) {
  if (!manifest) return null;
  return manifest.files.find(f =>
    f && f.os === match.os && f.arch === match.arch && f.kind === match.kind
  ) || null;
}

function firstAvailableRow(platform, manifest) {
  for (const row of platform.rows) {
    const file = matchDownloadFile(manifest, row.match);
    if (file) return { row, file };
  }
  return null;
}

/* ================= 下载区渲染 ================= */
function setDownloadNote(text) {
  const el = document.getElementById('downloadNoteText');
  if (el) el.textContent = text;
}

function renderDownloads(manifest) {
  const grid = document.getElementById('downloadGrid');
  if (!grid) return;
  grid.textContent = '';

  if (!manifest) {
    setDownloadNote('下载列表暂未就绪，请稍后刷新重试。');
  } else if (manifest.version) {
    setDownloadNote('当前版本 v' + String(manifest.version).replace(/^v/, '') +
      ' · 已内置自动更新，安装后始终保持在最新版本。');
  }

  for (const platform of DOWNLOAD_PLATFORMS) {
    const col = document.createElement('div');
    col.className = 'dl-col';

    const hasRelease = platform.rows.some(r => matchDownloadFile(manifest, r.match));
    col.innerHTML =
      '<div class="dl-col-head">' +
        PLATFORM_ICONS[platform.id] +
        '<h3>' + platform.name + '</h3>' +
        (hasRelease ? '' : '<span class="tag">即将推出</span>') +
      '</div>';

    const rows = document.createElement('div');
    rows.className = 'dl-rows';

    for (const row of platform.rows) {
      const file = matchDownloadFile(manifest, row.match);
      const info =
        '<span class="dl-info"><span class="dl-name">' + row.label + '</span>' +
        '<span class="fmt">' + row.fmt + '</span></span>';

      if (file) {
        const a = document.createElement('a');
        a.className = 'dl-row';
        a.href = DOWNLOADS_BASE + file.name;
        // 新开顶层窗口触发下载：站点被嵌在 sandbox iframe 中时，
        // 同框导航会被 allow-downloads 拦截（无反应）。
        a.target = '_blank';
        a.rel = 'noopener';
        a.innerHTML = info +
          '<svg class="arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>';
        rows.appendChild(a);
      } else {
        const d = document.createElement('div');
        d.className = 'dl-row disabled';
        d.innerHTML = info + '<span class="soon">即将推出</span>';
        rows.appendChild(d);
      }
    }

    col.appendChild(rows);
    grid.appendChild(col);
  }
}

/* Hero 大按钮：跟随访客平台 */
function setupHeroCta(manifest) {
  const cta = document.getElementById('heroDownload');
  const title = document.getElementById('heroCtaTitle');
  const desc = document.getElementById('heroCtaDesc');
  const iconBox = document.getElementById('heroOsIcon');
  if (!cta) return;

  const pid = detectPlatformId();
  const platform = DOWNLOAD_PLATFORMS.find(p => p.id === pid) || DOWNLOAD_PLATFORMS[0];
  const hit = firstAvailableRow(platform, manifest);
  if (iconBox) {
    iconBox.outerHTML = PLATFORM_ICONS[platform.id].replace('aria-hidden="true"', 'id="heroOsIcon" aria-hidden="true"');
  }

  if (hit) {
    cta.href = DOWNLOADS_BASE + hit.file.name;
    cta.target = '_blank';
    cta.rel = 'noopener';
    title.textContent = '下载 GWork';
    desc.textContent = '适用于 ' + hit.row.label;
  } else {
    // 锚点跳转必须留在当前页
    cta.removeAttribute('target');
    cta.removeAttribute('rel');
    cta.href = '#downloads';
    title.textContent = '下载 GWork';
    desc.textContent = manifest ? platform.name + ' 版即将推出 · 查看全部下载' : '查看全部下载';
  }
}

/* ================= Hero Agent 演示时间轴 ================= */
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const DEMO_STEPS = [
  { kind: 'agent', html: '收到，我将以深色科技风重构官网，并突出多端下载。先分析现有页面结构。' },
  { kind: 'tool', icon: 'search', label: '已探索', meta: 'gourd-ai-website · 12 个文件' },
  { kind: 'tool', icon: 'pencil', label: '已编辑', meta: 'index.html / styles.css', add: '+1,286' },
  { kind: 'checklist', items: ['页面结构分析', '深色主题与动效实现', '多端下载区接入'] },
  { kind: 'terminal', lines: [
    { prompt: 'gwork@desktop $ ', cmd: 'node --check js/main.js', out: '语法校验通过 ✓', ok: true }
  ]},
  { kind: 'agent', html: '官网重构完成：深色科技风 + 多端下载区已就位，可直接在本地预览。' },
  { kind: 'done', elapsed: '2 分 41 秒' }
];

const TOOL_ICONS = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>'
};

let demoToken = { cancelled: false };
let demoVisible = true;

function buildStepEl(step) {
  const wrap = document.createElement('div');
  wrap.className = 'step';

  if (step.kind === 'agent') {
    wrap.innerHTML = '<div class="msg agent">' + step.html + '</div>';
  } else if (step.kind === 'tool') {
    wrap.innerHTML =
      '<div class="tool-row">' + TOOL_ICONS[step.icon] +
      '<b>' + step.label + '</b><span class="meta">' + step.meta + '</span>' +
      (step.add ? '<span class="meta add">' + step.add + '</span>' : '') + '</div>';
  } else if (step.kind === 'checklist') {
    wrap.innerHTML = '<div class="check-list">' + step.items.map(t =>
      '<div class="check-item"><span class="box"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg></span><span>' + t + '</span></div>'
    ).join('') + '</div>';
  } else if (step.kind === 'terminal') {
    wrap.innerHTML = '<div class="term-block"></div>';
  } else if (step.kind === 'done') {
    wrap.innerHTML =
      '<div class="done-bar">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>' +
      '任务完成 <span class="elapsed">用时 ' + step.elapsed + '</span></div>';
  }
  return wrap;
}

/* 可取消、页面隐藏时自动暂停的延时 */
function sleep(ms, token) {
  return new Promise((resolve, reject) => {
    let waited = 0;
    const timer = setInterval(() => {
      if (token.cancelled) { clearInterval(timer); reject(new Error('cancelled')); return; }
      if (document.hidden || !demoVisible) return; // 暂停计时
      waited += 60;
      if (waited >= ms) { clearInterval(timer); resolve(); }
    }, 60);
  });
}

function show(el) {
  requestAnimationFrame(() => el.classList.add('on'));
}

async function typeTerminal(block, lines, token) {
  for (const line of lines) {
    const p = document.createElement('div');
    p.innerHTML = '<span class="t-prompt">' + line.prompt + '</span><span class="t-cmd type-caret"></span>';
    block.appendChild(p);
    const cmdSpan = p.querySelector('.t-cmd');
    for (const ch of line.cmd) {
      await sleep(34, token);
      cmdSpan.textContent += ch;
    }
    cmdSpan.classList.remove('type-caret');
    await sleep(340, token);
    const out = document.createElement('div');
    out.className = 't-out';
    out.innerHTML = line.ok ? '<span class="t-ok">' + line.out + '</span>' : line.out;
    block.appendChild(out);
    await sleep(420, token);
  }
}

function setWinStatus(busy) {
  const box = document.getElementById('winStatus');
  const text = document.getElementById('winStatusText');
  if (!box) return;
  box.classList.toggle('busy', busy);
  text.textContent = busy ? '运行中' : '已完成';
}

function renderAllStatic(chat) {
  for (const step of DEMO_STEPS) {
    const el = buildStepEl(step);
    el.classList.add('on');
    if (step.kind === 'terminal') {
      const block = el.querySelector('.term-block');
      for (const line of step.lines) {
        block.insertAdjacentHTML('beforeend',
          '<div><span class="t-prompt">' + line.prompt + '</span><span class="t-cmd">' + line.cmd + '</span></div>' +
          '<div class="t-out">' + (line.ok ? '<span class="t-ok">' + line.out + '</span>' : line.out) + '</div>');
      }
    }
    if (step.kind === 'checklist') {
      el.querySelectorAll('.check-item').forEach(i => i.classList.add('done'));
    }
    chat.appendChild(el);
  }
}

async function runDemo() {
  const chat = document.getElementById('demoChat');
  const replay = document.getElementById('replayBtn');
  if (!chat) return;

  if (reducedMotion) {
    renderAllStatic(chat);
    setWinStatus(false);
    return;
  }

  demoToken.cancelled = true;
  const token = { cancelled: false };
  demoToken = token;

  // 重置
  chat.querySelectorAll('.step').forEach(n => n.remove());
  replay.classList.remove('show');
  setWinStatus(true);

  try {
    for (const step of DEMO_STEPS) {
      await sleep(950, token);
      const el = buildStepEl(step);
      chat.appendChild(el);
      show(el);

      if (step.kind === 'checklist') {
        const items = el.querySelectorAll('.check-item');
        for (const item of items) {
          await sleep(700, token);
          item.classList.add('done');
        }
      } else if (step.kind === 'terminal') {
        await sleep(300, token);
        await typeTerminal(el.querySelector('.term-block'), step.lines, token);
      }
    }

    await sleep(500, token);
    setWinStatus(false);
    replay.classList.add('show');

    await sleep(8000, token);
    runDemo(); // 循环播放
  } catch (e) { /* 被 replay 或重置取消 */ }
}

/* ================= 滚动显现 ================= */
function setupReveal() {
  const targets = document.querySelectorAll('.reveal');
  if (reducedMotion || !('IntersectionObserver' in window)) {
    targets.forEach(t => t.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      }
    }
  }, { threshold: 0.12 });
  targets.forEach(t => io.observe(t));
}

/* ================= 光标追光 ================= */
function setupSpotlight() {
  if (reducedMotion || !window.matchMedia('(pointer: fine)').matches) return;
  const spot = document.querySelector('.bg-spot');
  if (!spot) return;

  let tx = window.innerWidth / 2, ty = window.innerHeight * 0.3;
  let x = tx, y = ty, raf = null;

  const tick = () => {
    x += (tx - x) * 0.08;
    y += (ty - y) * 0.08;
    spot.style.setProperty('--spot-x', x.toFixed(1) + 'px');
    spot.style.setProperty('--spot-y', y.toFixed(1) + 'px');
    if (Math.abs(tx - x) > 0.5 || Math.abs(ty - y) > 0.5) {
      raf = requestAnimationFrame(tick);
    } else {
      raf = null;
    }
  };

  window.addEventListener('pointermove', e => {
    tx = e.clientX;
    ty = e.clientY;
    spot.classList.add('on');
    if (!raf) raf = requestAnimationFrame(tick);
  }, { passive: true });
}

/* ================= 顶部导航条 ================= */
function setupNav() {
  const header = document.getElementById('siteHeader');
  const toggle = document.getElementById('navToggle');
  const links = document.getElementById('navLinks');
  const navSectionIds = ['features', 'quickstart', 'downloads'];

  // 滚动：头部背景 + 当前区块高亮
  function updateActive() {
    if (!links) return;
    const probe = window.scrollY + 120;
    let currentId = '';
    for (const id of navSectionIds) {
      const sec = document.getElementById(id);
      if (!sec) continue;
      if (sec.getBoundingClientRect().top + window.scrollY <= probe) currentId = id;
    }
    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    if (atBottom) currentId = 'downloads';

    links.querySelectorAll('a').forEach(a => {
      const target = a.getAttribute('href') || '';
      a.classList.toggle('active', target === '#' + currentId);
    });
  }

  function onScroll() {
    if (header) header.classList.toggle('scrolled', window.scrollY > 8);
    updateActive();
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // 移动端菜单开合
  if (!toggle || !links) return;
  const close = () => {
    toggle.classList.remove('open');
    links.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', '打开菜单');
  };
  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    toggle.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
  });
  links.querySelectorAll('a').forEach(a => a.addEventListener('click', close));
  document.addEventListener('click', e => {
    if (links.classList.contains('open') && !e.target.closest('.site-header')) close();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
  });
}

/* ================= 启动 ================= */
document.addEventListener('DOMContentLoaded', () => {
  // 下载区与 Hero 按钮都由下载清单驱动；清单到达前 Hero 保持锚点跳转，不会指向坏链。
  if (document.getElementById('downloadGrid') || document.getElementById('heroDownload')) {
    loadDownloadsManifest().then(manifest => {
      renderDownloads(manifest);
      setupHeroCta(manifest);
    });
  }
  setupReveal();
  setupSpotlight();
  setupNav();

  const win = document.querySelector('.app-window');
  if (win && 'IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      demoVisible = entries[0].isIntersecting;
    }, { threshold: 0.05 }).observe(win);
  }

  const replay = document.getElementById('replayBtn');
  if (replay) replay.addEventListener('click', () => runDemo());

  runDemo();
});
