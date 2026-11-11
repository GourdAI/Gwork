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
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HeroAppDemo } from '../hero-app-demo'

/**
 * Behaviour contract for the hero demo timeline.
 *
 * test-setup.ts forces `prefers-reduced-motion: reduce` to match, so the
 * default render here exercises the reduced-motion path — the one that used
 * to freeze the demo into a dead "already finished" frame on first paint.
 *
 * The manual Replay button is gone: BOTH motion modes must restart on the
 * fixed 5s loop, otherwise the demo would sit on the finished frame forever.
 * The loop is observed at runtime (steps reset to 0 after completion), not by
 * reading a constant, so deleting the loop is a KILLed mutation.
 */

const steps = (container: HTMLElement) =>
  container.querySelectorAll('.gw-app-step')
const checks = (container: HTMLElement) =>
  container.querySelectorAll('.gw-app-check-done')
const status = (container: HTMLElement) =>
  container.querySelector('.gw-app-winstatus')?.textContent ?? ''

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
  it('reduced motion: reveals progressively, has no Replay button, and auto-loops', async () => {
    setReducedMotion(true)
    const { container } = render(<HeroAppDemo />)

    // First paint must NOT be the finished demo: no steps yet, still busy.
    expect(steps(container)).toHaveLength(0)
    expect(status(container)).toContain('Running')
    // The manual replay control must not exist in the DOM at all.
    expect(container.querySelector('.gw-app-replay')).toBeNull()
    expect(container.querySelector('button')).toBeNull()

    // Steps appear one by one...
    await waitFor(() => expect(steps(container).length).toBeGreaterThan(0))
    await waitFor(() => expect(steps(container).length).toBeGreaterThanOrEqual(3))
    // ...and the run completes with every checklist item ticked.
    await waitFor(() => expect(steps(container)).toHaveLength(7), {
      timeout: 8000,
    })
    await waitFor(() => expect(checks(container)).toHaveLength(3))
    await waitFor(() => expect(status(container)).toContain('Completed'))

    // After the 5s loop the timeline resets and starts a fresh run. If the
    // auto-loop guard were removed this would time out: the finished frame
    // would stay on screen forever — exactly the static-page regression.
    await waitFor(() => expect(steps(container)).toHaveLength(0), {
      timeout: 9000,
    })
    await waitFor(() => expect(status(container)).toContain('Running'))
    expect(container.querySelector('.gw-app-replay')).toBeNull()
  }, 20000)

  it('reduced motion: terminal output appears whole (no typewriter), no Replay button', async () => {
    setReducedMotion(true)
    const { container } = render(<HeroAppDemo />)

    await waitFor(
      () =>
        expect(container.querySelector('.gw-app-term-cmd')?.textContent).toBe(
          'node --check js/main.js'
        ),
      { timeout: 8000 }
    )
    // The command is set whole: the caret class (typewriter in progress) never
    // shows once the command text is complete.
    expect(
      container.querySelector('.gw-app-term-cmd.gw-app-caret')
    ).toBeNull()

    await waitFor(() => expect(status(container)).toContain('Completed'), {
      timeout: 8000,
    })
    expect(container.querySelector('.gw-app-replay')).toBeNull()
  }, 15000)

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
    expect(container.querySelector('.gw-app-replay')).toBeNull()
  })
})
