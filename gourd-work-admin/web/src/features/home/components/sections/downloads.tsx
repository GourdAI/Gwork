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
import { useQuery } from '@tanstack/react-query'
import { Download, Laptop, Monitor, Terminal, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { getInstallerManifest } from '../../api'
import type {
  InstallerManifestFile,
  InstallerManifestResponse,
} from '../../types'

interface DownloadsProps {
  className?: string
}

type ManifestStatus = 'loading' | 'ready' | 'empty' | 'error'

interface ManifestMatch {
  os: string
  arch: string
  kind: string
}

interface DownloadRowDefinition {
  id: string
  label: ReactNode
  format: string
  match: ManifestMatch
}

interface DownloadPlatformDefinition {
  id: string
  label: ReactNode
  icon: LucideIcon
  rows: DownloadRowDefinition[]
}

/** Guaranteed first render so the section never flashes an empty layout. */
const EMPTY_MANIFEST: InstallerManifestResponse = {
  success: true,
  data: { version: '', pub_date: '', files: [] },
}

/** Display mapping mirrors the Java site: platform -> {os, arch, kind} rows. */
function useDownloadPlatforms(): DownloadPlatformDefinition[] {
  const { t } = useTranslation()

  return [
    {
      id: 'windows',
      label: t('Windows'),
      icon: Monitor,
      rows: [
        {
          id: 'windows-x64-exe',
          label: t('Windows (64-bit)'),
          format: '.exe',
          match: { os: 'windows', arch: 'x64', kind: 'exe' },
        },
      ],
    },
    {
      id: 'macos',
      label: t('macOS'),
      icon: Laptop,
      rows: [
        {
          id: 'macos-arm64-dmg',
          label: t('macOS (Apple silicon)'),
          format: '.dmg',
          match: { os: 'macos', arch: 'arm64', kind: 'dmg' },
        },
        {
          id: 'macos-x64-dmg',
          label: t('macOS (Intel)'),
          format: '.dmg',
          match: { os: 'macos', arch: 'x64', kind: 'dmg' },
        },
      ],
    },
    {
      id: 'linux',
      label: t('Linux'),
      icon: Terminal,
      rows: [
        {
          id: 'linux-x64-appimage',
          label: t('Linux x64 (portable)'),
          format: '.AppImage',
          match: { os: 'linux', arch: 'x64', kind: 'appimage' },
        },
        {
          id: 'linux-x64-deb',
          label: t('Linux x64 (Debian/Ubuntu)'),
          format: '.deb',
          match: { os: 'linux', arch: 'x64', kind: 'deb' },
        },
      ],
    },
  ]
}

/** Only same-origin API paths become links; never a javascript: or remote URL. */
function isSafeDownloadUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/api/') &&
    !value.startsWith('//')
  )
}

function isManifestFile(value: unknown): value is InstallerManifestFile {
  if (typeof value !== 'object' || value === null) return false
  const file = value as Record<string, unknown>
  return (
    typeof file.os === 'string' &&
    typeof file.arch === 'string' &&
    typeof file.kind === 'string' &&
    isSafeDownloadUrl(file.url)
  )
}

/** Validate an untrusted public payload before any href is produced. */
function getManifestFiles(
  response: InstallerManifestResponse | undefined
): InstallerManifestFile[] {
  const rawFiles: unknown = response?.data?.files
  if (!Array.isArray(rawFiles)) return []
  return rawFiles.filter(isManifestFile)
}

function findFile(
  files: InstallerManifestFile[],
  match: ManifestMatch
): InstallerManifestFile | undefined {
  return files.find(
    (file) =>
      file.os === match.os &&
      file.arch === match.arch &&
      file.kind === match.kind
  )
}

/**
 * Platform table: a single ruled table with a labelled left column instead of
 * three floating cards. All manifest validation and link logic is unchanged.
 */
export function Downloads(props: DownloadsProps) {
  const { t } = useTranslation()
  const platforms = useDownloadPlatforms()

  const { data, isError, isPlaceholderData, refetch } = useQuery({
    queryKey: ['installer-manifest'],
    queryFn: getInstallerManifest,
    placeholderData: EMPTY_MANIFEST,
    retry: 1,
    meta: { errorToast: false },
  })

  const files = getManifestFiles(data)
  const rawFiles: unknown = data?.data?.files
  const hasValidManifest =
    data?.success === true && data.data != null && Array.isArray(rawFiles)

  const isFailed =
    isError || (data != null && !isPlaceholderData && !hasValidManifest)
  let status: ManifestStatus = 'ready'
  if (isFailed) {
    status = 'error'
  } else if (isPlaceholderData) {
    status = 'loading'
  } else if (files.length === 0) {
    status = 'empty'
  }

  const showLinks = !isFailed && !isPlaceholderData
  const availableFiles: InstallerManifestFile[] = showLinks ? files : []
  let disabledLabel = t('Coming soon')
  if (status === 'loading') disabledLabel = t('Loading...')
  if (status === 'error') disabledLabel = t('Unavailable')

  const rawVersion = showLinks ? data?.data?.version : undefined
  const version =
    typeof rawVersion === 'string' ? rawVersion.replace(/^v/i, '') : ''

  return (
    <section id='downloads' className={cn('gw-section gw-section--alt', props.className)}>
      <div className='gw-container'>
        <div className='gw-section-head'>
          <span className='gw-eyebrow'>{t('Multi-platform downloads')}</span>
          <h2 className='gw-h2'>{t('All downloads')}</h2>
          <p>{t('Every GWork installer, for all supported platforms.')}</p>
          {version !== '' ? (
            <span className='gw-release' style={{ marginTop: 16 }}>
              {t('Current version')} v{version}
            </span>
          ) : null}
        </div>

        <div aria-live='polite' className='gw-state-slot'>
          {status === 'loading' ? (
            <LoadingState inline message={t('Loading download list...')} />
          ) : null}
          {status === 'empty' ? (
            <EmptyState
              title={t('No installers are available yet.')}
              description={t(
                'Installers are being prepared. Check back soon, or refresh this page.'
              )}
              className='min-h-0 py-6'
            />
          ) : null}
          {status === 'error' ? (
            <ErrorState
              title={t('Download list is temporarily unavailable.')}
              description={t(
                'No download links are shown until the release list loads successfully.'
              )}
              onRetry={() => void refetch()}
              className='min-h-0 py-6'
            />
          ) : null}
        </div>

        <div className='gw-ptable'>
          {platforms.map((platform) => (
            <PlatformGroup
              key={platform.id}
              platform={platform}
              files={availableFiles}
              disabledLabel={disabledLabel}
            />
          ))}
        </div>

        <p className='gw-note'>
          {t(
            'Built-in auto-update keeps the app on the latest release after installation.'
          )}
        </p>
      </div>
    </section>
  )
}

interface PlatformGroupProps {
  platform: DownloadPlatformDefinition
  files: InstallerManifestFile[]
  disabledLabel: string
}

function PlatformGroup(props: PlatformGroupProps) {
  const PlatformIcon = props.platform.icon

  return (
    <div className='gw-pgroup'>
      <div className='gw-pgroup-name'>
        <PlatformIcon className='size-5' aria-hidden='true' />
        {props.platform.label}
      </div>
      <div className='gw-pgroup-rows'>
        {props.platform.rows.map((row) => (
          <DownloadRow
            key={row.id}
            row={row}
            file={findFile(props.files, row.match)}
            disabledLabel={props.disabledLabel}
          />
        ))}
      </div>
    </div>
  )
}

interface DownloadRowProps {
  row: DownloadRowDefinition
  file: InstallerManifestFile | undefined
  disabledLabel: string
}

function DownloadRow(props: DownloadRowProps) {
  const { t } = useTranslation()

  return (
    <div className='gw-prow'>
      <div className='gw-prow-info'>
        <span className='gw-prow-label'>{props.row.label}</span>
        <span className='gw-prow-format'>{props.row.format}</span>
      </div>
      {!props.file ? (
        <Button variant='outline' disabled className='gw-btn gw-btn-sm'>
          {props.disabledLabel}
        </Button>
      ) : (
        <Button
          variant='outline'
          className='gw-btn gw-btn-sm'
          render={<a href={props.file.url} target='_blank' rel='noopener' />}
        >
          {t('Download')}
          <Download className='ml-1.5 size-3.5' aria-hidden='true' />
        </Button>
      )}
    </div>
  )
}
