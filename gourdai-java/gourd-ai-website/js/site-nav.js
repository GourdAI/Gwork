/* GWork 官网顶部导航条公共实现。
   index.html 与 models.html 共用一份。此前两页各写一套：main.js 的 setupNav 带完整的
   移动端菜单收起（点链接 / 点外部 / Esc），models.js 只绑了开合，导致模型页点导航项后
   菜单残留在展开态。合并为单份以杜绝再次漂移。
   装配顺序：本文件须先于各页脚本加载（两者同为 defer，声明顺序即执行顺序）。 */
'use strict';

(function () {
  /* 嵌入模式标记由页面内联脚本前置写入 <html>（地址栏携带 ?embed 参数时）。
     此时导航条已被 CSS 隐藏，滚动高亮与移动端菜单都无需接线。 */
  function isEmbedded() {
    const cls = document.documentElement && document.documentElement.className;
    return typeof cls === 'string' && /\bis-embedded\b/.test(cls);
  }

  /* options：
     - sectionIds：页内锚点区块 id，滚动时高亮对应导航项；导航指向其它页面时传空数组。
     - scrolledOnScroll：是否由滚动接管 .site-header 的 scrolled 类。默认 false，
       即不改动页面写死的初始态（models.html 的 header 常驻 scrolled）。 */
  function setupNav(options) {
    const opts = options || {};
    if (isEmbedded()) return;
    const header = document.getElementById('siteHeader');
    const toggle = document.getElementById('navToggle');
    const links = document.getElementById('navLinks');
    const navSectionIds = opts.sectionIds || [];
    const scrolledOnScroll = opts.scrolledOnScroll === true;

    // 滚动：头部背景 + 当前区块高亮
    function updateActive() {
      if (!links || !navSectionIds.length) return;
      const probe = window.scrollY + 120;
      let currentId = '';
      for (const id of navSectionIds) {
        const sec = document.getElementById(id);
        if (!sec) continue;
        if (sec.getBoundingClientRect().top + window.scrollY <= probe) currentId = id;
      }
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atBottom) currentId = navSectionIds[navSectionIds.length - 1];

      links.querySelectorAll('a').forEach(a => {
        const target = a.getAttribute('href') || '';
        a.classList.toggle('active', target === '#' + currentId);
      });
    }

    function onScroll() {
      if (scrolledOnScroll && header) header.classList.toggle('scrolled', window.scrollY > 8);
      updateActive();
    }
    // 两者都不需要时不挂监听，避免空转的 scroll 回调
    if (navSectionIds.length || scrolledOnScroll) {
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }

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

  window.GourdSiteNav = { setupNav };
})();
