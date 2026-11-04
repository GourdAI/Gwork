const fs = require('fs');
const path = require('path');
const ROOT = 'D:/work/gourd/gourdai/gourd-work-app/gwork-app';

// tasks.uvue 残留（正则没匹配上是因为该行用了 tab 且上一行注释已被前一版脚本删掉）
const t = path.join(ROOT, 'pages/tasks/tasks.uvue');
let s = fs.readFileSync(t, 'utf8');
const beforeT = s;
s = s.replace(/\tconst statusBarHeightFn = \(\): number => statusBarBox\.value\r?\n/, '');
s = s.replace(/\t\/\/ 模板无法直接读 import 进来的 reactive 对象属性，包一层 computed。\r?\n/, '');
s = s.replace("import { hostStore, initTheme} from '../../store/host.uts'", "import { hostStore, initTheme } from '../../store/host.uts'");
if (s !== beforeT) { fs.writeFileSync(t, s); console.log('tasks patched'); } else { console.log('tasks NO CHANGE'); }

// App.uvue：删掉过时的状态栏注释块 + 修 import 空格
const a = path.join(ROOT, 'App.uvue');
let ap = fs.readFileSync(a, 'utf8');
const beforeA = ap;
ap = ap.replace(/\t\/\*\*\r?\n\t \* 记录状态栏高度，供各页自绘顶栏消费。\r?\n[\s\S]*?\r?\n\t \*\/\r?\n/, '');
ap = ap.replace("import { initTheme, bindHostStore} from './store/host.uts'", "import { initTheme, bindHostStore } from './store/host.uts'");
if (ap !== beforeA) { fs.writeFileSync(a, ap); console.log('App.uvue patched'); } else { console.log('App.uvue NO CHANGE'); }

// 全量残留检查
function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (['unpackage', 'uni_modules', '.git', 'node_modules', '.hbuilderx'].includes(e.name)) continue; walk(p, out); }
    else if (/\.(uts|uvue)$/.test(e.name)) out.push(p);
  }
  return out;
}
let left = 0;
for (const f of walk(ROOT)) {
  const c = fs.readFileSync(f, 'utf8');
  if (/statusBarHeightFn|statusBarBox/.test(c)) { console.log('LEFTOVER ' + path.relative(ROOT, f)); left++; }
}
console.log('LEFTOVER_FILES=' + left);
