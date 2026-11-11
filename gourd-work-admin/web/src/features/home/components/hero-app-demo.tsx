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
import {
  ArrowUp,
  Check,
  CircleCheck,
  FolderOpen,
  Pencil,
  Plus,
  RotateCcw,
  Search,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

/**
 * Hero product demo, ported from https://www.gourdwork.com/ .
 *
 * It shows a GWork desktop window running an agent task ("rebuild the website
 * in a dark tech style") instead of the old API/curl terminal mock. Steps are
 * revealed on a timeline: agent replies, tool calls, a checklist ticking off
 * one item at a time, a typewriter terminal, and a completion bar. It loops,
 * pauses while the tab is hidden or the window is off-screen, and can be
 * replayed.
 *
 * Under `prefers-reduced-motion` the demo must NOT freeze into a dead
 * "already finished" frame (that read as a broken/static page): it still
 * reveals the same steps one by one — the CSS media query already strips the
 * slide-in and blinking motion — but with shorter beats, no typewriter
 * (command and output appear whole) and no auto-loop; the Replay button is
 * shown at the end so the visitor stays in control.
 *
 * All colours come from existing theme tokens through color-mix, so light,
 * dark and system theme modes keep working.
 */

const TERMINAL_CMD = 'node --check js/main.js'
const CHECK_KEYS = [
  'Page structure analysis',
  'Dark theme and motion implementation',
  'Multi-platform download section',
] as const
const TASK_KEYS = [
  'Homepage visual rebuild',
  'Quarterly data report',
  'Release notes',
  'Dependency upgrade review',
] as const

type StepKind = 'agent' | 'tool' | 'checklist' | 'terminal' | 'done'

interface StepDef {
  kind: StepKind
  textKey?: string
  icon?: 'search' | 'pencil'
  labelKey?: string
  metaKey?: string
  metaRaw?: string
  add?: string
}

const STEPS: StepDef[] = [
  {
    kind: 'agent',
    textKey:
      'Got it. I will rebuild the site in a dark tech style and highlight multi-platform downloads. First, let me analyse the current page structure.',
  },
  {
    kind: 'tool',
    icon: 'search',
    labelKey: 'Explored',
    metaKey: 'GWork website · 12 files',
  },
  {
    kind: 'tool',
    icon: 'pencil',
    labelKey: 'Edited',
    metaRaw: 'index.html / styles.css',
    add: '+1,286',
  },
  { kind: 'checklist' },
  { kind: 'terminal' },
  {
    kind: 'agent',
    textKey:
      'The rebuild is complete: dark tech styling and the multi-platform download section are in place, ready for a local preview.',
  },
  { kind: 'done' },
]

/** Timeline beats (ms) for the animated run. */
const BEAT = {
  step: 950,
  check: 700,
  termLead: 300,
  type: 34,
  termOut: 340,
  termTail: 420,
  settle: 500,
  loop: 8000,
} as const

/**
 * Shorter beats for reduced motion: the reveal itself is the content, the
 * easing/blink motion is what the CSS media query removes.
 */
const REDUCED_BEAT = { step: 300, check: 200, termOut: 200, settle: 200 } as const

/** Wait but stay cancellable and pause while the tab is hidden / off-screen. */
function wait(
  ms: number,
  isCancelled: () => boolean,
  isPaused: () => boolean
): Promise<boolean> {
  return new Promise((resolve) => {
    let waited = 0
    const id = window.setInterval(() => {
      if (isCancelled()) {
        window.clearInterval(id)
        resolve(false)
        return
      }
      if (document.hidden || isPaused()) return
      waited += 60
      if (waited >= ms) {
        window.clearInterval(id)
        resolve(true)
      }
    }, 60)
  })
}

interface HeroAppDemoProps {
  className?: string
}

export function HeroAppDemo(props: HeroAppDemoProps) {
  const { t } = useTranslation()
  const [runId, setRunId] = useState(0)
  const [stage, setStage] = useState(0)
  const [checkDone, setCheckDone] = useState(0)
  const [typed, setTyped] = useState('')
  const [termOut, setTermOut] = useState(false)
  const [busy, setBusy] = useState(true)
  const [showReplay, setShowReplay] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const visibleRef = useRef(true)

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
      .matches

    let cancelled = false
    const isCancelled = () => cancelled
    const isPaused = () => !visibleRef.current

    const reset = () => {
      setStage(0)
      setCheckDone(0)
      setTyped('')
      setTermOut(false)
      setBusy(true)
      setShowReplay(false)
    }

    const run = async () => {
      reset()
      for (let i = 0; i < STEPS.length; i++) {
        const stepReady = await wait(
          reduced ? REDUCED_BEAT.step : BEAT.step,
          isCancelled,
          isPaused
        )
        if (!stepReady) return
        setStage(i + 1)
        const step = STEPS[i]
        if (step.kind === 'checklist') {
          for (let c = 1; c <= CHECK_KEYS.length; c++) {
            const checkReady = await wait(
              reduced ? REDUCED_BEAT.check : BEAT.check,
              isCancelled,
              isPaused
            )
            if (!checkReady) return
            setCheckDone(c)
          }
        } else if (step.kind === 'terminal') {
          if (reduced) {
            // No typewriter: command and result appear as a whole.
            setTyped(TERMINAL_CMD)
            const termReady = await wait(
              REDUCED_BEAT.termOut,
              isCancelled,
              isPaused
            )
            if (!termReady) return
            setTermOut(true)
          } else {
            if (!(await wait(BEAT.termLead, isCancelled, isPaused))) return
            for (let n = 1; n <= TERMINAL_CMD.length; n++) {
              if (!(await wait(BEAT.type, isCancelled, isPaused))) return
              setTyped(TERMINAL_CMD.slice(0, n))
            }
            if (!(await wait(BEAT.termOut, isCancelled, isPaused))) return
            setTermOut(true)
            if (!(await wait(BEAT.termTail, isCancelled, isPaused))) return
          }
        }
      }
      const settled = await wait(
        reduced ? REDUCED_BEAT.settle : BEAT.settle,
        isCancelled,
        isPaused
      )
      if (!settled) return
      setBusy(false)
      setShowReplay(true)
      // Reduced motion never auto-loops; the visitor replays on demand.
      if (reduced) return
      if (!(await wait(BEAT.loop, isCancelled, isPaused))) return
      setRunId((v) => v + 1)
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [runId])

  // Keep the newest step in view instead of clipping older ones off-screen.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [stage, checkDone, typed, termOut])

  // Pause the timeline while the demo is scrolled out of the viewport.
  useEffect(() => {
    const el = scrollRef.current?.closest('.gw-app-window') as HTMLElement | null
    if (!el || !('IntersectionObserver' in window)) return
    const io = new IntersectionObserver(
      ([entry]) => {
        visibleRef.current = entry.isIntersecting
      },
      { threshold: 0.05 }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const renderStep = (step: StepDef): ReactNode => {
    switch (step.kind) {
      case 'agent':
        return <p className='gw-app-msg gw-app-msg-agent'>{t(step.textKey!)}</p>
      case 'tool': {
        const Icon = step.icon === 'search' ? Search : Pencil
        return (
          <div className='gw-app-tool'>
            <Icon className='gw-app-tool-icon' aria-hidden='true' />
            <b>{t(step.labelKey!)}</b>
            <span className='gw-app-tool-meta'>
              {step.metaKey ? t(step.metaKey) : step.metaRaw}
            </span>
            {step.add ? <span className='gw-app-tool-add'>{step.add}</span> : null}
          </div>
        )
      }
      case 'checklist':
        return (
          <div className='gw-app-checklist'>
            {CHECK_KEYS.map((key, i) => (
              <div
                key={key}
                className={cn('gw-app-check', i < checkDone && 'gw-app-check-done')}
              >
                <span className='gw-app-checkbox'>
                  <Check className='gw-app-check-icon' aria-hidden='true' />
                </span>
                {t(key)}
              </div>
            ))}
          </div>
        )
      case 'terminal':
        return (
          <div className='gw-app-term'>
            <div>
              <span className='gw-app-term-prompt'>gwork@desktop $ </span>
              <span
                className={cn(
                  'gw-app-term-cmd',
                  typed.length < TERMINAL_CMD.length && 'gw-app-caret'
                )}
              >
                {typed}
              </span>
            </div>
            {termOut ? (
              <div className='gw-app-term-out'>
                <span className='gw-app-term-ok'>✓</span> {t('Syntax check passed')}
              </div>
            ) : null}
          </div>
        )
      case 'done':
        return (
          <div className='gw-app-done'>
            <CircleCheck className='gw-app-done-icon' aria-hidden='true' />
            {t('Task complete')}
            <span className='gw-app-elapsed'>{t('2 min 41 s')}</span>
          </div>
        )
      default:
        return null
    }
  }

  return (
    <div className={cn('gw-app-visual', props.className)}>
      <div className='gw-app-window' aria-label={t('GWork product demo')}>
        <div className='gw-app-winbar'>
          <div className='gw-app-dots' aria-hidden='true'>
            <span />
            <span />
            <span />
          </div>
          <div className='gw-app-wintitle'>
            {t('GWork — Homepage visual rebuild')}
          </div>
          <div className={cn('gw-app-winstatus', busy && 'gw-app-winstatus-busy')}>
            <span className='gw-app-statusdot' />
            {busy ? t('Running') : t('Completed')}
          </div>
        </div>

        <div className='gw-app-body'>
          <aside className='gw-app-side'>
            <div className='gw-app-side-actions'>
              <div className='gw-app-side-action'>
                <Plus className='gw-app-side-icon' aria-hidden='true' />
                {t('New task')}
              </div>
              <div className='gw-app-side-action'>
                <FolderOpen className='gw-app-side-icon' aria-hidden='true' />
                {t('Open workspace')}
              </div>
            </div>
            <div className='gw-app-side-label'>{t('Tasks')}</div>
            <ul className='gw-app-tasklist'>
              {TASK_KEYS.map((key, i) => (
                <li
                  key={key}
                  className={cn('gw-app-task', i === 0 && 'gw-app-task-active')}
                >
                  <span className='gw-app-taskdot' />
                  <span>{t(key)}</span>
                </li>
              ))}
            </ul>
            <div className='gw-app-side-user'>
              <span className='gw-app-avatar'>G</span>
              <span>{t('GWork user')}</span>
            </div>
          </aside>

          <div className='gw-app-main'>
            <div className='gw-app-chat' ref={scrollRef}>
              <div className='gw-app-msg gw-app-msg-user'>
                {t(
                  'Help me rebuild the homepage in a dark tech style and highlight multi-platform downloads.'
                )}
              </div>
              {STEPS.slice(0, stage).map((step, i) => (
                <div className='gw-app-step' key={`${runId}-${i}`}>
                  {renderStep(step)}
                </div>
              ))}
            </div>

            <div className='gw-app-input' aria-hidden='true'>
              <span className='gw-app-input-ph'>{t('Describe your next task…')}</span>
              <span className='gw-app-input-chip'>
                <span className='gw-app-statusdot' />
                {t('Model · Auto')}
              </span>
              <span className='gw-app-send'>
                <ArrowUp className='gw-app-send-icon' aria-hidden='true' />
              </span>
            </div>

            <button
              type='button'
              className={cn('gw-app-replay', showReplay && 'gw-app-replay-show')}
              onClick={() => setRunId((v) => v + 1)}
            >
              <RotateCcw className='gw-app-replay-icon' aria-hidden='true' />
              {t('Replay')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
