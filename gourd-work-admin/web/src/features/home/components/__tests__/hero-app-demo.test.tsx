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
import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HeroAppDemo } from '../hero-app-demo'

/**
 * Behaviour contract for the hero demo timeline.
 *
 * test-setup.ts forces `prefers-reduced-motion: reduce` to match, so the
 * default render here exercises the reduced-motion path — the one that used
 * to freeze the demo into a dead "already finished" frame on first paint
 * (the regression this file guards).
 */

const steps = (container: HTMLElement) =>
  container.querySelectorAll('.gw-app-step')
const checks = (container: HTMLElement) =>
  container.querySelectorAll('.gw-app-check-done')
const status = (container: HTMLElement) =>
  container.querySelector('.gw-app-winstatus')?.textContent ?? ''
const replayShown = (container: HTMLElement) =>
  !!container.querySelector('.gw-app-replay-show')

function setReducedMotion(reduced: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches:
        query.includes('prefers-reduced-motion') &&
        !query.includes('no-preference')
          ? reduced
          : false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  })
}

afterEach(() => {
  // Restore the global reduced-motion default from test-setup.ts.
  setReducedMotion(true)
  vi.useRealTimers()
})

describe('HeroAppDemo timeline', () => {
  it('reduced motion: reveals steps progressively instead of a frozen finished frame', async () => {
    setReducedMotion(true)
    const { container } = render(<HeroAppDemo />)

    // First paint must NOT be the finished demo: no steps yet, still busy.
    expect(steps(container)).toHaveLength(0)
    expect(status(container)).toContain('Running')
    expect(replayShown(container)).toBe(false)

    // Steps appear one by one...
    await waitFor(() => expect(steps(container).length).toBeGreaterThan(0))
    await waitFor(() => expect(steps(container).length).toBeGreaterThanOrEqual(3))
    // ...and the run eventually completes with every checklist item ticked.
    await waitFor(() => expect(steps(container)).toHaveLength(7))
    await waitFor(() => expect(checks(container)).toHaveLength(3))
    await waitFor(() => expect(status(container)).toContain('Completed'))
    await waitFor(() => expect(replayShown(container)).toBe(true))

    // Reduced motion never auto-loops: the finished frame stays put.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(steps(container)).toHaveLength(7)
    expect(replayShown(container)).toBe(true)
  })

  it('reduced motion: terminal output appears whole (no typewriter) and replay restarts', async () => {
    setReducedMotion(true)
    const user = userEvent.setup()
    const { container } = render(<HeroAppDemo />)

    await waitFor(() =>
      expect(container.querySelector('.gw-app-term-cmd')?.textContent).toBe(
        'node --check js/main.js'
      )
    )
    // The command is set whole: the caret class (typewriter in progress) never
    // shows once the command text is complete.
    expect(
      container.querySelector('.gw-app-term-cmd.gw-app-caret')
    ).toBeNull()

    await waitFor(() => expect(replayShown(container)).toBe(true))

    await user.click(container.querySelector('.gw-app-replay') as HTMLElement)
    // Replay resets the timeline to the beginning.
    expect(steps(container)).toHaveLength(0)
    expect(status(container)).toContain('Running')
  })

  it('full motion: starts empty and begins revealing after the first beat', async () => {
    setReducedMotion(false)
    const { container } = render(<HeroAppDemo />)

    expect(steps(container)).toHaveLength(0)
    // First beat is 950ms; nothing may appear before it.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(steps(container)).toHaveLength(0)
    await waitFor(() => expect(steps(container).length).toBeGreaterThan(0), {
      timeout: 5000,
    })
  })
})
