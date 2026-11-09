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
import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'

import type {
  Installer,
  InstallerListResponse,
  InstallerResponse,
  InstallerUpdatePayload,
} from './types'

export interface InstallerListParams {
  p: number
  /** Newer backends accept `page` (contract §3.1); sent alongside `p`. */
  page?: number
  page_size: number
}

export async function getInstallers(
  params: InstallerListParams
): Promise<InstallerListResponse> {
  const response = await api.get<InstallerListResponse>('/api/installers/', {
    params,
  })
  return requireServerSuccess(response.data)
}

export async function uploadInstaller(
  formData: FormData,
  onProgress?: (percent: number) => void
): Promise<Installer> {
  // Let axios set the multipart Content-Type with its boundary. The FormData
  // is built by lib/installer-form.ts so all fields follow contract §3.2.
  const response = await api.post<InstallerResponse>('/api/installers/', formData, {
    onUploadProgress: (event) => {
      if (!onProgress) return
      if (!event.total) {
        onProgress(0)
        return
      }
      onProgress(Math.round((event.loaded / event.total) * 100))
    },
  })
  const result = requireServerSuccess(response.data)
  return result.data as Installer
}

export async function updateInstaller(
  id: number,
  payload: InstallerUpdatePayload
): Promise<Installer> {
  const response = await api.put<InstallerResponse>(
    `/api/installers/${id}`,
    payload
  )
  const result = requireServerSuccess(response.data)
  return result.data as Installer
}

export async function deleteInstaller(id: number): Promise<void> {
  const response = await api.delete<InstallerResponse>(`/api/installers/${id}`)
  requireServerSuccess(response.data)
}
