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
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { handleServerError } from '@/lib/handle-server-error'

import { deleteInstaller } from '../api'
import { INSTALLERS_QUERY_KEY } from '../constants'
import type { Installer } from '../types'

type InstallerDeleteDialogProps = {
  installer: Installer | null
  onOpenChange: (open: boolean) => void
}

export function InstallerDeleteDialog(props: InstallerDeleteDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: (id: number) => deleteInstaller(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: INSTALLERS_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: ['installer-manifest'] })
      toast.success(t('Installer deleted successfully'))
      props.onOpenChange(false)
    },
    onError: (error) => {
      handleServerError(error, t('Failed to delete installer'))
    },
  })

  const handleConfirm = () => {
    if (!props.installer || mutation.isPending) return
    mutation.mutate(props.installer.id)
  }

  return (
    <ConfirmDialog
      open={props.installer !== null}
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) props.onOpenChange(false)
      }}
      title={t('Delete installer?')}
      desc={t(
        'This permanently removes the installer record and its stored file. This action cannot be undone.'
      )}
      confirmText={
        mutation.isPending ? t('Deleting...') : t('Delete')
      }
      destructive
      isLoading={mutation.isPending}
      handleConfirm={handleConfirm}
    />
  )
}
