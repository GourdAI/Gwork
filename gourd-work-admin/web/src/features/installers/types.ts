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
export const INSTALLER_PLATFORMS = ['windows', 'macos', 'linux'] as const
export const INSTALLER_ARCHES = ['x64', 'arm64'] as const
export const INSTALLER_KINDS = [
  'exe',
  'msi',
  'dmg',
  'appimage',
  'deb',
  'zip',
] as const

export type InstallerPlatform = (typeof INSTALLER_PLATFORMS)[number]
export type InstallerArch = (typeof INSTALLER_ARCHES)[number]
export type InstallerKind = (typeof INSTALLER_KINDS)[number]

export interface Installer {
  id: number
  version: string
  platform: InstallerPlatform
  arch: InstallerArch
  kind: InstallerKind
  file_name: string
  stored_name: string
  size: number
  sha256: string
  release_notes: string
  enabled: boolean
  download_count: number
  created_at: string
  updated_at: string
}

export interface InstallerListResponse {
  success: boolean
  message: string
  data: {
    items: Installer[]
    total: number
    page: number
    page_size: number
  }
}

export interface InstallerResponse {
  success: boolean
  message: string
  data: Installer | null
}

export interface InstallerUpdatePayload {
  version?: string
  platform?: InstallerPlatform
  arch?: InstallerArch
  kind?: InstallerKind
  enabled?: boolean
  release_notes?: string
}

export interface InstallerUploadFields {
  file: File
  version: string
  platform: InstallerPlatform
  arch: InstallerArch
  kind: InstallerKind
  release_notes: string
}

/** Form state used by the upload dialog (file may be unset while filling in). */
export interface UploadInstallerFormValues {
  file: File | null
  version: string
  platform: InstallerPlatform
  arch: InstallerArch
  kind: InstallerKind
  release_notes: string
}

/** Form state used by the metadata edit dialog (no binary upload). */
export interface EditInstallerFormValues {
  version: string
  platform: InstallerPlatform
  arch: InstallerArch
  kind: InstallerKind
  release_notes: string
  enabled: boolean
}

/** Canonical extension expected for each package kind. */
export const KIND_EXTENSIONS: Record<InstallerKind, string> = {
  exe: '.exe',
  msi: '.msi',
  dmg: '.dmg',
  appimage: '.AppImage',
  deb: '.deb',
  zip: '.zip',
}

export const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/** Current published latest.json, from GET /api/installers/latest. */
export interface InstallerLatestInfo {
  version: string
  notes: string
  pub_date: string
  platforms: string[]
  size: number
  updated_at: string
  url: string
  api_url: string
}

export interface InstallerLatestInfoResponse {
  success: boolean
  message: string
  data: InstallerLatestInfo | null
}
