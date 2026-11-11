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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { AuthLayout } from '../auth-layout'

/* AuthLayout pulls system branding through useSystemConfig (react-query +
   store) and renders its brand block inside a router <Link>. Neither is under
   test here, so both are stubbed — the stub returns a *non-empty* systemName so
   assertions on the visual mark still have something real to check. */
vi.mock('@/hooks/use-system-config', () => ({
  useSystemConfig: () => ({
    systemName: 'GWork Admin',
    /* Non-empty on purpose: AuthLayout renders <img src={logo}>, and jsdom
       warns on an empty src. A stub path keeps the render clean without
       touching what is under test. */
    logo: '/stub-logo.png',
    loading: false,
    logoLoaded: true,
  }),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: Record<string, unknown>) => (
    <a {...(rest as object)}>{children as React.ReactNode}</a>
  ),
}))

const CSS = readFileSync(resolve(__dirname, '../../../styles/gw-console.css'), 'utf8')

/** Every `@media (prefers-reduced-motion: reduce)` block, brace-balanced. */
function reducedMotionBlocks(css: string): string[] {
  const out: string[] = []
  const re = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    let depth = 1
    let i = m.index + m[0].length
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1
      else if (css[i] === '}') depth -= 1
      i += 1
    }
    expect(depth).toBe(0)
    out.push(css.slice(m.index, i))
  }
  return out
}

/** Flat `{ selector { body } }` declarations that mention `animation:`. */
function animationDeclarations(css: string) {
  const decls: { selectors: string[]; body: string; at: number }[] = []
  const re = /([^{}@/]+?)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    if (!/animation\s*:/.test(m[2])) continue
    decls.push({
      selectors: m[1].split(',').map((s) => s.trim()),
      body: m[2],
      at: m.index,
    })
  }
  return decls
}

describe('auth layout — Qoder-style split screen', () => {
  beforeAll(() => {
    /* Sanity-check the harness itself: if the CSS selector parser silently
       matched nothing, every "last declaration is animation:none" assertion
       below would pass vacuously. */
    expect(animationDeclarations(CSS).length).toBeGreaterThan(0)
    expect(reducedMotionBlocks(CSS).length).toBeGreaterThan(0)
  })

  it('renders the left brand-visual panel alongside the form column', () => {
    const { container } = render(
      <AuthLayout>
        <div data-testid='form-slot'>form goes here</div>
      </AuthLayout>
    )
    const shell = container.querySelector('.gw-auth-shell')
    expect(shell).not.toBeNull()
    /* Both columns must exist: dropping the visual column would silently
       revert the login page to the old bare single-column card. */
    expect(container.querySelector('.gw-auth-visual')).not.toBeNull()
    expect(container.querySelector('.gw-auth-stack')).not.toBeNull()
    /* The form is the reason the page exists — it must survive the restyle. */
    expect(screen.getByTestId('form-slot')).toBeInTheDocument()
  })

  it('renders the handwritten slogan through i18n, not as a hard-coded literal', () => {
    const { container } = render(
      <AuthLayout>
        <div>form</div>
      </AuthLayout>
    )
    const slogan = container.querySelector('.gw-auth-slogan')
    expect(slogan).not.toBeNull()
    /* test-setup initialises i18next with an empty `translation` resource, so
       t() falls back to returning the key itself. Asserting the key here pins
       the wiring (slogan goes through t()) rather than a baked-in string. */
    expect(slogan?.textContent).toBe('Beyond execution, pure creation.')
  })

  it('marks the brand illustration as decorative and keeps the system name visible', () => {
    const { container } = render(
      <AuthLayout>
        <div>form</div>
      </AuthLayout>
    )
    const art = container.querySelector('.gw-auth-art svg')
    expect(art).not.toBeNull()
    /* Purely decorative: screen readers must skip the whole illustration. */
    expect(art?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('.gw-auth-visual-mark')?.textContent).toBe('GWork Admin')
  })
})

describe('auth layout CSS — split geometry', () => {
  it('declares two columns and collapses to one on narrow screens', () => {
    const shell = CSS.match(/\.gw-auth-shell\s*\{([^}]*)\}/)
    expect(shell).not.toBeNull()
    expect(shell?.[1]).toMatch(/display:\s*grid|grid-template-columns/)
    expect(shell?.[1]).toMatch(/grid-template-columns:\s*\S+\s+\S+/)

    const narrow = CSS.match(/@media\s*\(max-width:\s*999px\)\s*\{([\s\S]*?)\n\}/)
    expect(narrow).not.toBeNull()
    /* Hiding the visual column is only safe because no auth control lives in
       it; the form column must then take the full width. */
    expect(narrow?.[1]).toMatch(/\.gw-auth-visual\s*\{\s*display:\s*none/)
    expect(narrow?.[1]).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  })

  it('keeps the illustration palette on theme tokens with no colour literals', () => {
    const artRules = CSS.match(/\.gw-art-[^{]*\{[^}]*\}/g) ?? []
    expect(artRules.length).toBeGreaterThan(0)
    for (const rule of artRules) {
      expect(rule, `colour literal in art palette: ${rule}`).not.toMatch(
        /#[0-9a-fA-F]{3,8}\b|rgba?\(/
      )
    }
  })

  /* Regression guard for the exact defect found in review on the desktop side:
     `animation: none` written *before* the animation it is meant to stop is
     dead code (same specificity → the later declaration wins), so the float
     keeps running even with reduced motion enabled. Assert on ordering, not
     mere presence. */
  it('stops the floating art under reduced motion with a rule that actually wins', () => {
    const decls = animationDeclarations(CSS)
    const hits = decls.filter((d) => d.selectors.includes('.gw-art-float'))
    expect(hits.length).toBeGreaterThan(0)
    const last = hits[hits.length - 1]
    expect(last.body, `.gw-art-float ends on: ${last.body.trim()}`).toMatch(/animation:\s*none/)
    /* And that winning declaration must live inside a reduced-motion block. */
    const block = reducedMotionBlocks(CSS).find((b) => b.includes('.gw-art-float'))
    expect(block).toBeDefined()
    expect(block).toMatch(/animation:\s*none/)
    expect(CSS.indexOf(block!)).toBeGreaterThan(
      decls.filter((d) => d.selectors.includes('.gw-art-float') && !/animation:\s*none/.test(d.body))
        .at(-1)?.at ?? -1
    )
  })
})
