/* ===== 「技能 · 连接器 · 接口」侧栏复合标题契约 =====
 *
 * 用户诉求（两轮，后者推翻前者，以最新为准）：
 *   第 1 轮：改名 + 「文本的圆点太小了」→ 曾用 CSS 画 6px 实心圆。
 *   第 2 轮：「这个圆点太大了，你就用文字的 · 吧，然后圆点左右各一个空格」
 *            → 改回文字中点 ·，间距用 margin 表达。
 *
 * 实现约束（app-i18n.js:144-175）：translateDOM() 只遍历带 data-i18n 的节点，
 * 对纯文本 span 用 textContent 整体覆盖 —— 中点绝不能塞进带 data-i18n 的 span 内，
 * 否则语言切换时被冲掉。因此三段各自带 data-i18n，两个中点是独立的 .nav-sep 节点。
 *
 * ⚠ 间距为什么不能写成 HTML 里的空格：.nav-sep 是 inline-block，按 CSS 文本处理
 * 规则「行首/行尾的可折叠空白会被移除」，写 ` · ` 渲染后只剩 `·`，间距静默失效。
 *
 * 同时锁定 Java static 镜像（历史上多次出现「只改一处漂移」）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const UI = path.join(REPO, 'gourd-work', 'desktop', 'ui');
const STATIC = path.join(REPO, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static');
const read = p => fs.readFileSync(p, 'utf8');

const INDEXES = [path.join(UI, 'index.html'), path.join(STATIC, 'index.html')];
const CSS_FILES = [path.join(UI, 'css', 'app.css'), path.join(STATIC, 'css', 'app.css')];

function flatKeys(obj, prefix, out) {
  Object.keys(obj).forEach(k => {
    const key = prefix ? prefix + '.' + k : k;
    if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) flatKeys(obj[k], key, out);
    else out.add(key);
  });
  return out;
}

test('① 侧栏标题是三段独立 i18n 文本（不是把中点写进单个 key）', () => {
  INDEXES.forEach(p => {
    assert.ok(fs.existsSync(p), '自证：文件存在 ' + p);
    const s = read(p);
    assert.match(s, /class="main-nav-label nav-composite"/, p + ': 应使用 nav-composite 容器');
    assert.match(s, /<span data-i18n="app\.skills">/, p + ': 技能段必须独立带 i18n');
    assert.match(s, /<span data-i18n="app\.nav\.connectors">/, p + ': 连接器段必须独立带 i18n');
    assert.match(s, /<span data-i18n="app\.nav\.interfaces">/, p + ': 接口段必须独立带 i18n');
    // 单个 key 里塞 「·」 的旧写法必须不存在
    assert.doesNotMatch(s, /data-i18n="app\.skills"[^>]*>[^<]*·/, p + ': 不得把文本中点塞进 i18n 文本');
  });
});

test('② 两个分隔中点是独立 DOM 节点，且不带 i18n（语言切换冲不掉）', () => {
  INDEXES.forEach(p => {
    const s = read(p);
    const seps = s.match(/class="nav-sep"/g) || [];
    assert.equal(seps.length, 2, p + ': 应恰好有 2 个 .nav-sep');
    assert.doesNotMatch(s, /class="nav-sep"[^>]*data-i18n/, p + ': 中点节点不得带 data-i18n');
    assert.match(s, /aria-hidden="true"/, p + ': 装饰中点应对读屏隐藏');
    // 中点必须是节点里的**文字**，不是靠 CSS 画出来的空节点
    const texts = s.match(/class="nav-sep"[^>]*>([^<]*)</g) || [];
    assert.equal(texts.length, 2, p + ': 应能匹配到 2 个 .nav-sep 的文字内容');
    texts.forEach(t => {
      assert.match(t, />·</, p + ': .nav-sep 的文字必须是中点 ·，实际: ' + t);
    });
  });
});

test('③ 分隔符是文字中点 + margin 间距（不是 CSS 画的实心圆）', () => {
  CSS_FILES.forEach(p => {
    assert.ok(fs.existsSync(p), '自证：文件存在 ' + p);
    const s = read(p);
    const rule = s.match(/\.nav-sep\s*\{[^}]*\}/);
    assert.ok(rule, p + ': 缺少 .nav-sep 规则');
    const r = rule[0];

    // 用户第 2 轮明确：「这个圆点太大了，你就用文字的 · 吧」→ 实心圆必须已移除。
    // 这条同时防止「CSS 圆 + 文字中点」两套并存导致视觉变粗。
    assert.doesNotMatch(r, /border-radius/, p + ': 不得再用 CSS 画实心圆（用户要求改回文字 ·）');
    assert.doesNotMatch(r, /background:\s*currentColor/, p + ': 不得再有实心圆背景');
    assert.doesNotMatch(r, /width:\s*\d+px/, p + ': 文字中点不需要固定宽度');
    assert.doesNotMatch(r, /height:\s*\d+px/, p + ': 文字中点不需要固定高度');

    // 「左右各一个空格」：inline-block 的行首/行尾可折叠空白会被 CSS 移除，
    // 所以间距只能由 margin 承担；写进 HTML 的空格会静默失效。
    const m = r.match(/margin:\s*([^\s;]+)\s+([^\s;]+)/);
    assert.ok(m, p + ': 缺少左右 margin，间距会失效: ' + r);
    assert.equal(m[1], '0', p + ': 上下 margin 应为 0，实际 ' + m[1]);
    // 允许 em 或 px，但必须是非零正数，且 em 写法要接近一个字宽（.2~.5em）
    const val = m[2];
    const isEm = /em$/.test(val);
    const isPx = /px$/.test(val);
    assert.ok(isEm || isPx, p + ': 左右 margin 单位应是 em 或 px，实际 ' + val);
    // parseFloat 天然吃掉前导点（'.3em' → 0.3）；上一版用捕获组 `(\d*\.?\d+)`
    // 会把 '.3em' 捕成 '3' 从而误报，这里刻意不用捕获组。
    const n = parseFloat(val);
    assert.ok(Number.isFinite(n) && n > 0, p + ': 左右 margin 必须是正数，实际 ' + val);
    if (isEm) {
      assert.ok(n >= 0.2 && n <= 0.5, p + ': em 间距应在 .2~.5em（约一个空格宽），实际 ' + n);
    } else {
      assert.ok(n >= 2 && n <= 6, p + ': px 间距应在 2~6px（约一个空格宽），实际 ' + n);
    }

    // 中点比正文淡一点，避免抢过导航文字本身
    assert.match(r, /opacity:\s*\.?\d/, p + ': 应有 opacity 弱化中点');
  });
});

test('④ 12 份桌面语言包 + static 镜像键集一致，且新增键有实际译文', () => {
  [path.join(UI, 'locales'), path.join(STATIC, 'locales')].forEach(dir => {
    assert.ok(fs.existsSync(dir), '自证：语言包目录存在 ' + dir);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    assert.equal(files.length, 12, dir + ': 应有 12 份语言包');
    const sets = files.map(f => flatKeys(JSON.parse(read(path.join(dir, f))), '', new Set()));
    const signatures = new Set(sets.map(s => [...s].sort().join('|')));
    assert.equal(signatures.size, 1, dir + ': 12 份键集必须完全一致（locale-parity 契约）');
    files.forEach(f => {
      const j = JSON.parse(read(path.join(dir, f)));
      assert.ok(j.app && j.app.nav, f + ': 缺 app.nav');
      assert.equal(typeof j.app.nav.connectors, 'string', f + ': 缺 app.nav.connectors');
      assert.ok(j.app.nav.connectors.trim().length > 0, f + ': connectors 不得为空');
      assert.equal(typeof j.app.nav.interfaces, 'string', f + ': 缺 app.nav.interfaces');
      assert.ok(j.app.nav.interfaces.trim().length > 0, f + ': interfaces 不得为空');
      // app.skills 必须保留：app-skills.js:744 安装 toast 仍用它
      assert.equal(typeof j.app.skills, 'string', f + ': app.skills 必须保留');
    });
  });
});

test('⑤ 中文界面三段文案正确', () => {
  const zh = JSON.parse(read(path.join(UI, 'locales', 'zh-CN.json')));
  assert.equal(zh.app.skills, '技能');
  assert.equal(zh.app.nav.connectors, '连接器');
  assert.equal(zh.app.nav.interfaces, '接口');
});
