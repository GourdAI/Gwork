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
import { useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

interface CounterProps {
  end: number
  suffix?: string
  prefix?: string
  duration?: number
  decimals?: number
}

function Counter(props: CounterProps) {
  const suffix = props.suffix ?? ''
  const prefix = props.prefix ?? ''
  const duration = props.duration ?? 1600
  const decimals = props.decimals ?? 0
  const ref = useRef<HTMLSpanElement>(null)
  const startedRef = useRef(false)

  const formatValue = useCallback(
    (v: number) =>
      decimals > 0 ? v.toFixed(decimals) : Math.round(v).toLocaleString(),
    [decimals]
  )

  const animate = useCallback(() => {
    const el = ref.current
    if (!el) return
    const start = performance.now()
    const step = (now: number) => {
      const progress = Math.min((now - start) / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      el.textContent = `${prefix}${formatValue(eased * props.end)}${suffix}`
      if (progress < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }, [props.end, duration, prefix, suffix, formatValue])

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (mq.matches) {
      el.textContent = `${prefix}${formatValue(props.end)}${suffix}`
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !startedRef.current) {
          startedRef.current = true
          animate()
          observer.unobserve(el)
        }
      },
      { threshold: 0.5 }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [animate, props.end, prefix, suffix, formatValue])

  return (
    // Render the final value immediately. The observer only replays the count-up
    // animation when the strip scrolls into view — a static screenshot or a
    // reduced-motion user must never see a misleading "0".
    <span ref={ref} className='tabular-nums'>
      {prefix}{formatValue(props.end)}{suffix}
    </span>
  )
}

interface StatsProps {
  className?: string
}

interface StatItem {
  end: number
  suffix: string
  label: string
}

/** A bordered, left-aligned definition strip instead of floating counters. */
export function Stats(_props: StatsProps) {
  const { t } = useTranslation()

  const stats: StatItem[] = [
    { end: 3, suffix: '', label: t('Desktop platforms supported') },
    { end: 6, suffix: '', label: t('Built-in capabilities') },
    { end: 3, suffix: '', label: t('Steps to your first task') },
    { end: 100, suffix: '%', label: t('Local-first data ownership') },
  ]

  return (
    <section className='gw-section gw-section--alt'>
      <div className='gw-container'>
        <div className='gw-stats'>
          {stats.map((stat, index) => (
            <div key={stat.label} className='gw-stat'>
              <span className='gw-stat-key'>
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className='gw-stat-value'>
                <Counter end={stat.end} suffix={stat.suffix} />
              </span>
              <span className='gw-stat-label'>{stat.label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
