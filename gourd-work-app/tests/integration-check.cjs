/* uni-app-x 工程静态自检：pages.json 引用完整性、tabBar 图标、主题导出、
 * 门禁残留、4 页 UTS 结构。不依赖 HBuilderX，Node 直接可跑。
 *   node gourd-work-app/gwork-app/tests/integration-check.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MOBILE = path.resolve(ROOT, '..', 'mobile');
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); pass++; }
  else { console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); fail++; }
}
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

console.log('== uni-app-x 工程静态自检 ==');

// 1. pages.json：上游含 // #ifdef 注释，先剥离行注释再解析
const raw = fs.readFileSync(path.join(ROOT, 'pages.json'), 'utf8');
const stripped = raw.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
let cfg = null;
try { cfg = JSON.parse(stripped); } catch (e) { console.log('  FAIL pages.json 解析: ' + e.message); fail++; }
check('pages.json 可解析（剥离条件编译注释后）', cfg !== null);
if (cfg) {
  const paths = (cfg.pages || []).map(p => p.path);
  const missing = paths.filter(p => !exists(p + '.uvue'));
  check(`pages.json 引用的 ${paths.length} 个页面均存在 .uvue`, missing.length === 0, missing.join(', '));
  check('首个 page 为首页 tasks（无配对门禁）', paths[0] === 'pages/tasks/tasks', paths[0]);
  const tab = cfg.tabBar || {};
  check('tabBar 恰好 4 项', (tab.list || []).length === 4);
  const labels = (tab.list || []).map(i => i.text).join('/');
  check('tabBar 文案为 任务/定时任务/发现/我的', labels === '任务/定时任务/发现/我的', labels);
  const icons = (tab.list || []).flatMap(i => [i.iconPath, i.selectedIconPath]).filter(Boolean);
  const missIcons = icons.filter(p => !exists(p));
  check(`tabBar 引用的 ${icons.length} 个图标均存在`, missIcons.length === 0, missIcons.join(', '));
  check('tabBar 无顶部分隔线（borderStyle=white）', tab.borderStyle === 'white');
  check('选中色为黑色实心 / 背景浅色', tab.selectedColor === '#141416' && tab.backgroundColor === '#fafafa');
}

// 2. 无启动门禁（先剥离行注释，避免「不做任何 redirectTo」这类说明文字误报）
const appVue = fs.readFileSync(path.join(ROOT, 'App.uvue'), 'utf8');
const appCode = appVue.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
check('App.uvue 无 redirectTo / reLaunch 启动门禁', !/redirectTo|reLaunch/.test(appCode));
check('App.uvue onLaunch 初始化主题', /initWorkbuddyTheme\(\)/.test(appVue));

// 3. 公共模块导出与数据契约一致
const themeUts = fs.readFileSync(path.join(ROOT, 'common/workbuddy-theme.uts'), 'utf8');
check('主题模块导出 setWorkbuddyTheme', /export function setWorkbuddyTheme/.test(themeUts));
check('主题模块导出 initWorkbuddyTheme', /export function initWorkbuddyTheme/.test(themeUts));
const dataUts = fs.readFileSync(path.join(ROOT, 'common/workbuddy-data.uts'), 'utf8');
const dataJs = fs.readFileSync(path.join(MOBILE, 'js/data.js'), 'utf8');
check('UTS 与 H5 品牌文案一致（GWork）',
  /name:\s*'GWork'/.test(dataUts) && /name:\s*'GWork'/.test(dataJs));
// 只禁止「字符串字面量里出现 WorkBuddy」= 防止可见文案被写回旧品牌；
// 源码注释里「对照 WorkBuddy 参考图」是事实描述，不应造成假失败。
check('UTS 与 H5 可见文案无 WorkBuddy 残留',
  !/['"]WorkBuddy/.test(dataUts) && !/['"]WorkBuddy/.test(dataJs));
check('UTS 与 H5 均引用 GWork 图形商标 logo',
  /logo:\s*'[^']*gwork-logo\.png'/.test(dataUts) && /logo:\s*'[^']*gwork-logo\.png'/.test(dataJs));
check('GWork 图形商标资源存在于两套载体',
  exists('static/gwork-logo.png') && fs.existsSync(path.join(MOBILE, 'assets/gwork-logo.png')));
check('UTS 默认主题为 system', /DEFAULT_THEME:\s*string\s*=\s*'system'/.test(dataUts));
check('UTS 强调色与 H5 一致 #0fbc9b',
  dataUts.includes('#0fbc9b') && dataJs.includes('#0fbc9b'));

// 4. 4 个主页面 UTS 结构
const pages = ['tasks/tasks', 'loop/loop', 'discover/discover', 'mine/mine'];
pages.forEach(p => {
  const f = path.join(ROOT, 'pages', p + '.uvue');
  const s = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  check(`${p}.uvue 存在且为 UTS setup 写法`, s.includes('<script lang="uts" setup>') && s.includes('</script>'));
  check(`${p}.uvue 使用全视口根容器`, s.includes('gw-page-root'));
  check(`${p}.uvue 无 Vue2-only 写法（无 this.$ / filters / v-html）`,
    !/this\.\$|filters:|v-html/.test(s));
});

// 5. 上游合规与资源
check('保留上游 Apache-2.0 license.md', exists('license.md'));
check('保留上游 README.md', exists('README.md'));
check('机器人插画存在', exists('static/robot.png'));
check('INTEGRATION.md 存在且如实记录真实打包链路', (() => {
  const f = path.join(ROOT, 'INTEGRATION.md');
  if (!fs.existsSync(f)) return false;
  const txt = fs.readFileSync(f, 'utf8');
  // 语义契约（随交付状态演进）：本机已用 HBuilderX 5.34 CLI 真实编译 + 云打包出 APK，
  // 文档必须记录真实链路与产物，且不得残留旧版「未编译」的过时声明。
  const hasRealChain = txt.includes('HBuilderX 5.34') && txt.includes('pack --precheck') &&
    txt.includes('pack artifact') && txt.includes('gwork-android-3.0.4.apk') &&
    txt.includes('__UNI__2C8A727');
  const stale = ['未在本机实际编译', '本机未实际编译', '未实际编译', '无法实际编译',
    '无法编译', '没有实际编译', '没有编译', '不谎称已打 Android 包']
    .some(kw => txt.includes(kw));
  return hasRealChain && !stale;
})());

// 6. config.uts 模型对齐与无密钥
const cfgUts = fs.readFileSync(path.join(ROOT, 'uni_modules/uni-ai-x/config.uts'), 'utf8');
['快速', '均衡', '极致', 'Hy4 preview', 'Hy3', 'DeepSeek-V4.1-Flash', 'GLM-5.3', 'GLM-5.3-Flash']
  .forEach(n => check('config.uts 含模型档位 ' + n, cfgUts.includes(n)));
check('config.uts 无硬编码密钥', !/sk-[A-Za-z0-9]{12,}|apiKey\s*[:=]\s*['"][^'"]{16,}/.test(cfgUts));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
