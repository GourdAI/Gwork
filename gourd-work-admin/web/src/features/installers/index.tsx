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
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SectionPageLayout } from '@/components/layout'
import { Button } from '@/components/ui/button'

import type { Installer } from './types'
import { InstallerDeleteDialog } from './components/installer-delete-dialog'
import { InstallerEditDialog } from './components/installer-edit-dialog'
import { InstallerUploadDialog } from './components/installer-upload-dialog'
import { InstallersTable } from './components/installers-table'

export function Installers() {
  const { t } = useTranslation()
  const [uploadOpen, setUploadOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Installer | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Installer | null>(null)

  return (
    <>
      <SectionPageLayout fixedContent>
        <SectionPageLayout.Title>{t('Installers')}</SectionPageLayout.Title>
        <SectionPageLayout.Actions>
          <Button size='sm' onClick={() => setUploadOpen(true)}>
            <Plus aria-hidden='true' />
            {t('Upload installer')}
          </Button>
        </SectionPageLayout.Actions>
        <SectionPageLayout.Content>
          <InstallersTable
            onEdit={setEditTarget}
            onDelete={setDeleteTarget}
            onUpload={() => setUploadOpen(true)}
          />
        </SectionPageLayout.Content>
      </SectionPageLayout>

      <InstallerUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
      />
      <InstallerEditDialog
        installer={editTarget}
        onOpenChange={(open) => !open && setEditTarget(null)}
      />
      <InstallerDeleteDialog
        installer={deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      />
    </>
  )
}
