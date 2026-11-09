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
  Blocks,
  Code2,
  HardDrive,
  Layers3,
  ListChecks,
  Monitor,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

interface FeaturesProps {
  className?: string
}

interface FeatureDefinition {
  id: string
  num: string
  title: ReactNode
  desc: ReactNode
  icon: LucideIcon
}

/** Six product capability rows, each translated with a literal source key. */
function useFeatureDefinitions(): FeatureDefinition[] {
  const { t } = useTranslation()

  return [
    {
      id: 'agents',
      num: '01',
      title: t('Agent task orchestration'),
      desc: t(
        'Break a complex goal into a visible multi-step plan, let sub-agents collaborate, and review or take over at any point.'
      ),
      icon: ListChecks,
    },
    {
      id: 'skills',
      num: '02',
      title: t('Skills and plugin marketplace'),
      desc: t(
        'Install community skills in one click and plug in MCP tools so the workspace keeps growing with you.'
      ),
      icon: Blocks,
    },
    {
      id: 'models',
      num: '03',
      title: t('Unified access to many models'),
      desc: t(
        'Connect OpenAI, Claude, Gemini, DeepSeek and local Ollama in one interface, and switch models at any time.'
      ),
      icon: Layers3,
    },
    {
      id: 'coding',
      num: '04',
      title: t('Built-in coding workspace'),
      desc: t(
        'A Monaco editor, Git diff view and integrated terminal let AI read, write and verify changes inside your project.'
      ),
      icon: Code2,
    },
    {
      id: 'local',
      num: '05',
      title: t('Local-first, your data stays yours'),
      desc: t(
        'Workspaces and conversations live in the local .gwork folder. Keys never leave your machine and self-hosting is fully supported.'
      ),
      icon: HardDrive,
    },
    {
      id: 'cross-platform',
      num: '06',
      title: t('Consistent cross-platform experience'),
      desc: t(
        'Windows, macOS and Linux share the same build, so the interface and capabilities stay consistent across devices.'
      ),
      icon: Monitor,
    },
  ]
}

/**
 * Specification-table layout: numbered rows in a single ruled container,
 * replacing the generic three-column card grid.
 */
export function Features(_props: FeaturesProps) {
  const { t } = useTranslation()
  const features = useFeatureDefinitions()

  return (
    <section id='features' className='gw-section'>
      <div className='gw-container'>
        <div className='gw-section-head'>
          <span className='gw-eyebrow'>{t('Product capabilities')}</span>
          <h2 className='gw-h2'>{t('Stay at the forefront')}</h2>
          <p>
            {t(
              'Whether you write code, draft documents or run automation, GWork puts AI to work in your daily workflow.'
            )}
          </p>
        </div>

        <div className='gw-spec'>
          {features.map((feature) => (
            <SpecRow key={feature.id} feature={feature} />
          ))}
        </div>
      </div>
    </section>
  )
}

function SpecRow(props: { feature: FeatureDefinition }) {
  const Icon = props.feature.icon
  const hasModelChips = props.feature.id === 'models'

  return (
    <div className='gw-spec-row'>
      <span className='gw-spec-num'>{props.feature.num}</span>
      <span className='gw-spec-title'>{props.feature.title}</span>
      <div className='gw-spec-desc'>
        {props.feature.desc}
        {hasModelChips ? <ModelChips /> : null}
      </div>
      <span className='gw-spec-icon'>
        <Icon className='size-4' aria-hidden='true' />
      </span>
    </div>
  )
}

const MODEL_NAMES = [
  'OpenAI',
  'Claude',
  'Gemini',
  'DeepSeek',
  'Ollama',
  'Qwen',
] as const

function ModelChips() {
  return (
    <div className='gw-spec-models'>
      {MODEL_NAMES.map((model) => (
        <span key={model}>{model}</span>
      ))}
    </div>
  )
}
