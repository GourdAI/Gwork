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
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Pencil, Trash2 } from 'lucide-react'
import { useCallback, useMemo } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import dayjs from '@/lib/dayjs'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'

import { updateInstaller } from '../api'
import {
  INSTALLER_ARCH_OPTIONS,
  INSTALLER_KIND_OPTIONS,
  INSTALLER_PLATFORM_OPTIONS,
  INSTALLERS_QUERY_KEY,
  formatInstallerSize,
  getInstallerOptionLabelKey,
} from '../constants'
import type { Installer } from '../types'

type UseInstallersColumnsOptions = {
  onEdit: (installer: Installer) => void
  onDelete: (installer: Installer) => void
}

function truncateSha256(value: string): string {
  if (value.length <= 16) return value
  return `${value.slice(0, 12)}…${value.slice(-4)}`
}

function formatCreatedAt(value: string): string {
  const parsed = dayjs(value)
  if (!parsed.isValid()) return value
  return parsed.format('YYYY-MM-DD HH:mm:ss')
}

/** Keep every label key visible to the i18n scanner as a `t('...')` literal. */
function useInstallerLabel(t: TFunction) {
  return useCallback(
    (labelKey: string): string => {
      if (labelKey === 'Windows') return t('Windows')
      if (labelKey === 'macOS') return t('macOS')
      if (labelKey === 'Linux') return t('Linux')
      if (labelKey === 'x64') return t('x64')
      if (labelKey === 'ARM64') return t('ARM64')
      if (labelKey === 'EXE installer') return t('EXE installer')
      if (labelKey === 'MSI installer') return t('MSI installer')
      if (labelKey === 'DMG image') return t('DMG image')
      if (labelKey === 'AppImage') return t('AppImage')
      if (labelKey === 'DEB package') return t('DEB package')
      if (labelKey === 'ZIP archive') return t('ZIP archive')
      return labelKey
    },
    [t]
  )
}

export function useInstallersColumns(
  props: UseInstallersColumnsOptions
): ColumnDef<Installer, unknown>[] {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const language = i18n.resolvedLanguage || i18n.language
  const locale = toIntlLocale(language)
  const translateLabel = useInstallerLabel(t)
  const onEdit = props.onEdit
  const onDelete = props.onDelete

  const enabledMutation = useMutation({
    mutationFn: (installer: Installer) =>
      updateInstaller(installer.id, { enabled: !installer.enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: INSTALLERS_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: ['installer-manifest'] })
      toast.success(t('Installer updated successfully'))
    },
    onError: (error) => {
      handleServerError(error, t('Failed to update installer'))
    },
  })
  const toggleEnabled = enabledMutation.mutate
  const isToggling = enabledMutation.isPending

  return useMemo<ColumnDef<Installer, unknown>[]>(
    () => [
      {
        accessorKey: 'version',
        header: t('Version'),
        cell: ({ row }) => (
          <span className='font-mono text-sm'>{row.original.version}</span>
        ),
        size: 110,
      },
      {
        accessorKey: 'platform',
        header: t('Platform'),
        cell: ({ row }) =>
          translateLabel(
            getInstallerOptionLabelKey(
              INSTALLER_PLATFORM_OPTIONS,
              row.original.platform
            )
          ),
        size: 100,
      },
      {
        accessorKey: 'arch',
        header: t('Architecture'),
        cell: ({ row }) =>
          translateLabel(
            getInstallerOptionLabelKey(
              INSTALLER_ARCH_OPTIONS,
              row.original.arch
            )
          ),
        size: 110,
      },
      {
        accessorKey: 'kind',
        header: t('Package type'),
        cell: ({ row }) =>
          translateLabel(
            getInstallerOptionLabelKey(
              INSTALLER_KIND_OPTIONS,
              row.original.kind
            )
          ),
        size: 120,
      },
      {
        accessorKey: 'file_name',
        header: t('File name'),
        cell: ({ row }) => (
          <span className='font-mono text-xs break-all'>
            {row.original.file_name}
          </span>
        ),
        size: 220,
        meta: { mobileTitle: true },
      },
      {
        accessorKey: 'size',
        header: t('Size'),
        cell: ({ row }) => formatInstallerSize(row.original.size, language),
        size: 110,
      },
      {
        accessorKey: 'sha256',
        header: t('SHA256'),
        cell: ({ row }) => (
          <div className='flex items-center gap-1'>
            <span className='font-mono text-xs' title={row.original.sha256}>
              {truncateSha256(row.original.sha256)}
            </span>
            <CopyButton
              value={row.original.sha256}
              size='icon'
              variant='ghost'
              aria-label={t('Copy SHA256')}
            />
          </div>
        ),
        size: 190,
      },
      {
        accessorKey: 'enabled',
        header: t('Enabled'),
        cell: ({ row }) => (
          <Switch
            checked={row.original.enabled}
            disabled={isToggling}
            aria-label={t('Toggle installer availability')}
            onCheckedChange={() => toggleEnabled(row.original)}
          />
        ),
        size: 90,
      },
      {
        accessorKey: 'download_count',
        header: t('Downloads'),
        cell: ({ row }) => formatNumber(row.original.download_count, locale),
        size: 100,
      },
      {
        accessorKey: 'created_at',
        header: t('Created at'),
        cell: ({ row }) => formatCreatedAt(row.original.created_at),
        size: 160,
      },
      {
        id: 'actions',
        header: t('Actions'),
        cell: ({ row }) => (
          <div className='flex items-center gap-1'>
            <Button
              variant='ghost'
              size='icon-sm'
              aria-label={t('Edit')}
              onClick={() => onEdit(row.original)}
            >
              <Pencil aria-hidden='true' />
            </Button>
            <Button
              variant='ghost'
              size='icon-sm'
              aria-label={t('Delete')}
              onClick={() => onDelete(row.original)}
            >
              <Trash2 aria-hidden='true' className='text-destructive' />
            </Button>
          </div>
        ),
        enableSorting: false,
        size: 100,
        meta: { pinned: 'right' as const },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      t,
      language,
      locale,
      translateLabel,
      toggleEnabled,
      isToggling,
      onEdit,
      onDelete,
    ]
  )
}
