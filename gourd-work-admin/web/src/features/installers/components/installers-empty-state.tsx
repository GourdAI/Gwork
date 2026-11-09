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
import { PackageOpen, Upload } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'

type InstallersEmptyStateProps = {
  onUpload: () => void
  actionLabel?: ReactNode
}

/**
 * Explicit empty-state surface for the installers page. `DataTablePage` owns
 * the in-table empty state; this component is used when the page is rendered
 * without a table (e.g. before the query resolves).
 */
export function InstallersEmptyState(props: InstallersEmptyStateProps) {
  const { t } = useTranslation()
  return (
    <EmptyState
      icon={PackageOpen}
      title={t('No installers yet')}
      description={t(
        'Upload a Windows, macOS or Linux installer to publish it on the download page.'
      )}
      action={
        <Button size='sm' onClick={props.onUpload}>
          <Upload aria-hidden='true' />
          {props.actionLabel ?? t('Upload installer')}
        </Button>
      }
    />
  )
}
