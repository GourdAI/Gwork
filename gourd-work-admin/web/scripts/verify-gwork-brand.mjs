// Static verification for the GWork rebrand (no build toolchain required).
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd())
const errors = []
const ok = (label) => console.log(`  ok  ${label}`)
const check = (cond, label) => (cond ? ok(label) : errors.push(label))

console.log('Locale files')
for (const f of readdirSync(resolve(root, 'src/i18n/locales')).filter((x) => x.endsWith('.json'))) {
  try {
    const d = JSON.parse(readFileSync(resolve(root, 'src/i18n/locales', f), 'utf8'))
    check(!!d.translation && Object.keys(d.translation).length > 7000, `${f} nested translation intact (${Object.keys(d.translation || {}).length} keys)`)
    check(Object.keys(d).length === 1, `${f} has no leaked top-level keys`)
  } catch (e) {
    errors.push(`${f}: invalid JSON ${e.message}`)
  }
}

console.log('Brand defaults')
const html = readFileSync(resolve(root, 'index.html'), 'utf8')
check(html.includes('<title>GWork</title>'), 'index.html title = GWork')
check(html.includes('content="GWork"'), 'index.html meta title = GWork')
check(html.includes('rel="icon"'), 'index.html favicon link present')
check(/newapi:theme:v1:mode/.test(html), 'theme boot script / light-dark-system preference intact')
check(!/New API|newapi\.pro|QuantumNous/.test(html), 'no upstream brand in index.html')

const constants = readFileSync(resolve(root, 'src/lib/constants.ts'), 'utf8')
check(constants.includes("DEFAULT_SYSTEM_NAME = 'GWork'"), 'frontend default system name = GWork')

const goConstants = readFileSync(resolve(root, '../common/constants.go'), 'utf8')
check(goConstants.includes('var SystemName = "GWork"'), 'backend default system name = GWork')

console.log('Theme contract')
const css = readFileSync(resolve(root, 'src/styles/index.css'), 'utf8')
check(css.includes('./gwork-brand.css'), 'brand layer imported by index.css')
const brand = readFileSync(resolve(root, 'src/styles/gwork-brand.css'), 'utf8')
const overrides = /--(primary|background|foreground|border|card|muted|ring|accent)\s*:/.test(brand)
check(!overrides, 'brand layer does NOT override any theme color token')
const themeCss = readFileSync(resolve(root, 'src/styles/theme.css'), 'utf8')
check(themeCss.includes('--primary: oklch('), 'theme.css primary token unchanged')
const presets = readFileSync(resolve(root, 'src/styles/theme-presets.css'), 'utf8')
check(presets.includes("[data-theme-preset='underground']"), 'theme presets unchanged')

console.log('Visible branding')
const checkFiles = [
  'src/components/layout/components/footer.tsx',
  'src/features/about/index.tsx',
  'src/features/errors/general-error.tsx',
  'src/features/auth/auth-layout.tsx',
  'src/components/layout/components/public-header.tsx',
  'src/components/layout/components/system-brand.tsx',
  'src/assets/logo.tsx',
]
for (const f of checkFiles) {
  const s = readFileSync(resolve(root, f), 'utf8')
  check(!/QuantumNous\/new-api|songquanpeng|docs\.newapi/.test(s), `${f} has no upstream brand links`)
}
const footer = readFileSync(resolve(root, 'src/components/layout/components/footer.tsx'), 'utf8')
check(!/ProjectAttribution|NEW_API_FOOTER/.test(footer), 'footer attribution removed')
const about = readFileSync(resolve(root, 'src/features/about/index.tsx'), 'utf8')
check(!/AGPL|Based on|JustSong/.test(about), 'about page upstream attribution removed')

if (errors.length) {
  console.error(`\nFAILED (${errors.length}):`)
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('\nALL STATIC CHECKS PASS')
