/*
 * Static contract check for the GWork public-site layout rewrite.
 *
 * Verifies:
 *   1. every gw-* class referenced by a .tsx has a definition in the brand
 *      skin sheets (gwork-brand.css + gw-console.css)
 *   2. no stale gwork-* (old brand-layer) class survives without an alias
 *   3. CSS braces balance
 *   4. every literal t('key') used by the landing/about/footer code exists in
 *      all 7 locale files (i18n key set must stay stable)
 *   5. zh.json has no English-as-translation leftovers for the visible keys
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const CSS_FILES = [
  path.join(ROOT, 'src/styles/gwork-brand.css'),
  path.join(ROOT, 'src/styles/gw-console.css'),
]
const SRC = path.join(ROOT, 'src')
const LOCALES = path.join(SRC, 'i18n/locales')
const LANGS = ['en', 'zh', 'zh-TW', 'fr', 'ru', 'ja', 'vi']

const fail = []
const pass = []
const ok = (msg) => pass.push(msg)
const bad = (msg) => fail.push(msg)

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const css = CSS_FILES.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))

// 1+2: class references in tsx
const tsxFiles = walk(SRC).filter((f) => f.endsWith('.tsx'))
const referenced = new Map()
const stale = new Set()
for (const f of tsxFiles) {
  const text = fs.readFileSync(f, 'utf8')
  for (const m of text.matchAll(/(?:^|[\s'"`])((?:gw|gwork)-[a-zA-Z][\w-]*)/g)) {
    const cls = m[1]
    if (cls === 'gwork-logo') continue // SVG <linearGradient id>, not a CSS class
    referenced.set(cls, (referenced.get(cls) ?? 0) + 1)
    if (cls.startsWith('gwork-')) stale.add(cls)
  }
}
const missing = [...referenced.keys()].filter((c) => !defined.has(c))
if (missing.length) bad(`classes referenced but NOT defined in CSS: ${missing.join(', ')}`)
else ok(`all ${referenced.size} gw-*/gwork-* class refs have CSS definitions`)

if (stale.size) bad(`stale gwork-* refs remaining: ${[...stale].join(', ')}`)
else ok('no stale gwork-* class refs')

// 3: brace balance (crude but catches truncation)
const opens = (css.match(/\{/g) ?? []).length
const closes = (css.match(/\}/g) ?? []).length
if (opens !== closes) bad(`CSS braces unbalanced: ${opens} open vs ${closes} close`)
else ok(`CSS braces balanced (${opens} rules-ish)`)

// 4: literal t('...') keys must exist in all 7 locales
const scope = [
  'src/features/home',
  'src/features/about',
  'src/components/layout/components/footer.tsx',
  'src/components/layout/components/public-header.tsx',
]
const keys = new Set()
for (const rel of scope) {
  const p = path.join(ROOT, rel)
  const files = fs.statSync(p).isDirectory() ? walk(p).filter((f) => /\.(tsx|ts)$/.test(f)) : [p]
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    for (const m of text.matchAll(/\bt\(\s*'([^']+)'/g)) keys.add(m[1])
    for (const m of text.matchAll(/\bt\(\s*"([^"]+)"/g)) keys.add(m[1])
  }
}
const resources = {}
for (const lang of LANGS) {
  const p = path.join(LOCALES, `${lang}.json`)
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (Object.keys(j).length !== 1 || !j.translation) bad(`${lang}.json top-level shape broken`)
    resources[lang] = j.translation
  } catch (e) {
    bad(`${lang}.json parse failed: ${e.message}`)
  }
}
if (Object.keys(resources).length === LANGS.length) {
  const missingKeys = []
  for (const k of keys) {
    for (const lang of LANGS) {
      if (!Object.prototype.hasOwnProperty.call(resources[lang], k)) {
        missingKeys.push(`${lang}: ${k}`)
      }
    }
  }
  if (missingKeys.length) bad(`${missingKeys.length} t() keys missing from locales (first 20):\n    ${missingKeys.slice(0, 20).join('\n    ')}`)
  else ok(`all ${keys.size} literal t() keys exist in all 7 locales`)
}

// 5: for the landing page's own literal t() keys, zh.json must not echo the
// English source string back as its translation. Technical keys elsewhere in
// the 7500-entry catalogue (model ids, format placeholders, error templates)
// legitimately keep value === key and are intentionally excluded.
const zh = resources.zh ?? {}
const englishLeft = [...keys].filter((k) => {
  const v = zh[k]
  if (typeof v !== 'string' || v !== k) return false
  return /[A-Za-z]{4}/.test(v) && /[.!?]|\s/.test(v)
})
if (englishLeft.length) bad(`zh.json has ${englishLeft.length} untranslated landing values: ${englishLeft.join(' | ')}`)
else ok(`all ${keys.size} landing t() keys are translated in zh.json`)

console.log(`\n=== GWork layout static check ===`)
for (const p of pass) console.log(`  PASS  ${p}`)
for (const f of fail) console.log(`  FAIL  ${f}`)
console.log(`\n${fail.length ? 'FAILED' : 'ALL GREEN'} — ${pass.length} passed, ${fail.length} failed\n`)
process.exit(fail.length ? 1 : 0)
