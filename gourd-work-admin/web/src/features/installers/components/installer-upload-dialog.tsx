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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'

import { uploadInstaller } from '../api'
import {
  INSTALLER_ARCH_OPTIONS,
  INSTALLER_KIND_EXTENSIONS,
  INSTALLER_KIND_OPTIONS,
  INSTALLER_MAX_SIZE_MB,
  INSTALLER_PLATFORM_OPTIONS,
  INSTALLERS_QUERY_KEY,
  UPLOAD_FORM_DEFAULTS,
  isInstallerArch,
  isInstallerKind,
  isInstallerPlatform,
  validateUploadInstallerForm,
  type InstallerValidationKey,
  type UploadValidationErrors,
} from '../constants'
import { buildUploadInstallerFormData } from '../lib/installer-form'
import type { UploadInstallerFormValues } from '../types'
import { InstallerFilePicker } from './installer-file-picker'

type InstallerUploadDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function InstallerUploadDialog(props: InstallerUploadDialogProps) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const [values, setValues] = useState<UploadInstallerFormValues>({
    ...UPLOAD_FORM_DEFAULTS,
  })
  const [errors, setErrors] = useState<UploadValidationErrors>({})
  const [progress, setProgress] = useState(0)
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)

  const mutation = useMutation({
    mutationFn: () =>
      uploadInstaller(buildUploadInstallerFormData(values), setProgress),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: INSTALLERS_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: ['installer-manifest'] })
      toast.success(t('Installer uploaded successfully'))
      props.onOpenChange(false)
    },
    onError: (error) => {
      handleServerError(error, t('Failed to upload installer'))
    },
  })

  const { reset } = mutation

  useEffect(() => {
    if (props.open) return
    setValues({ ...UPLOAD_FORM_DEFAULTS })
    setErrors({})
    setProgress(0)
    reset()
  }, [props.open, reset])

  const updateValue = <K extends keyof UploadInstallerFormValues>(
    key: K,
    value: UploadInstallerFormValues[K]
  ) => {
    setValues((previous) => ({ ...previous, [key]: value }))
    setErrors((previous) => ({ ...previous, [key]: undefined }))
  }

  const translateValidationError = (key: InstallerValidationKey): string => {
    if (key === 'Installer file is required') return t('Installer file is required')
    if (key === 'Invalid installer version') return t('Invalid installer version')
    if (key === 'Invalid installer platform') return t('Invalid installer platform')
    if (key === 'Invalid installer architecture') {
      return t('Invalid installer architecture')
    }
    if (key === 'Invalid installer kind') return t('Invalid installer kind')
    if (key === 'Installer file extension does not match kind') {
      return t('Installer file extension does not match kind')
    }
    return t('Installer file exceeds size limit')
  }

  const handleSubmit = () => {
    if (mutation.isPending) return
    const nextErrors = validateUploadInstallerForm(values)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    setProgress(0)
    mutation.mutate()
  }

  const handleOpenChange = (open: boolean) => {
    if (!open && mutation.isPending) return
    props.onOpenChange(open)
  }

  const extensionHint = INSTALLER_KIND_EXTENSIONS[values.kind]
  const isPending = mutation.isPending
  const fileError = errors.file
    ? translateValidationError(errors.file)
    : undefined
  const versionError = errors.version
    ? translateValidationError(errors.version)
    : undefined
  const platformError = errors.platform
    ? translateValidationError(errors.platform)
    : undefined
  const archError = errors.arch
    ? translateValidationError(errors.arch)
    : undefined
  const kindError = errors.kind
    ? translateValidationError(errors.kind)
    : undefined

  return (
    <Dialog
      open={props.open}
      onOpenChange={handleOpenChange}
      showCloseButton={!isPending}
      contentClassName='sm:max-w-2xl'
      bodyClassName='space-y-4'
      title={t('Upload installer')}
      description={t(
        'Add a desktop installer package and publish it to the download page.'
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
        <Field data-invalid={fileError ? true : undefined}>
          <span className='text-sm font-medium'>{t('Installer file')}</span>
          <InstallerFilePicker
            fileName={values.file?.name ?? ''}
            fileSize={values.file?.size ?? null}
            disabled={isPending}
            error={fileError}
            language={i18n.resolvedLanguage || i18n.language}
            onSelect={(file) => updateValue('file', file)}
          />
        </Field>

        <div className='grid gap-4 sm:grid-cols-2'>
          <Field data-invalid={versionError ? true : undefined}>
            <FieldLabel htmlFor='installer-version'>{t('Version')}</FieldLabel>
            <Input
              id='installer-version'
              value={values.version}
              placeholder={t('e.g. 1.2.3')}
              disabled={isPending}
              aria-invalid={versionError ? true : undefined}
              onChange={(event) => updateValue('version', event.target.value)}
            />
            <FieldDescription>
              {t('Use a semantic version without a leading v.')}
            </FieldDescription>
            {versionError ? (
              <FieldError role='alert'>{versionError}</FieldError>
            ) : null}
          </Field>

          <Field data-invalid={kindError ? true : undefined}>
            <FieldLabel htmlFor='installer-kind'>
              {t('Package type')}
            </FieldLabel>
            <Select
              items={INSTALLER_KIND_OPTIONS.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
              value={values.kind}
              disabled={isPending}
              onValueChange={(value) => {
                if (typeof value === 'string' && isInstallerKind(value)) {
                  updateValue('kind', value)
                }
              }}
            >
              <SelectTrigger id='installer-kind' className='w-full'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {INSTALLER_KIND_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              {t('Expected file extension: {{extension}}', {
                extension: extensionHint,
              })}
            </FieldDescription>
            {kindError ? <FieldError role='alert'>{kindError}</FieldError> : null}
          </Field>

          <Field data-invalid={platformError ? true : undefined}>
            <FieldLabel htmlFor='installer-platform'>
              {t('Platform')}
            </FieldLabel>
            <Select
              items={INSTALLER_PLATFORM_OPTIONS.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
              value={values.platform}
              disabled={isPending}
              onValueChange={(value) => {
                if (typeof value === 'string' && isInstallerPlatform(value)) {
                  updateValue('platform', value)
                }
              }}
            >
              <SelectTrigger id='installer-platform' className='w-full'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {INSTALLER_PLATFORM_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {platformError ? (
              <FieldError role='alert'>{platformError}</FieldError>
            ) : null}
          </Field>

          <Field data-invalid={archError ? true : undefined}>
            <FieldLabel htmlFor='installer-arch'>
              {t('Architecture')}
            </FieldLabel>
            <Select
              items={INSTALLER_ARCH_OPTIONS.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
              value={values.arch}
              disabled={isPending}
              onValueChange={(value) => {
                if (typeof value === 'string' && isInstallerArch(value)) {
                  updateValue('arch', value)
                }
              }}
            >
              <SelectTrigger id='installer-arch' className='w-full'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {INSTALLER_ARCH_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {archError ? <FieldError role='alert'>{archError}</FieldError> : null}
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor='installer-release-notes'>
            {t('Release notes')}
          </FieldLabel>
          <Textarea
            id='installer-release-notes'
            value={values.release_notes}
            placeholder={t('Optional changes in this release')}
            rows={3}
            disabled={isPending}
            onChange={(event) =>
              updateValue('release_notes', event.target.value)
            }
          />
        </Field>

        <FieldDescription>
          {t('Maximum file size is {{size}} MB.', {
            size: formatNumber(INSTALLER_MAX_SIZE_MB, locale),
          })}
        </FieldDescription>

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
