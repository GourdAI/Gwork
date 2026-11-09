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
 * Home page content constants.
 * The visual theme stays on new-api's own CSS variables; these entries only
 * describe the GWork desktop client narrative shown on the landing page.
 */
import { type TFunction } from 'i18next'

export const MAIN_BASE_CLASSES = 'bg-background text-foreground w-full'

// Model providers highlighted in the hero marquee.
export const AI_MODELS = [
  'OpenAI',
  'Claude',
  'Gemini',
  'DeepSeek',
  'Qwen',
  'Ollama',
] as const

// Product capabilities, mirroring the Java-era website's feature grid.
export const DEFAULT_FEATURES = [
  {
    title: 'Agent Orchestration',
    description:
      'Break complex goals into steps, delegate to sub-agents, and review every action',
    iconName: 'Workflow',
  },
  {
    title: 'Skills & Plugin Market',
    description:
      'Install community skills in one click and plug in MCP tools on demand',
    iconName: 'Blocks',
  },
  {
    title: 'Unified Model Access',
    description:
      'Switch between OpenAI, Claude, Gemini, DeepSeek and local Ollama in one place',
    iconName: 'Boxes',
  },
  {
    title: 'Built-in Coding Workspace',
    description:
      'Edit files, review diffs and run commands while the AI works in your project',
    iconName: 'Code',
  },
  {
    title: 'Local-first Data',
    description:
      'Workspaces and conversations stay in a local folder; keys never leave your machine',
    iconName: 'Shield',
  },
  {
    title: 'Cross-platform',
    description:
      'Windows, macOS and Linux from one codebase, with the same experience everywhere',
    iconName: 'MonitorSmartphone',
  },
] as const

// Default statistics shown in the counter strip.
export const DEFAULT_STATS = [
  { value: '3', suffix: '', description: 'desktop platforms supported' },
  { value: '6', suffix: '+', description: 'model providers ready to connect' },
  { value: '100', suffix: '%', description: 'local workspace ownership' },
  { value: '0', suffix: '', description: 'cloud storage required' },
] as const

export function getDefaultStats(t: TFunction) {
  return DEFAULT_STATS.map((stat) => ({
    ...stat,
    description: stat.description ? t(stat.description) : undefined,
  }))
}

export function getDefaultFeatures(t: TFunction) {
  return DEFAULT_FEATURES.map((feature) => ({
    ...feature,
    title: t(feature.title),
    description: t(feature.description),
  }))
}

// Download matrix: each row is matched against the manifest by {os, arch, kind}.
export interface DownloadSlot {
  os: string
  arch: string
  kind: string
  labelKey: string
}

export interface DownloadPlatform {
  id: string
  titleKey: string
  icon: 'windows' | 'apple' | 'linux'
  slots: DownloadSlot[]
}

export const DOWNLOAD_PLATFORMS: DownloadPlatform[] = [
  {
    id: 'windows',
    titleKey: 'Windows',
    icon: 'windows',
    slots: [
      { os: 'windows', arch: 'x64', kind: 'exe', labelKey: 'Windows x64 installer' },
      { os: 'windows', arch: 'x64', kind: 'msi', labelKey: 'Windows x64 MSI' },
      { os: 'windows', arch: 'arm64', kind: 'exe', labelKey: 'Windows arm64 installer' },
    ],
  },
  {
    id: 'macos',
    titleKey: 'macOS',
    icon: 'apple',
    slots: [
      { os: 'macos', arch: 'arm64', kind: 'dmg', labelKey: 'macOS Apple Silicon' },
      { os: 'macos', arch: 'x64', kind: 'dmg', labelKey: 'macOS Intel' },
      { os: 'macos', arch: 'arm64', kind: 'zip', labelKey: 'macOS archive' },
    ],
  },
  {
    id: 'linux',
    titleKey: 'Linux',
    icon: 'linux',
    slots: [
      { os: 'linux', arch: 'x64', kind: 'appimage', labelKey: 'Linux AppImage' },
      { os: 'linux', arch: 'x64', kind: 'deb', labelKey: 'Linux deb' },
      { os: 'linux', arch: 'arm64', kind: 'appimage', labelKey: 'Linux arm64 AppImage' },
    ],
  },
]
