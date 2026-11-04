// 状态栏让位改造：
// 1) 各页 .topbar 加 padding-top: var(--status-bar-height)，并把固定 height 改 min-height
//    （uni-app x 官方推荐：navigationStyle:custom 后用 --status-bar-height 让位，
//     不要用 JS 读 statusBarHeight —— App 端 GetSystemInfoResult 没有 getNumber 方法，
//     一旦抛异常就 fallback 0，顶栏被系统状态栏压住）
// 2) 删掉模板上的 :style="{ paddingTop: statusBarHeightFn() + 'px' }"
//    （非响应式函数调用 + 与 CSS 变量冲突，且 H5 端恒为 0）
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

const report = [];
for (const f of walk(ROOT)) {
  let s = fs.readFileSync(f, 'utf8');
  const before = s;
  const rel = path.relative(ROOT, f);

  // 1) 删模板里的 :style paddingTop 绑定
  s = s.replace(/\s*:style="\{\s*paddingTop:\s*statusBarHeightFn\(\)\s*\+\s*'px'\s*\}"/g, '');

  // 2) .topbar 固定 height -> min-height + padding-top
  //    匹配 .topbar { ... height: NNpx; ... }
  s = s.replace(/(\.topbar\s*\{[^}]*?)\bheight:\s*(\d+)px;/, (m, pre, px) => `${pre}min-height: ${px}px;\n\tpadding-top: var(--status-bar-height);`);

  if (s !== before) {
    fs.writeFileSync(f, s);
    const stillHas = /statusBarHeightFn\(\)\s*\+\s*'px'/.test(s);
    report.push(`${rel}: patched (leftover=${stillHas})`);
  }
}
console.log(report.join('\n'));
console.log('FILES=' + report.length);
