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
import type { AxiosProgressEvent } from 'axios'

import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'

import type {
  EditInstallerFormValues,
  Installer,
  InstallerArch,
  InstallerKind,
  InstallerPlatform,
  UploadInstallerFormValues,
} from './types'

type Option<TValue extends string> = {
  value: TValue
  labelKey: string
}

/** English literals are i18n keys; components render them via `t(key)`. */
export type InstallerValidationKey =
  | 'Installer file is required'
  | 'Invalid installer version'
  | 'Invalid installer platform'
  | 'Invalid installer architecture'
  | 'Invalid installer kind'
  | 'Installer file extension does not match kind'
  | 'Installer file exceeds size limit'

export const INSTALLER_PLATFORM_OPTIONS: Option<InstallerPlatform>[] = [
  { value: 'windows', labelKey: 'Windows' },
  { value: 'macos', labelKey: 'macOS' },
  { value: 'linux', labelKey: 'Linux' },
]

export const INSTALLER_ARCH_OPTIONS: Option<InstallerArch>[] = [
  { value: 'x64', labelKey: 'x64' },
  { value: 'arm64', labelKey: 'ARM64' },
]

export const INSTALLER_KIND_OPTIONS: Option<InstallerKind>[] = [
  { value: 'exe', labelKey: 'EXE installer' },
  { value: 'msi', labelKey: 'MSI installer' },
  { value: 'dmg', labelKey: 'DMG image' },
  { value: 'appimage', labelKey: 'AppImage' },
  { value: 'deb', labelKey: 'DEB package' },
  { value: 'zip', labelKey: 'ZIP archive' },
]

/** Frozen by installer contract v1 §4: kind → allowed file extension. */
export const INSTALLER_KIND_EXTENSIONS: Record<InstallerKind, string> = {
  exe: '.exe',
  msi: '.msi',
  dmg: '.dmg',
  appimage: '.AppImage',
  deb: '.deb',
  zip: '.zip',
}

/** Backend default is 512 MB (`INSTALLER_MAX_SIZE_MB`); UI only warns early. */
export const INSTALLER_MAX_SIZE_MB = 512
export const INSTALLER_MAX_SIZE_BYTES = INSTALLER_MAX_SIZE_MB * 1024 * 1024

/** Contract v1 §3.2: `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$` (no leading `v`). */
export const INSTALLER_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export const UPLOAD_FORM_DEFAULTS: UploadInstallerFormValues = {
  file: null,
  version: '',
  platform: 'windows',
  arch: 'x64',
  kind: 'exe',
  release_notes: '',
}

export const INSTALLERS_QUERY_KEY = ['installers'] as const

export function getInstallerOptionLabelKey<TValue extends string>(
  options: Option<TValue>[],
  value: string
): string {
  const found = options.find((option) => option.value === value)
  return found ? found.labelKey : value
}

export function isInstallerPlatform(value: string): value is InstallerPlatform {
  return INSTALLER_PLATFORM_OPTIONS.some((option) => option.value === value)
}

export function isInstallerArch(value: string): value is InstallerArch {
  return INSTALLER_ARCH_OPTIONS.some((option) => option.value === value)
}

export function isInstallerKind(value: string): value is InstallerKind {
  return INSTALLER_KIND_OPTIONS.some((option) => option.value === value)
}

/**
 * Byte sizes are not covered by `@/lib/format`, so derive the magnitude here
 * and format the numeric part with `formatNumber` + `toIntlLocale`.
 */
export function formatInstallerSize(bytes: number, language?: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  if (bytes < 1024) {
    return `${formatNumber(bytes, toIntlLocale(language))} ${units[0]}`
  }
  let value = bytes / 1024
  let unitIndex = 1
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const digits = value < 10 ? 2 : 1
  return `${formatNumber(Number(value.toFixed(digits)), toIntlLocale(language))} ${units[unitIndex]}`
}

export function toEditFormValues(
  installer: Installer
): EditInstallerFormValues {
  return {
    version: installer.version,
    platform: installer.platform,
    arch: installer.arch,
    kind: installer.kind,
    release_notes: installer.release_notes,
    enabled: installer.enabled,
  }
}

export type UploadValidationErrors = Partial<
  Record<keyof UploadInstallerFormValues, InstallerValidationKey>
>

/** Client-side preflight only; the backend remains the authoritative check. */
export function validateUploadInstallerForm(
  values: UploadInstallerFormValues
): UploadValidationErrors {
  const errors: UploadValidationErrors = {}
  if (!values.file) {
    errors.file = 'Installer file is required'
  }
  if (!INSTALLER_VERSION_PATTERN.test(values.version.trim())) {
    errors.version = 'Invalid installer version'
  }
  if (!isInstallerPlatform(values.platform)) {
    errors.platform = 'Invalid installer platform'
  }
  if (!isInstallerArch(values.arch)) {
    errors.arch = 'Invalid installer architecture'
  }
  if (!isInstallerKind(values.kind)) {
    errors.kind = 'Invalid installer kind'
  }
  if (values.file && isInstallerKind(values.kind)) {
    const expected = INSTALLER_KIND_EXTENSIONS[values.kind]
    if (!values.file.name.toLowerCase().endsWith(expected.toLowerCase())) {
      errors.file = 'Installer file extension does not match kind'
    }
  }
  if (values.file && values.file.size > INSTALLER_MAX_SIZE_BYTES) {
    errors.file = 'Installer file exceeds size limit'
  }
  return errors
}

export type EditValidationErrors = Partial<
  Record<keyof EditInstallerFormValues, InstallerValidationKey>
>

export function validateEditInstallerForm(
  values: EditInstallerFormValues
): EditValidationErrors {
  const errors: EditValidationErrors = {}
  if (!INSTALLER_VERSION_PATTERN.test(values.version.trim())) {
    errors.version = 'Invalid installer version'
  }
  if (!isInstallerPlatform(values.platform)) {
    errors.platform = 'Invalid installer platform'
  }
  if (!isInstallerArch(values.arch)) {
    errors.arch = 'Invalid installer architecture'
  }
  if (!isInstallerKind(values.kind)) {
    errors.kind = 'Invalid installer kind'
  }
  return errors
}

export function getUploadProgressPercent(event: AxiosProgressEvent): number {
  if (!event.total) return 0
  return Math.min(100, Math.round((event.loaded / event.total) * 100))
}
