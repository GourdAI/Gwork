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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { handleServerError } from '@/lib/handle-server-error'

import { updateInstaller } from '../api'
import {
  INSTALLER_ARCH_OPTIONS,
  INSTALLER_KIND_OPTIONS,
  INSTALLER_PLATFORM_OPTIONS,
  INSTALLERS_QUERY_KEY,
  isInstallerArch,
  isInstallerKind,
  isInstallerPlatform,
  toEditFormValues,
  validateEditInstallerForm,
  type EditValidationErrors,
  type InstallerValidationKey,
} from '../constants'
import type { EditInstallerFormValues, Installer } from '../types'

type InstallerEditDialogProps = {
  installer: Installer | null
  onOpenChange: (open: boolean) => void
}

export function InstallerEditDialog(props: InstallerEditDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [values, setValues] = useState<EditInstallerFormValues | null>(null)
  const [errors, setErrors] = useState<EditValidationErrors>({})

  const mutation = useMutation({
    mutationFn: () => {
      if (!props.installer || !values) {
        throw new Error(t('Invalid installer'))
      }
      return updateInstaller(props.installer.id, {
        version: values.version.trim(),
        platform: values.platform,
        arch: values.arch,
        kind: values.kind,
        release_notes: values.release_notes,
        enabled: values.enabled,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: INSTALLERS_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: ['installer-manifest'] })
      toast.success(t('Installer updated successfully'))
      props.onOpenChange(false)
    },
    onError: (error) => {
      handleServerError(error, t('Failed to update installer'))
    },
  })

  const { reset } = mutation

  useEffect(() => {
    if (!props.installer) {
      setValues(null)
      setErrors({})
      return
    }
    setValues(toEditFormValues(props.installer))
    setErrors({})
    reset()
  }, [props.installer, reset])

  const updateValue = <K extends keyof EditInstallerFormValues>(
    key: K,
    value: EditInstallerFormValues[K]
  ) => {
    setValues((previous) =>
      previous ? { ...previous, [key]: value } : previous
    )
    setErrors((previous) => ({ ...previous, [key]: undefined }))
  }

  const translateValidationError = (key: InstallerValidationKey): string => {
    if (key === 'Invalid installer version') return t('Invalid installer version')
    if (key === 'Invalid installer platform') return t('Invalid installer platform')
    if (key === 'Invalid installer architecture') {
      return t('Invalid installer architecture')
    }
    if (key === 'Invalid installer kind') return t('Invalid installer kind')
    return t('Installer file extension does not match kind')
  }

  const handleSubmit = () => {
    if (!values || mutation.isPending) return
    const nextErrors = validateEditInstallerForm(values)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    mutation.mutate()
  }

  const handleOpenChange = (open: boolean) => {
    if (!open && mutation.isPending) return
    props.onOpenChange(open)
  }

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
      open={props.installer !== null && values !== null}
      onOpenChange={handleOpenChange}
      showCloseButton={!mutation.isPending}
      contentClassName='sm:max-w-2xl'
      bodyClassName='space-y-4'
      title={t('Edit installer')}
      description={t('Update the metadata and availability of this installer.')}
      footer={
        <>
          <Button
            variant='outline'
            disabled={mutation.isPending}
            onClick={() => handleOpenChange(false)}
          >
            {t('Cancel')}
          </Button>
          <Button disabled={mutation.isPending} onClick={handleSubmit}>
            {mutation.isPending ? t('Saving...') : t('Save changes')}
          </Button>
        </>
      }
    >
      {values ? (
        <FieldGroup>
          <div className='grid gap-4 sm:grid-cols-2'>
            <Field data-invalid={versionError ? true : undefined}>
              <FieldLabel htmlFor='installer-edit-version'>
                {t('Version')}
              </FieldLabel>
              <Input
                id='installer-edit-version'
                value={values.version}
                disabled={mutation.isPending}
                aria-invalid={versionError ? true : undefined}
                onChange={(event) => updateValue('version', event.target.value)}
              />
              {versionError ? (
                <FieldError role='alert'>{versionError}</FieldError>
              ) : null}
            </Field>

            <Field data-invalid={kindError ? true : undefined}>
              <FieldLabel htmlFor='installer-edit-kind'>
                {t('Package type')}
              </FieldLabel>
              <Select
                items={INSTALLER_KIND_OPTIONS.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey),
                }))}
                value={values.kind}
                disabled={mutation.isPending}
                onValueChange={(value) => {
                  if (typeof value === 'string' && isInstallerKind(value)) {
                    updateValue('kind', value)
                  }
                }}
              >
                <SelectTrigger id='installer-edit-kind' className='w-full'>
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
              {kindError ? <FieldError role='alert'>{kindError}</FieldError> : null}
            </Field>

            <Field data-invalid={platformError ? true : undefined}>
              <FieldLabel htmlFor='installer-edit-platform'>
                {t('Platform')}
              </FieldLabel>
              <Select
                items={INSTALLER_PLATFORM_OPTIONS.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey),
                }))}
                value={values.platform}
                disabled={mutation.isPending}
                onValueChange={(value) => {
                  if (typeof value === 'string' && isInstallerPlatform(value)) {
                    updateValue('platform', value)
                  }
                }}
              >
                <SelectTrigger id='installer-edit-platform' className='w-full'>
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
              <FieldLabel htmlFor='installer-edit-arch'>
                {t('Architecture')}
              </FieldLabel>
              <Select
                items={INSTALLER_ARCH_OPTIONS.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey),
                }))}
                value={values.arch}
                disabled={mutation.isPending}
                onValueChange={(value) => {
                  if (typeof value === 'string' && isInstallerArch(value)) {
                    updateValue('arch', value)
                  }
                }}
              >
                <SelectTrigger id='installer-edit-arch' className='w-full'>
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
            <FieldLabel htmlFor='installer-edit-release-notes'>
              {t('Release notes')}
            </FieldLabel>
            <Textarea
              id='installer-edit-release-notes'
              value={values.release_notes}
              rows={3}
              disabled={mutation.isPending}
              onChange={(event) =>
                updateValue('release_notes', event.target.value)
              }
            />
          </Field>

          <Field orientation='horizontal'>
            <div className='flex items-center justify-between gap-4'>
              <div>
                <FieldLabel htmlFor='installer-edit-enabled'>
                  {t('Enabled')}
                </FieldLabel>
                <FieldDescription>
                  {t('Include this installer in the public download manifest.')}
                </FieldDescription>
              </div>
              <Switch
                id='installer-edit-enabled'
                checked={values.enabled}
                disabled={mutation.isPending}
                onCheckedChange={(checked) => updateValue('enabled', checked)}
              />
            </div>
          </Field>

          {mutation.error ? (
            <FieldError role='alert'>{mutation.error.message}</FieldError>
          ) : null}
        </FieldGroup>
      ) : null}
    </Dialog>
  )
}
