// 移动端源码静态门禁：import 重复本地名 / import 不存在的导出 / 事件处理器形态。
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/work/gourd/gourdai/gourd-work-app/gwork-app';

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (['unpackage', 'uni_modules', '.git', 'node_modules', '.hbuilderx'].includes(e.name)) continue;
      walk(p, out);
    } else if (/\.(uts|uvue)$/.test(e.name) && !e.name.endsWith('.map')) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const problems = [];

// 1) 同文件内 import 同名本地标识符重复
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const script = src.replace(/<template>[\s\S]*<\/template>/, '');
  const names = new Map();
  for (const m of script.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const raw of m[1].split(',')) {
      const parts = raw.trim().split(/\s+as\s+/);
      if (!parts[0].trim()) continue;
      const local = (parts[1] || parts[0]).trim();
      if (!names.has(local)) names.set(local, []);
      names.get(local).push(m[0].replace(/\s+/g, ' ').slice(0, 100));
    }
  }
  for (const [n, list] of names) {
    if (list.length > 1) problems.push(`DUP-IMPORT ${path.relative(ROOT, f)} :: ${n} -> ${list.join(' || ')}`);
  }
}

// 2) import 的名字在目标模块中不存在
const expCache = new Map();
function exportsOf(f) {
  if (expCache.has(f)) return expCache.get(f);
  let s = '';
  try { s = fs.readFileSync(f, 'utf8'); } catch { expCache.set(f, new Set()); return expCache.get(f); }
  const set = new Set();
  for (const m of s.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:type|interface|class|const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm)) set.add(m[1]);
  for (const m of s.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const raw of m[1].split(',')) { const n = raw.trim().split(/\s+as\s+/).pop().trim(); if (n) set.add(n); }
  }
  expCache.set(f, set);
  return set;
}
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = m[2];
    if (!target.startsWith('.')) continue;
    let p = path.resolve(path.dirname(f), target);
    for (const cand of [p, p + '.uts', p + '.uvue', path.join(p, 'index.uts')]) {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) { p = cand; break; }
    }
    if (!fs.existsSync(p)) { problems.push(`MODULE-NOT-FOUND ${path.relative(ROOT, f)} :: ${target}`); continue; }
    const ex = exportsOf(p);
    for (const raw of m[1].split(',')) {
      const parts = raw.trim().split(/\s+as\s+/);
      const orig = parts[0].trim();
      if (!orig) continue;
      if (!ex.has(orig) && !/^GWork/.test(orig) && !/^(UTSJSONObject|UTSArray|OnLaunchOptions|OnShowOptions|UniPage|UniApp|Uni)$/.test(orig)) problems.push(`MISSING-EXPORT ${path.relative(ROOT, f)} :: ${orig} (from ${target})`);
    }
  }
}

console.log(problems.join('\n'));
console.log('TOTAL_PROBLEMS=' + problems.length);
