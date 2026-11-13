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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { handleServerError } from '@/lib/handle-server-error'

import { getInstallerLatestInfo, uploadInstallerLatest } from '../api'
import {
  INSTALLERS_QUERY_KEY,
  INSTALLER_LATEST_QUERY_KEY,
  formatInstallerSize,
} from '../constants'

type InstallerLatestUploadDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function InstallerLatestUploadDialog(
  props: InstallerLatestUploadDialogProps
) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: current } = useQuery({
    queryKey: INSTALLER_LATEST_QUERY_KEY,
    queryFn: getInstallerLatestInfo,
    enabled: props.open,
  })
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [progress, setProgress] = useState(0)

  const mutation = useMutation({
    mutationFn: (selected: File) => uploadInstallerLatest(selected, setProgress),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: INSTALLERS_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: INSTALLER_LATEST_QUERY_KEY })
      toast.success(t('Update check file uploaded successfully'))
      props.onOpenChange(false)
    },
    onError: (err) => {
      handleServerError(err, t('Failed to upload update check file'))
    },
  })

  const { reset } = mutation

  useEffect(() => {
    if (props.open) return
    setFile(null)
    setError(undefined)
    setProgress(0)
    reset()
  }, [props.open, reset])

  const selectFile = (selected?: File) => {
    setFile(null)
    setError(undefined)
    if (!selected || !selected.name.toLowerCase().endsWith('.json')) {
      setError(t('Invalid update check file'))
      return
    }
    setFile(selected)
  }

  const handleSubmit = () => {
    if (mutation.isPending) return
    if (!file || !file.name.toLowerCase().endsWith('.json')) {
      setError(t('Invalid update check file'))
      return
    }
    setError(undefined)
    setProgress(0)
    mutation.mutate(file)
  }

  const handleOpenChange = (open: boolean) => {
    if (!open && mutation.isPending) return
    props.onOpenChange(open)
  }

  const isPending = mutation.isPending

  return (
    <Dialog
      open={props.open}
      onOpenChange={handleOpenChange}
      showCloseButton={!isPending}
      contentClassName='sm:max-w-xl'
      bodyClassName='space-y-4'
      title={t('Upload update check file')}
      description={t(
        'Select a latest.json file to publish to the desktop updater.'
      )}
      footer={
        <>
          <Button
            variant='outline'
            disabled={isPending}
            onClick={() => handleOpenChange(false)}
          >
            {t('Cancel')}
          </Button>
          <Button disabled={isPending} onClick={handleSubmit}>
            <Upload aria-hidden='true' />
            {isPending ? t('Uploading...') : t('Upload')}
          </Button>
        </>
      }
    >
      <FieldGroup>
        <div className='bg-muted/40 space-y-1 rounded-md border p-3 text-sm'>
          <p className='font-medium'>{t('Current update manifest')}</p>
          {current ? (
            <>
              <p>
                {t('Current version')}: {current.version}
              </p>
              <p className='text-muted-foreground break-all'>
                {t('Public feed URL')}: {window.location.origin}
                {current.url}
              </p>
              <p className='text-muted-foreground'>
                {current.platforms.join(', ')} ·{' '}
                {formatInstallerSize(current.size)}
              </p>
            </>
          ) : (
            <p className='text-muted-foreground'>
              {t('No latest.json has been uploaded yet.')}
            </p>
          )}
        </div>

        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor='installer-latest-file'>
            {t('Update check file')}
          </FieldLabel>
          <Input
            id='installer-latest-file'
            type='file'
            accept='.json,application/json'
            disabled={isPending}
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              selectFile(event.target.files?.[0])
              // Allow re-picking the same file after a failed upload.
              event.target.value = ''
            }}
          />
          <FieldDescription>{t('Choose file')}</FieldDescription>
          {error ? <FieldError role='alert'>{error}</FieldError> : null}
        </Field>

        {isPending ? (
          <div className='space-y-2'>
            <div className='text-muted-foreground flex items-center justify-between text-xs'>
              <span>{t('Uploading...')}</span>
              <span className='tabular-nums'>
                {t('{{percent}}% uploaded', { percent: progress })}
              </span>
            </div>
            <Progress value={progress} aria-label={t('Upload progress')} />
          </div>
        ) : null}

        {mutation.error ? (
          <FieldError role='alert'>{mutation.error.message}</FieldError>
        ) : null}
      </FieldGroup>
    </Dialog>
  )
}
