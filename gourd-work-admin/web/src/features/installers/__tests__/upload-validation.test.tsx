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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { uploadInstaller } from '../api'
import { InstallerUploadDialog } from '../components/installer-upload-dialog'

vi.mock('../api', () => ({
  uploadInstaller: vi.fn(),
}))

describe('installer upload validation', () => {
  beforeEach(() => {
    vi.mocked(uploadInstaller).mockReset()
    i18next.addResourceBundle('en', 'translation', {
      'Installer file': 'Installer file',
      Version: 'Version',
      Upload: 'Upload',
      'Installer file extension does not match kind':
        'Installer file extension does not match kind',
    })
  })

  test('a .dmg file selected for an EXE package is rejected and no upload starts', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <InstallerUploadDialog open onOpenChange={vi.fn()} />
      </QueryClientProvider>
    )

    await user.upload(
      screen.getByLabelText('Installer file'),
      new File(['binary'], 'GWork-1.2.3.dmg', {
        type: 'application/octet-stream',
      })
    )
    await user.type(screen.getByLabelText('Version'), '1.2.3')
    await user.click(screen.getByRole('button', { name: 'Upload' }))

    expect(
      await screen.findByText('Installer file extension does not match kind')
    ).toBeInTheDocument()
    expect(uploadInstaller).not.toHaveBeenCalled()

    queryClient.clear()
  })
})
