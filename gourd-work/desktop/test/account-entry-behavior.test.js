/* 账号入口行为契约：在【无 __GOURD_IPC__】的真实 DOM 沙箱里执行 app-account.js，
   断言「点击登录入口一定弹框」。

   背景（用户 11-09 报障「点击登录没弹框，点击都没反应」）：
   旧版 app-account.js 第 13 行 `if (!ipc || typeof ipc.authStatus !== 'function') return;`
   在无 IPC 时整个模块提前退出，连 entry.onclick 都不绑定 —— 入口是纯摆设。
   只靠「源码字符串断言」防不住这类回归（改个写法就绕过），故用 vm 真实跑源码、
   真实派发 click，检查弹层是否 display 可见。

   注意：DOM 桩的 innerHTML 必须像浏览器一样把字符串解析成子节点，否则
   renderAuth() 之后的 renderForm()（靠 getElementById('accountForm')）会拿到 null。
   源码断言必须先剥注释——根因示例代码本身写在文件头注释里，不剥会误伤。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'ui/js/app-account.js'), 'utf8');

/* 极简 DOM 桩：只实现 app-account.js 用到的接口。 */
function makeDom() {
  const byId = {};

  function mk(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      className: '', id: '', textContent: '', _html: '',
      children: [], attrs: {}, style: { display: 'none' },
      parentNode: null,
      classList: {
        add(c) { const s = new Set((el.className || '').split(/\s+/).filter(Boolean)); s.add(c); el.className = [...s].join(' '); },
        remove(c) { el.className = (el.className || '').split(/\s+/).filter(x => x && x !== c).join(' '); },
        contains(c) { return (el.className || '').split(/\s+/).indexOf(c) >= 0; }
      },
      setAttribute(k, v) { el.attrs[k] = String(v); },
      getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
      removeAttribute(k) { delete el.attrs[k]; },
      appendChild(c) { el.children.push(c); c.parentNode = el; if (c.id) byId[c.id] = c; return c; },
      removeChild(c) { el.children = el.children.filter(x => x !== c); },
      addEventListener() {}, click() { if (typeof el.onclick === 'function') el.onclick({ target: el }); },
      focus() {},
      getBoundingClientRect() { return { left: 12, top: 600, bottom: 640, width: 240, height: 40 }; },
      querySelectorAll(sel) { return all(el).filter(x => matchClass(x, sel)); },
      closest(sel) { let n = el; while (n) { if (matchClass(n, sel)) return n; n = n.parentNode; } return null; }
    };
    Object.defineProperty(el, 'offsetWidth', { get() { return 320; } });
    Object.defineProperty(el, 'offsetHeight', { get() { return 420; } });
    /* 像浏览器一样把 HTML 字符串解析成子节点：保留 id / class 及全部属性，
       注册进 byId，挂 parentNode。嵌套标签扁平化即可（本模块只按 id/class 取）。 */
    Object.defineProperty(el, 'innerHTML', {
      get() { return el._html; },
      set(html) {
        el._html = String(html == null ? '' : html);
        el.children = [];
        const re = /<([a-zA-Z][\w-]*)([^>]*)>/g;
        let m;
        while ((m = re.exec(el._html)) !== null) {
          const attrStr = m[2] || '';
          const idm = /id="([^"]*)"/.exec(attrStr);
          const clm = /class="([^"]*)"/.exec(attrStr);
          if (!idm && !clm) continue;
          const child = mk(m[1]);
          child.id = idm ? idm[1] : '';
          child.className = clm ? clm[1] : '';
          const am = /([\w-]+)="([^"]*)"/g;
          let a;
          while ((a = am.exec(attrStr)) !== null) child.attrs[a[1]] = a[2];
          child.parentNode = el;
          el.children.push(child);
          if (child.id) byId[child.id] = child;
        }
      }
    });
    return el;
  }

  function matchClass(n, sel) {
    if (!n || !sel) return false;
    return sel.split(',').some(s => {
      s = s.trim();
      if (s.charAt(0) === '.') return n.classList.contains(s.slice(1));
      if (s.charAt(0) === '#') return n.id === s.slice(1);
      return n.tagName === s.toUpperCase();
    });
  }

  function all(node) {
    const out = [], stack = (node.children || []).slice();
    while (stack.length) {
      const x = stack.shift();
      out.push(x);
      if (x.children) for (let i = x.children.length - 1; i >= 0; i--) stack.unshift(x.children[i]);
    }
    return out;
  }

  const body = mk('body');
  const docHandlers = {};
  const document = {
    readyState: 'complete', body,
    getElementById(id) { return byId[id] || null; },
    createElement: mk,
    addEventListener(type, fn) { (docHandlers[type] = docHandlers[type] || []).push(fn); },
    docHandlers
  };

  const entry = mk('button');
  entry.id = 'accountEntryBtn';
  entry.className = 'account-card';
  const name = mk('span'); name.id = 'accountEntryName'; name.setAttribute('data-i18n', 'account.entry');
  const avatar = mk('span'); avatar.id = 'accountCardAvatar';
  const sub = mk('span'); sub.id = 'accountCardSub';
  entry.appendChild(name); entry.appendChild(avatar); entry.appendChild(sub);
  body.appendChild(entry);
  return { entry, name, avatar, sub, body, document, byId, mk };
}

function run(opts) {
  opts = opts || {};
  const dom = makeDom();
  const zh = {
    'account.entry': '登录 / 注册', 'account.sign_in': '登录', 'account.sign_up': '注册',
    'account.sign_up_submit': '注册并登录', 'account.close': '关闭',
    'account.username': '用户名', 'account.email': '邮箱（可选）', 'account.password': '密码',
    'account.signed_in': '已登录', 'account.plan': '套餐', 'account.points': '积分余额',
    'settings.title': '设置', 'settings.tabs.appearance': '外观',
    'settings.appearance.mode.light': '浅色', 'settings.appearance.mode.dark': '深色',
    'account.memory': '记忆与进化', 'account.feedback': '意见反馈',
    'settings.about.check_update': '检查更新', 'account.sign_out': '退出登录',
    'account.working': '请稍候…', 'account.required': '请填写用户名和密码',
    'account.password_policy': '密码长度需为 8–128 个字符',
    'account.unavailable': '登录服务暂不可用', 'account.failed': '操作失败'
  };
  const sandbox = {
    document: dom.document,
    window: {
      innerWidth: 1280, innerHeight: 800,
      GourdI18n: { t(k) { return zh[k] || k; } },
      addEventListener() {},
      __themeApi: { getThemeMode() { return 'light'; }, applyThemeMode() {} },
      openSettings() {}, openMemoryView() {}
    },
    setInterval() { return 1; }, clearInterval() {},
    console
  };
  if (opts.ipc) sandbox.window.__GOURD_IPC__ = opts.ipc;
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'app-account.js' });
  return { dom, sandbox };
}

test('no __GOURD_IPC__: clicking the entry still opens the popover (regression for silent click)', () => {
  const { dom } = run({ ipc: null });
  assert.equal(typeof dom.entry.onclick, 'function', 'entry must have a click handler even without IPC');
  dom.entry.onclick({ target: dom.entry });
  const pop = dom.byId['accountPopover'];
  assert.ok(pop, 'popover element must be created');
  /* 【P0 真根因护栏】必须是显式 'block'，不能只断言 !== 'none'：
     旧版 show() 用 style.display='' 清空内联，在真实浏览器里回落到 CSS 类的
     display:none（弹层永不可见），但 '' !== 'none' 会让弱断言误判为通过。
     这里用严格相等锁死「显式内联值」，任何退回清空内联的改动都会红灯。 */
  assert.equal(pop.style.display, 'block', 'show() must set an explicit display:block, never clear the inline style');
  const backdrop = pop.parentNode && pop.parentNode.children
    ? pop.parentNode.children.filter(c => c.className === 'account-backdrop')[0] : null;
  assert.ok(backdrop, 'account backdrop must be created');
  assert.equal(backdrop.style.display, 'block', 'backdrop must also be explicitly shown');
  assert.equal(dom.entry.getAttribute('aria-expanded'), 'true');
  /* 未登录弹层 = 设置 + 用户相关菜单；登录表单【不在】弹层里（用户明确否决）。 */
  assert.ok(pop.innerHTML.indexOf('id="accountForm"') < 0,
    'login form must NOT be embedded in the popover (separate modal only)');
  assert.ok(pop.innerHTML.indexOf('data-act="login"') >= 0, 'popover must offer a login entry row');
  assert.ok(pop.innerHTML.indexOf('data-act="settings"') >= 0, 'popover must offer the settings entry');
  assert.equal(dom.name.textContent, '登录 / 注册', 'unsigned-in card shows sign-in label');
});

/* 用户 11-09 二次确认：登录是【单独弹框】，不在账号弹层里。 */
test('login form is a separate centered modal opened from the popover login row', () => {
  const { dom } = run({ ipc: null });
  dom.entry.onclick({ target: dom.entry });
  const pop = dom.byId['accountPopover'];
  const loginRow = pop.children.filter(c => c.attrs && c.attrs['data-act'] === 'login')[0];
  assert.ok(loginRow, 'login row missing in popover');
  pop.onclick({ target: loginRow });
  const modal = dom.byId['accountModal'];
  assert.ok(modal, 'login modal must be created');
  assert.equal(modal.style.display, 'block', 'modal must be explicitly shown (never cleared inline)');
  const mb = modal.parentNode.children.filter(c => c.className === 'account-modal-backdrop')[0];
  assert.ok(mb, 'modal backdrop must be created');
  assert.equal(mb.style.display, 'block', 'modal backdrop must be explicitly shown');
  assert.equal(pop.style.display, 'none', 'popover must close when the login modal opens');
  assert.ok(dom.byId['accountUsername'], 'username input must be parsed into the modal DOM');
  assert.ok(dom.byId['accountPassword'], 'password input must be parsed into the modal DOM');
});

test('no IPC: clicking submit shows an explicit hint instead of failing silently', () => {
  const { dom } = run({ ipc: null });
  dom.entry.onclick({ target: dom.entry });
  const pop = dom.byId['accountPopover'];
  const loginRow = pop.children.filter(c => c.attrs && c.attrs['data-act'] === 'login')[0];
  pop.onclick({ target: loginRow });
  const modal = dom.byId['accountModal'];
  const submit = dom.byId['accountSubmit'];
  assert.ok(submit, 'submit button must exist');
  // 走真实的事件委托（modal.onclick），不是直接调内部函数
  modal.onclick({ target: submit });
  /* 【P2 护栏】提示必须落在【登录弹框自己的】hint 节点上且该节点在可见容器里：
     旧实现两个容器共用 id="accountHint"，同 id 双节点时 getElementById 会命中
     被隐藏的那一个，提示对用户不可见（同族「点了没反应」）。 */
  const hint = dom.byId['accountModalHint'];
  assert.ok(hint, 'login modal must carry its own uniquely-ided hint node');
  assert.equal(hint.parentNode, modal, 'modal hint must live inside the visible modal');
  assert.ok(hint.textContent.length > 0, 'an explicit error hint must be shown');
  assert.ok(hint.textContent.indexOf('暂不可用') >= 0, 'hint must explain the service is unavailable');
});

test('signed-in state: popover renders profile with nickname, plan and sign-out', () => {
  const status = { signed_in: true, username: 'luzhengwang', display_name: '陆正望' };
  const { dom } = run({
    ipc: {
      authStatus() { return Promise.resolve(status); },
      authSelf() { return Promise.resolve({ data: { group: '旗舰版', quota: 0 } }); },
      authLogin() { return Promise.resolve(status); },
      authRegister() { return Promise.resolve(status); },
      authLogout() { return Promise.resolve({ signed_in: false }); }
    }
  });
  return Promise.resolve().then(() => {
    dom.entry.onclick({ target: dom.entry });
    const pop = dom.byId['accountPopover'];
    /* 与 P0 护栏同一纪律：严格断言显式 'block'，notEqual('none') 会被
      「清空内联 = ''」这类旧写法骗过。 */
    assert.equal(pop.style.display, 'block');
    assert.ok(pop.innerHTML.indexOf('account-pop-profile') >= 0, 'profile header');
    assert.ok(pop.innerHTML.indexOf('account-pop-stats') >= 0, 'plan / points card');
    assert.ok(pop.innerHTML.indexOf('data-act="logout"') >= 0, 'sign out entry');
    assert.ok(pop.innerHTML.indexOf('account-theme-switch') >= 0, 'light/dark switch');
    assert.ok(dom.entry.className.indexOf('is-signed-in') >= 0, 'card signed-in class');
    assert.equal(dom.name.textContent, '陆正望', 'card shows nickname');
    assert.equal(dom.byId['accountPopName'].textContent, '陆正望', 'popover shows nickname');
  });
});

test('source binds the click handler unconditionally (comment stripped)', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/if\s*\(!ipc\s*\|\|\s*typeof\s+ipc\.authStatus\s*!==\s*'function'\)\s*return\s*;/.test(code),
    'app-account.js must not bail out before binding the click handler');
  assert.ok(/entry\.onclick\s*=/.test(code), 'entry.onclick must be assigned regardless of IPC');
});

/* P0 根因的结构性护栏：旧版 .account-overlay 自带 display:none，show() 清空
   内联后弹层永远不可见。行为桩不加载 CSS，靠这一条把「类默认值锁死」。 */
test('CSS must not hide the popover/backdrop/modal by default; show() must set display:block explicitly', () => {
  const css = fs.readFileSync(path.join(ROOT, 'ui/css/app.css'), 'utf8');
  for (const sel of ['.account-popover', '.account-backdrop', '.account-modal', '.account-modal-backdrop']) {
    const m = css.match(new RegExp('\\' + sel + '\\s*\\{([^}]*)\\}'));
    assert.ok(m, sel + ' rule missing');
    assert.ok(!/display\s*:\s*none/.test(m[1]),
      sel + ' must not default to display:none (old .account-overlay bug)');
  }
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/popover\.style\.display\s*=\s*'block'/.test(code),
    'show() must assign an explicit display:block to the popover');
  assert.ok(/backdrop\.style\.display\s*=\s*'block'/.test(code),
    'show() must assign an explicit display:block to the backdrop');
  assert.ok(/modal\.style\.display\s*=\s*'block'/.test(code),
    'showAuthModal() must assign an explicit display:block to the modal');
  assert.ok(/modalBackdrop\.style\.display\s*=\s*'block'/.test(code),
    'showAuthModal() must assign an explicit display:block to the modal backdrop');
  assert.ok(!/popover\.style\.display\s*=\s*''/.test(code),
    "show() must never clear the popover's inline display");
  assert.ok(!/modal\.style\.display\s*=\s*''/.test(code),
    "showAuthModal() must never clear the modal's inline display");
});

/* P1：profile 视图里点「退出登录」若失败/能力缺失，必须有可见文案，
   否则又是一次「点了没反应」。 */
test('profile view carries a hint node so logout failures are never silent', () => {
  const status = { signed_in: true, username: 'u', display_name: 'U' };
  const { dom } = run({
    ipc: {
      authStatus() { return Promise.resolve(status); },
      authSelf() { return Promise.resolve({ group: 'default', quota: 100 }); },
      authLogin() { return Promise.resolve(status); },
      authRegister() { return Promise.resolve(status); }
      // 故意不提供 authLogout：走 unavailable() 分支
    }
  });
  return Promise.resolve().then(() => {
    dom.entry.onclick({ target: dom.entry });
    const pop = dom.byId['accountPopover'];
    assert.ok(dom.byId['accountPopHint'], 'profile view must contain its own hint node (#accountPopHint)');
    const logout = pop.children.filter(c => c.attrs && c.attrs['data-act'] === 'logout')[0];
    assert.ok(logout, 'logout menu item missing');
    pop.onclick({ target: logout });
    /* 【P2 护栏】登出失败的提示必须落在【弹层自己的】hint 节点上且在可见的弹层里，
       绝不能写进登录弹框那个（可能未打开/被隐藏）的同名节点。 */
    const hint = dom.byId['accountPopHint'];
    assert.equal(hint.parentNode, pop, 'popover hint must live inside the visible popover');
    assert.ok(hint.textContent.length > 0, 'logout failure must show a visible hint');
    assert.ok(hint.textContent.indexOf('暂不可用') >= 0, 'hint must explain unavailable');
  });
});

/* P2 结构护栏：弹层与登录弹框【同时】存在于 DOM 时，hint 节点 id 必须互不相同。
   同 id 双节点是 HTML 非法状态：getElementById 只返回先插入者，后渲染容器的
   提示会写进被隐藏的节点 —— 用户视角就是「点了没反应」。
   共存场景取「已登录弹层（profile 带 hint）+ 公开 API showAuth() 打开登录弹框」：
   未登录 menu 视图没有失败路径、本就不带 hint 节点，不构成同 id 风险。 */
test('popover and modal hint ids are unique across both containers', () => {
  const status = { signed_in: true, username: 'u', display_name: 'U' };
  const { dom, sandbox } = run({
    ipc: {
      authStatus() { return Promise.resolve(status); },
      authSelf() { return Promise.resolve({ group: 'default', quota: 1 }); },
      authLogin() { return Promise.resolve(status); },
      authRegister() { return Promise.resolve(status); },
      authLogout() { return Promise.resolve({ signed_in: false }); }
    }
  });
  return Promise.resolve().then(() => {
    dom.entry.onclick({ target: dom.entry });            // 开弹层（profile 视图，带 popHint）
    const pop = dom.byId['accountPopover'];
    assert.ok(pop, 'popover must exist');
    sandbox.window.GourdAccount.showAuth();              // 再开登录弹框（后挂载）
    const modal = dom.byId['accountModal'];
    assert.ok(pop && modal, 'both containers must coexist in DOM for this check');
    const popHint = dom.byId['accountPopHint'];
    const modalHint = dom.byId['accountModalHint'];
    assert.ok(popHint && modalHint, 'each container must carry its own hint node');
    assert.notEqual(popHint, modalHint, 'hint nodes must not collapse into one id');
    assert.equal(popHint.parentNode, pop, 'popover hint inside popover');
    assert.equal(modalHint.parentNode, modal, 'modal hint inside modal');
    /* 源码层面：不得再出现共享的 id="accountHint" */
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/id="accountHint"/.test(code), 'shared id="accountHint" must not come back');
  });
});
