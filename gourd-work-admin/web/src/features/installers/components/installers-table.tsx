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
import type { PaginationState } from '@tanstack/react-table'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DataTablePage, useDataTable } from '@/components/data-table'
import { Button } from '@/components/ui/button'
import { requireServerSuccess } from '@/lib/server-error-message'

import { getInstallers } from '../api'
import { INSTALLERS_QUERY_KEY } from '../constants'
import type { Installer } from '../types'
import { useInstallersColumns } from './installers-columns'

type InstallersTableProps = {
  onEdit: (installer: Installer) => void
  onDelete: (installer: Installer) => void
  onUpload: () => void
}

export function InstallersTable(props: InstallersTableProps) {
  const { t } = useTranslation()
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  })
  const columns = useInstallersColumns({
    onEdit: props.onEdit,
    onDelete: props.onDelete,
  })

  const queryKey = [
    ...INSTALLERS_QUERY_KEY,
    'list',
    pagination.pageIndex + 1,
    pagination.pageSize,
  ] as const

  const { data, isLoading, isFetching } = useQuery({
    queryKey,
    queryFn: async () => {
      const response = requireServerSuccess(
        await getInstallers({
          // Contract §3.1 names `page`; the Go helper also reads `p`.
          // Sending both keeps older/newer backends in sync.
          page: pagination.pageIndex + 1,
          p: pagination.pageIndex + 1,
          page_size: pagination.pageSize,
        })
      )
      return {
        items: response.data?.items ?? [],
        total: response.data?.total ?? 0,
      }
    },
    placeholderData: (previousData) => previousData,
  })

  const ensurePageInRange = useCallback(
    (pageCount: number) => {
      if (pageCount > 0 && pagination.pageIndex > pageCount - 1) {
        setPagination((previous) => ({ ...previous, pageIndex: pageCount - 1 }))
      }
    },
    [pagination.pageIndex]
  )

  const { table } = useDataTable({
    data: data?.items ?? [],
    columns,
    getRowId: (row) => String(row.id),
    pagination,
    onPaginationChange: setPagination,
    manualPagination: true,
    totalCount: data?.total ?? 0,
    ensurePageInRange,
  })

  return (
    <DataTablePage
      table={table}
      columns={columns}
      isLoading={isLoading}
      isFetching={isFetching}
      emptyTitle={t('No installers yet')}
      emptyDescription={t(
        'Upload a Windows, macOS or Linux installer to publish it on the download page.'
      )}
      emptyAction={
        <Button variant='link' size='sm' onClick={props.onUpload}>
          {t('Upload installer')}
        </Button>
      }
      skeletonKeyPrefix='installers-skeleton'
      applyHeaderSize
      toolbarProps={null}
    />
  )
}
