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
import type { UploadInstallerFormValues } from '../types'

/** Multipart fields are frozen by installer contract v1 §3.2. */
export function buildUploadInstallerFormData(
  values: UploadInstallerFormValues
): FormData {
  const formData = new FormData()
  if (values.file) {
    formData.append('file', values.file)
  }
  formData.append('version', values.version.trim())
  formData.append('platform', values.platform)
  formData.append('arch', values.arch)
  formData.append('kind', values.kind)
  formData.append('release_notes', values.release_notes)
  return formData
}
