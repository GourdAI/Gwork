/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

/**
 * Static verification for the landing-page i18n fix.
 *
 *   (a) all 7 locale JSON files parse and have exactly one top-level key:
 *       "translation";
 *   (b) the 15 previously missing keys exist and are non-empty in all 7 files;
 *   (c) every key touched by step 1 / step 2 has a Simplified Chinese value in
 *       zh.json that contains no ASCII letters, except for the documented
 *       proper nouns / technical terms in ALLOWED_LATIN;
 *   (d) extra guard: the footer short labels and "Contact support" are
 *       localized in fr / ru / ja / vi (no raw English leftovers).
 *
 * Run from anywhere:
 *   node gourd-work-admin/web/scripts/verify-zh-landing.mjs
 *
 * Exits with code 1 and prints a failure list when any assertion fails.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOCALES = resolve(HERE, '../src/i18n/locales')
const LANGS = ['en', 'zh', 'zh-TW', 'fr', 'ru', 'ja', 'vi']

/* ------------------------------------------------------------------ *
 * Step 2: the 15 keys that were missing from all 7 locale files.
 * ------------------------------------------------------------------ */
const NEW_KEYS = [
  'Windows (64-bit)',
  'macOS (Apple silicon)',
  'macOS (Intel)',
  'Linux x64 (portable)',
  'Linux x64 (Debian/Ubuntu)',
  'Multi-platform downloads',
  'All downloads',
  'Every GWork installer, for all supported platforms.',
  'Loading download list...',
  'No installers are available yet.',
  'Installers are being prepared. Check back soon, or refresh this page.',
  'Download list is temporarily unavailable.',
  'No download links are shown until the release list loads successfully.',
  'Built-in auto-update keeps the app on the latest release after installation.',
  'Already signed in? Download the desktop app and connect it to this workspace.',
]

/* ------------------------------------------------------------------ *
 * Step 1: all keys whose Simplified Chinese translation was repaired.
 * This is the full scan result of zh.json original lines 7377-7531
 * (value === key / English value, minus pure-symbol, URL and technical
 * proper-noun whitelist items), plus the explicitly listed step-1 keys.
 * ------------------------------------------------------------------ */
const STEP1_KEYS = [
  'A Monaco editor, Git diff view and integrated terminal let AI read, write and verify changes inside your project.',
  'Break a complex goal into a visible multi-step plan, let sub-agents collaborate, and review or take over at any point.',
  'Connect OpenAI, Claude, Gemini, DeepSeek and local Ollama in one interface, and switch models at any time.',
  'Desktop platforms supported',
  'Download GWork, connect a model, and let agents handle the multi-step work while you stay in control.',
  'GWork brings multi-model access, agent task orchestration, a skill marketplace and a local workspace together, so conversations, coding, documents and automation all happen on your desktop.',
  'Install community skills in one click and plug in MCP tools so the workspace keeps growing with you.',
  'Local-first data ownership',
  'SHA256',
  'Windows, macOS and Linux share the same build, so the interface and capabilities stay consistent across devices.',
  'Workspaces and conversations live in the local .gwork folder. Keys never leave your machine and self-hosting is fully supported.',
  'Agent Orchestration',
  'Skills & Plugin Market',
  'Unified Model Access',
  'Built-in Coding Workspace',
  'Local-first Data',
  'Cross-platform',
  'Windows',
  'macOS',
  'Linux',
  'Windows x64 MSI',
  'macOS Apple Silicon',
  'macOS Intel',
  'Linux AppImage',
  'Linux deb',
  'Linux arm64 AppImage',
  'One desktop for all your AI work.',
  'Local-first AI workspace, built for everyday work.',
  'About GWork',
  'Agent orchestration',
  'Agent orchestration description',
  'Skills & plugins',
  'Skills & plugins description',
  'Local-first workspace',
  'Local-first workspace description',
  'Unified model access',
  'Unified model access description',
  'If this keeps happening, please contact support.',
  'Contact support',
  'footer.columns.product.title',
  'footer.columns.product.links.workspace',
  'footer.columns.product.links.downloads',
  'footer.columns.product.links.pricing',
  'footer.columns.resources.title',
  'footer.columns.resources.links.about',
  'footer.columns.resources.links.models',
  'footer.columns.resources.links.dashboard',
  'footer.columns.workspace.title',
  'footer.columns.workspace.links.signIn',
  'footer.columns.workspace.links.profile',
  'footer.columns.workspace.links.keys',
  'Built for everyday work',
  'Explore capabilities',
  'Whether you write code, draft documents or run automation, GWork puts AI to work in your daily workflow.',
]

/* Step 3 short labels that must no longer be raw English in fr/ru/ja/vi. */
const LOCALIZED_LABELS = [
  'footer.columns.product.title',
  'footer.columns.product.links.workspace',
  'footer.columns.product.links.downloads',
  'footer.columns.product.links.pricing',
  'footer.columns.resources.title',
  'footer.columns.resources.links.about',
  'footer.columns.resources.links.models',
  'footer.columns.resources.links.dashboard',
  'footer.columns.workspace.title',
  'footer.columns.workspace.links.signIn',
  'footer.columns.workspace.links.profile',
  'footer.columns.workspace.links.keys',
  'Contact support',
]

/**
 * Proper nouns / technical terms that are intentionally kept in Latin script
 * in the Simplified Chinese UI. Longest-first ordering matters ("GitHub"
 * before "Git", "OpenAI" before "AI").
 */
const ALLOWED_LATIN = [
  'GWork', 'OpenAI', 'Claude', 'Gemini', 'DeepSeek', 'Ollama', 'Qwen',
  'API', 'GitHub', 'Git', 'Monaco', 'MCP', 'macOS', 'Linux', 'Windows',
  'curl', 'Markdown', 'JSON', 'AI',
].sort((a, b) => b.length - a.length)
const ALLOWED_RE = new RegExp(`\\b(?:${ALLOWED_LATIN.join('|')})\\b`, 'gi')

/** Any ASCII letter left after removing allowed proper nouns is a failure. */
const latinLettersOutsideWhitelist = (value) =>
  value.replace(ALLOWED_RE, ' ').match(/[A-Za-z]+/g) ?? []

const failures = []
const notes = []
const ok = (msg) => console.log(`  ok  ${msg}`)
const fail = (msg) => {
  failures.push(msg)
  console.log(`  FAIL  ${msg}`)
}

/* ------------------------------------------------------------------ *
 * (a) parse + shape of all 7 files
 * ------------------------------------------------------------------ */
console.log('(a) JSON parse + top-level shape')
const docs = {}
for (const lang of LANGS) {
  const path = resolve(LOCALES, `${lang}.json`)
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    fail(`${lang}.json: cannot read file: ${e.message}`)
    continue
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch (e) {
    fail(`${lang}.json: JSON.parse failed: ${e.message}`)
    continue
  }
  const top = Object.keys(data)
  if (top.length !== 1 || top[0] !== 'translation') {
    fail(`${lang}.json: top-level keys must be exactly ["translation"], got ${JSON.stringify(top)}`)
  } else if (typeof data.translation !== 'object' || data.translation === null || Array.isArray(data.translation)) {
    fail(`${lang}.json: "translation" must be a flat object`)
  } else {
    const lines = raw.replace(/\r\n/g, '\n').trimEnd().split('\n').length
    docs[lang] = { raw, data, lines, keys: Object.keys(data.translation).length }
    ok(`${lang}.json: parse ok, top-level = ["translation"], ${data.translation ? Object.keys(data.translation).length : 0} keys, ${lines} lines, trailing newline = ${/\r?\n$/.test(raw)}`)
  }
}

if (Object.keys(docs).length !== LANGS.length) {
  console.log('\nCannot continue: one or more locale files are unreadable.')
  printResultAndExit()
}

/* Key-set / line-count evidence (informational, not an assertion). */
const keyCounts = new Set(LANGS.map((l) => docs[l].keys))
const lineCounts = new Set(LANGS.map((l) => docs[l].lines))
const enKeySet = new Set(Object.keys(docs.en.data.translation))
const sameKeySet = LANGS.every(
  (l) => Object.keys(docs[l].data.translation).length === enKeySet.size &&
    Object.keys(docs[l].data.translation).every((k) => enKeySet.has(k)),
)
notes.push(`key count per file: ${[...keyCounts].join(', ')} (identical = ${keyCounts.size === 1})`)
notes.push(`line count per file: ${[...lineCounts].join(', ')} (identical = ${lineCounts.size === 1})`)
notes.push(`all 7 files share the exact same key set: ${sameKeySet}`)

/* ------------------------------------------------------------------ *
 * (b) 15 new keys present + non-empty in all 7 files
 * ------------------------------------------------------------------ */
console.log('\n(b) 15 new keys present and non-empty in all 7 locale files')
const checkedNew = []
for (const key of NEW_KEYS) {
  for (const lang of LANGS) {
    const value = docs[lang].data.translation[key]
    if (typeof value !== 'string' || value.trim().length === 0) {
      fail(`${lang}.json / ${JSON.stringify(key)}: missing or empty`)
    }
    checkedNew.push(`${lang}:${key}`)
  }
}
if (!failures.length) {
  ok(`${NEW_KEYS.length} keys x ${LANGS.length} locales = ${checkedNew.length} checks passed (all present, non-empty)`)
} else {
  ok(`(see failure list above; ${NEW_KEYS.length * LANGS.length} checks executed)`)
}
notes.push(`(b) checked ${NEW_KEYS.length * LANGS.length} key/locale pairs`)

/* ------------------------------------------------------------------ *
 * (c) zh.json: step-1 + step-2 values contain no unallowed Latin letters
 * ------------------------------------------------------------------ */
console.log('\n(c) zh.json: step-1 + step-2 values contain no English letters outside the proper-noun whitelist')
const zh = docs.zh.data.translation
const checkedKeys = [...new Set([...STEP1_KEYS, ...NEW_KEYS])]
const cFailures = []
for (const key of checkedKeys) {
  const value = zh[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    cFailures.push(`${JSON.stringify(key)} -> missing or empty value ${JSON.stringify(value)}`)
    continue
  }
  const leftovers = latinLettersOutsideWhitelist(value)
  if (leftovers.length) {
    cFailures.push(`${JSON.stringify(key)} -> ${JSON.stringify(value)} [unallowed: ${leftovers.join(', ')}]`)
  }
}
if (cFailures.length === 0) {
  ok(`${checkedKeys.length} keys checked: 0 contain English letters outside ${ALLOWED_LATIN.length} whitelisted proper nouns`)
} else {
  fail(`zh.json has ${cFailures.length} key(s) with English letters outside the whitelist:`)
  for (const line of cFailures) console.log(`        ${line}`)
}
notes.push(`(c) whitelist: ${ALLOWED_LATIN.join(', ')}`)

/* ------------------------------------------------------------------ *
 * (d) extra guard: footer labels + "Contact support" localized in
 *     fr / ru / ja / vi (no raw English source string as value)
 * ------------------------------------------------------------------ */
console.log('\n(d) extra guard: footer labels + "Contact support" localized in fr/ru/ja/vi')
const dFailures = []
for (const lang of ['fr', 'ru', 'ja', 'vi']) {
  const t = docs[lang].data.translation
  for (const key of LOCALIZED_LABELS) {
    const expectedEnglish = docs.en.data.translation[key]
    if (t[key] === expectedEnglish || t[key] === key) {
      dFailures.push(`${lang}.json / ${JSON.stringify(key)} -> still ${JSON.stringify(t[key])}`)
    }
  }
}
if (dFailures.length === 0) {
  ok(`${LOCALIZED_LABELS.length} labels x 4 locales = ${LOCALIZED_LABELS.length * 4} checks passed (no raw English leftovers)`)
} else {
  fail(`${dFailures.length} raw English leftovers:`)
  for (const line of dFailures) console.log(`        ${line}`)
}

/* Whole landing region sweep, as extra evidence for the final report. */
const zhLines = docs.zh.raw.replace(/\r\n/g, '\n').split('\n')
const lineOf = (key) => zhLines.findIndex((l) => l.startsWith(`    ${JSON.stringify(key)}:`)) + 1
const landingResidue = Object.entries(zh)
  .filter(([k, v]) => typeof v === 'string' && /[A-Za-z]/.test(v) && !/[\u3400-\u9fff]/.test(v))
  .map(([k, v]) => ({ ln: lineOf(k), k, v }))
  .filter((r) => r.ln >= 7377 && r.ln <= 7531)
const landingBad = landingResidue.filter((r) => latinLettersOutsideWhitelist(r.v).length > 0)
if (landingBad.length) {
  fail(`zh.json original lines 7377-7531 still has ${landingBad.length} untranslated value(s)`)
  for (const r of landingBad) console.log(`        L${r.ln} ${JSON.stringify(r.k)} -> ${JSON.stringify(r.v)}`)
} else {
  const terms = landingResidue.map((r) => `${r.ln}:${r.v}`).join(', ') || 'none'
  ok(`zh.json original lines 7377-7531: no untranslated English prose (Latin-only values: ${terms})`)
}

/* ------------------------------------------------------------------ */
console.log('\n--- notes ---')
for (const n of notes) console.log(`  ${n}`)

printResultAndExit()

function printResultAndExit() {
  if (failures.length) {
    console.log(`\nFAILED: ${failures.length} assertion(s) did not pass.`)
    console.log('Failure list:')
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`))
    process.exit(1)
  }
  console.log('\nPASS: all assertions (a), (b), (c) and (d) succeeded.')
  process.exit(0)
}
