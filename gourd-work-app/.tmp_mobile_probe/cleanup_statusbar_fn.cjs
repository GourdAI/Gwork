// 清理：各页已改用 CSS 变量 --status-bar-height 让位，删掉不再使用的
// statusBarHeightFn / statusBarBox import / App.uvue 的 JS 取值逻辑。
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/work/gourd/gourdai/gourd-work-app/gwork-app';

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (['unpackage', 'uni_modules', '.git', 'node_modules', '.hbuilderx'].includes(e.name)) continue;
      walk(p, out);
    } else if (e.name.endsWith('.uvue')) out.push(p);
  }
  return out;
}

for (const f of walk(ROOT)) {
  let s = fs.readFileSync(f, 'utf8');
  const before = s;
  const rel = path.relative(ROOT, f);

  // 1) 删掉 statusBarHeightFn 定义（含其上一行注释，若有）
  s = s.replace(/\t?\/\/ [^\n]*statusBar[^\n]*\n\tconst statusBarHeightFn = \(\): number => statusBarBox\.value\n/g, '');
  s = s.replace(/\t\/\/ 模板[^\n]*\n\tconst statusBarHeightFn = \(\): number => statusBarBox\.value\n/g, '');
  s = s.replace(/\tconst statusBarHeightFn = \(\): number => statusBarBox\.value\n/g, '');

  // 2) import 行里去掉 statusBarBox
  s = s.replace(/(\bimport\s*\{)([^}]*?)(\}\s*from\s*'\.\.\/\.\.\/store\/host\.uts')/g, (m, head, body, tail) => {
    const items = body.split(',').map(x => x.trim()).filter(Boolean).filter(x => x !== 'statusBarBox');
    return `${head} ${items.join(', ')}${tail}`;
  });

  if (s !== before) {
    fs.writeFileSync(f, s);
    console.log(rel + ': cleaned (leftoverFn=' + /statusBarHeightFn/.test(s) + ', leftoverBox=' + /statusBarBox/.test(s) + ')');
  }
}

// App.uvue：删掉 JS 取状态栏高度那段（H5 编译期就报类型错误，失败 fallback 0）
const app = path.join(ROOT, 'App.uvue');
let a = fs.readFileSync(app, 'utf8');
const beforeApp = a;
a = a.replace(/\tfunction applyStatusBarHeight\(\): number \{[\s\S]*?\n\t\}\n\n/, '');
a = a.replace(/\t\t\tapplyStatusBarHeight\(\)\n/, '');
// import 行去掉 setStatusBarHeight
a = a.replace(/(\bimport\s*\{)([^}]*?)(\}\s*from\s*'\.\/store\/host\.uts')/, (m, head, body, tail) => {
  const items = body.split(',').map(x => x.trim()).filter(Boolean).filter(x => x !== 'setStatusBarHeight');
  return `${head} ${items.join(', ')}${tail}`;
});
if (a !== beforeApp) {
  fs.writeFileSync(app, a);
  console.log('App.uvue: cleaned');
}
