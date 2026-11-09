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
import { FileArchive, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { FieldDescription, FieldError } from '@/components/ui/field'
import { cn } from '@/lib/utils'

import { formatInstallerSize } from '../constants'

type InstallerFilePickerProps = {
  fileName: string
  fileSize: number | null
  disabled?: boolean
  error?: string
  onSelect: (file: File) => void
  language?: string
}

/**
 * Binary installer drop zone. `PluginSourcePicker` cannot be reused: it reads
 * the file into a JS source string, hard-codes `.js`/8 MiB, and has no binary
 * `File` passthrough needed for 100 MB+ multipart uploads with progress.
 */
export function InstallerFilePicker(props: InstallerFilePickerProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragActive, setIsDragActive] = useState(false)

  const selectFile = (file?: File) => {
    if (!file || props.disabled) return
    props.onSelect(file)
  }

  return (
    <div>
      <div
        className={cn(
          'flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center transition-colors',
          isDragActive ? 'border-primary bg-primary/5' : 'bg-muted/20',
          props.disabled && 'pointer-events-none opacity-60',
          props.error && 'border-destructive'
        )}
        onDragOver={(event) => {
          event.preventDefault()
          if (!props.disabled) setIsDragActive(true)
        }}
        onDragLeave={() => setIsDragActive(false)}
        onDrop={(event) => {
          event.preventDefault()
          setIsDragActive(false)
          selectFile(event.dataTransfer.files[0])
        }}
      >
        {props.fileName ? (
          <FileArchive
            aria-hidden='true'
            className='text-muted-foreground size-5'
          />
        ) : (
          <Upload aria-hidden='true' className='text-muted-foreground size-5' />
        )}
        <div className='space-y-0.5'>
          <p className='text-sm font-medium'>
            {props.fileName || t('Drop an installer file here or choose one')}
          </p>
          <FieldDescription className='text-xs'>
            {t('The file extension must match the selected package type.')}
          </FieldDescription>
          {props.fileSize !== null ? (
            <FieldDescription className='text-xs'>
              {formatInstallerSize(props.fileSize, props.language)}
            </FieldDescription>
          ) : null}
        </div>
        <Button
          type='button'
          variant='outline'
          size='sm'
          disabled={props.disabled}
          onClick={() => inputRef.current?.click()}
        >
          {props.fileName ? t('Choose another file') : t('Choose file')}
        </Button>
        <input
          ref={inputRef}
          id='installer-upload-file'
          type='file'
          accept='.exe,.msi,.dmg,.AppImage,.deb,.zip'
          className='sr-only'
          disabled={props.disabled}
          aria-label={t('Installer file')}
          aria-invalid={props.error ? true : undefined}
          onChange={(event) => {
            selectFile(event.target.files?.[0])
            // Allow re-picking the same file after a failed upload.
            event.target.value = ''
          }}
        />
      </div>
      {props.error ? <FieldError role='alert'>{props.error}</FieldError> : null}
    </div>
  )
}
