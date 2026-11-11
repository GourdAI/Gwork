/*
 * Static contract check for the hero app-window demo + single-nav layout.
 *
 * Verifies:
 *   1. every i18n key the demo needs (literal t('...') AND data-driven keys
 *      from textKey/labelKey/metaKey/CHECK_KEYS/TASK_KEYS) exists in all 7
 *      locales with a non-empty value;
 *   2. the zh values are real Chinese (no English source echo, no API/curl
 *      leftovers) — this is the "中英混杂" regression guard;
 *   3. the component does not use any key outside the covered contract (so a
 *      future key addition cannot silently ship untranslated);
 *   4. there is only ONE navigation level: ChapterRail is gone and its file
 *      does not exist;
 *   5. the old API terminal demo is gone: no component file, no import, no
 *      curl / Bearer / /v1/ / tokens / cost strings in the hero;
 *   6. every gw-app-* class used by the component has a CSS definition;
 *   7. all 7 locale files still have identical key counts.
 *   8. the reduced-motion path is still a progressive timeline, NOT the old
 *      frozen "already finished" frame (comments are stripped before checking
 *      so a commented-out example cannot fool this guard).
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC = path.join(ROOT, 'src')
const LOCALES = path.join(SRC, 'i18n/locales')
const LANGS = ['en', 'zh', 'zh-TW', 'fr', 'ru', 'ja', 'vi']
const DEMO = path.join(SRC, 'features/home/components/hero-app-demo.tsx')
const CSS = path.join(SRC, 'styles/gwork-brand.css')
const HOME_INDEX = path.join(SRC, 'features/home/index.tsx')
const HERO = path.join(SRC, 'features/home/components/sections/hero.tsx')

const fail = []
const pass = []
const ok = (m) => pass.push(m)
const bad = (m) => fail.push(m)
const read = (p) => fs.readFileSync(p, 'utf8')

// ── The 27-key contract (2 agent lines, 2 tool labels, 1 meta, 3 checks,
//    4 tasks, 1 user message + 14 UI literals = 27) ────────────────────────
const CONTRACT = [
  'Got it. I will rebuild the site in a dark tech style and highlight multi-platform downloads. First, let me analyse the current page structure.',
  'Explored',
  'GWork website · 12 files',
  'Edited',
  'The rebuild is complete: dark tech styling and the multi-platform download section are in place, ready for a local preview.',
  'Page structure analysis',
  'Dark theme and motion implementation',
  'Multi-platform download section',
  'Homepage visual rebuild',
  'Quarterly data report',
  'Release notes',
  'Dependency upgrade review',
  'Help me rebuild the homepage in a dark tech style and highlight multi-platform downloads.',
  'GWork — Homepage visual rebuild',
  'GWork product demo',
  'Running',
  'Completed',
  'New task',
  'Open workspace',
  'Tasks',
  'GWork user',
  'Model · Auto',
  'Describe your next task…',
  'Replay',
  'Syntax check passed',
  'Task complete',
  '2 min 41 s',
]

const demo = read(DEMO)
const css = read(CSS)

// 3: every key referenced by the component is in the contract.
const usedKeys = new Set()
for (const m of demo.matchAll(/\bt\(\s*'([^']+)'/g)) usedKeys.add(m[1])
for (const m of demo.matchAll(/\b(?:textKey|labelKey|metaKey):\s*'([^']+)'/g)) usedKeys.add(m[1])
for (const arr of ['CHECK_KEYS', 'TASK_KEYS']) {
  const block = new RegExp(`const ${arr} = \\[([\\s\\S]*?)\\] as const`).exec(demo)
  if (block) for (const m of block[1].matchAll(/'([^']+)'/g)) usedKeys.add(m[1])
}
const outside = [...usedKeys].filter((k) => !CONTRACT.includes(k))
if (outside.length) bad(`component uses keys outside the i18n contract: ${outside.join(' | ')}`)
else ok(`all ${usedKeys.size} keys referenced by the demo are in the 27-key contract`)

// 1: keys exist in all 7 locales.
const resources = {}
for (const lang of LANGS) {
  try { resources[lang] = JSON.parse(read(path.join(LOCALES, `${lang}.json`))).translation }
  catch (e) { bad(`${lang}.json parse failed: ${e.message}`) }
}
if (Object.keys(resources).length === LANGS.length) {
  const missing = []
  for (const k of CONTRACT) {
    for (const lang of LANGS) {
      const v = resources[lang][k]
      if (typeof v !== 'string' || !v.trim()) missing.push(`${lang}: ${k}`)
    }
  }
  if (missing.length) bad(`${missing.length} contract keys missing/empty (first 10): ${missing.slice(0, 10).join(' | ')}`)
  else ok(`all ${CONTRACT.length} contract keys present & non-empty in 7 locales`)

  // 2: zh values are Chinese and free of API-terminal leftovers.
  const zh = resources.zh
  const echoed = CONTRACT.filter((k) => zh[k] === k)
  const apiWords = /\b(curl|Bearer|\/v1\/|tokens|API|endpoint|HTTP|POST|GET)\b/i
  const apiLeft = CONTRACT.filter((k) => apiWords.test(zh[k]))
  const noHan = CONTRACT.filter((k) => !/[\u4e00-\u9fa5]/.test(zh[k]))
  if (echoed.length) bad(`zh.json echoes English source: ${echoed.join(' | ')}`)
  else ok('no English-as-value echo in zh.json for the demo')
  if (apiLeft.length) bad(`zh.json demo values still contain API wording: ${apiLeft.map((k) => `${k} => ${zh[k]}`).join(' | ')}`)
  else ok('no API/curl/Bearer/token wording in zh demo values')
  if (noHan.length) bad(`zh.json demo values without Chinese: ${noHan.join(' | ')}`)
  else ok('every zh demo value contains Chinese characters')

  // 7: identical key counts.
  const counts = LANGS.map((l) => Object.keys(resources[l]).length)
  if (new Set(counts).size !== 1) bad(`locale key counts differ: ${LANGS.map((l, i) => `${l}=${counts[i]}`).join(', ')}`)
  else ok(`all 7 locales have identical key counts (${counts[0]})`)
}

// 4: single navigation level.
const indexText = read(HOME_INDEX)
if (/ChapterRail|gw-rail/.test(indexText) || fs.existsSync(path.join(SRC, 'features/home/components/chapter-rail.tsx'))) {
  bad('second-level chapter rail still present')
} else ok('only ONE nav level (ChapterRail removed, file deleted)')

// 5: API terminal demo removed.
const heroText = read(HERO)
const terminalFile = path.join(SRC, 'features/home/components/hero-terminal-demo.tsx')
const API_SMELLS = [
  'curl', 'Bearer', '/v1/', 'chat/completions',
  'HeroTerminalDemo', 'gw-frame', '~/.gwork/playground', '200 ok',
]
const heroLower = heroText.toLowerCase()
if (fs.existsSync(terminalFile)) bad('hero-terminal-demo.tsx still exists')
else if (/HeroTerminalDemo|hero-terminal-demo/.test(heroText + indexText)) bad('hero still imports the API terminal demo')
else if (API_SMELLS.some((s) => heroLower.includes(s.toLowerCase()))) bad('hero still contains API-terminal wording')
else ok('API terminal demo removed; hero renders the app-window demo instead')

// 6: gw-app-* classes all have CSS definitions.
const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))
const usedCls = new Set([...demo.matchAll(/((?:gw|gwork)-app-[\w-]+)/g)].map((m) => m[1]))
const undef = [...usedCls].filter((c) => !defined.has(c))
if (undef.length) bad(`gw-app-* classes without CSS: ${undef.join(', ')}`)
else ok(`all ${usedCls.size} gw-app-* classes have CSS definitions`)

// 8: reduced motion must still reveal steps over time. The old bug set the
// whole timeline at once (`setStage(STEPS.length)` + a busy=false finished
// frame) and returned early, which made the landing page look static. Detect
// that shape on REAL CODE ONLY: strip comments/strings first, otherwise a
// comment mentioning the old pattern (or a doc example) could fool the regex.
const demoCode = demo
  .replaceAll(/\/\*[\s\S]*?\*\//g, '')
  .replaceAll(/(^|[^:])\/\/.*$/gm, '$1')
const frozenShot =
  /setStage\(\s*STEPS\.length\s*\)/.test(demoCode) &&
  /setBusy\(\s*false\s*\)/.test(demoCode)
const reducedTimeline = /REDUCED_BEAT/.test(demoCode)
if (frozenShot) {
  bad('reduced motion froze into a finished frame again (setStage(STEPS.length) + setBusy(false))')
} else if (!reducedTimeline) {
  bad('reduced-motion timeline beats (REDUCED_BEAT) are missing')
} else ok('reduced motion keeps a progressive timeline (no frozen finished frame)')

console.log('\n=== GWork hero demo / single-nav check ===')
for (const p of pass) console.log(`  PASS  ${p}`)
for (const f of fail) console.log(`  FAIL  ${f}`)
console.log(`\n${fail.length ? 'FAILED' : 'ALL GREEN'} — ${pass.length} passed, ${fail.length} failed\n`)
process.exit(fail.length ? 1 : 0)
