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
import { Download, KeyRound, Sparkles, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

interface HowItWorksProps {
  className?: string
}

interface StepDefinition {
  num: string
  title: ReactNode
  desc: ReactNode
  icon: LucideIcon
}

/** Three quick-start steps, each translated with a literal source key. */
function useSteps(): StepDefinition[] {
  const { t } = useTranslation()

  return [
    {
      num: '1',
      title: t('Download and install'),
      desc: t(
        'Pick the installer for your platform, run it, and start GWork in about a minute.'
      ),
      icon: Download,
    },
    {
      num: '2',
      title: t('Connect a model'),
      desc: t(
        'Add an API key from any provider, or connect a local Ollama instance. The interface follows your system language.'
      ),
      icon: KeyRound,
    },
    {
      num: '3',
      title: t('Start your first task'),
      desc: t(
        'Describe the goal in one sentence. Agents plan, execute and report back, so you only review and confirm.'
      ),
      icon: Sparkles,
    },
  ]
}

/** Numbered vertical timeline with a connecting rail. */
export function HowItWorks(_props: HowItWorksProps) {
  const { t } = useTranslation()
  const steps = useSteps()

  return (
    <section id='quickstart' className='gw-section gw-section--alt'>
      <div className='gw-container'>
        <div className='gw-section-head'>
          <span className='gw-eyebrow'>{t('Quick start')}</span>
          <h2 className='gw-h2'>{t('Three steps to your first task')}</h2>
        </div>

        <ol className='gw-timeline'>
          {steps.map((step) => (
            <StepItem key={step.num} step={step} />
          ))}
        </ol>
      </div>
    </section>
  )
}

function StepItem(props: { step: StepDefinition }) {
  const Icon = props.step.icon

  return (
    <li className='gw-step'>
      <span className='gw-step-num'>{props.step.num}</span>
      <div className='gw-step-body'>
        <h3 className='gw-step-title'>
          <Icon className='size-4' strokeWidth={1.75} aria-hidden='true' />
          {props.step.title}
        </h3>
        <p className='gw-step-desc'>{props.step.desc}</p>
      </div>
    </li>
  )
}
