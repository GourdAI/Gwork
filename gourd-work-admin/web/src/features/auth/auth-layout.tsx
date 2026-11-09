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
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { Skeleton } from '@/components/ui/skeleton'
import { useSystemConfig } from '@/hooks/use-system-config'

type AuthLayoutProps = {
  children: React.ReactNode
}

export function AuthLayout({ children }: AuthLayoutProps) {
  const { t } = useTranslation()
  const { systemName, logo, loading } = useSystemConfig()

  const brand = (
    <Link
      to='/'
      className='gw-auth-logo flex items-center gap-2.5 transition-opacity hover:opacity-80'
    >
      <div className='relative size-8'>
        {loading ? (
          <Skeleton className='absolute inset-0 rounded-lg' />
        ) : (
          <img
            src={logo}
            alt={t('Logo')}
            className='gw-brand-mark size-8 object-contain'
          />
        )}
      </div>
      {loading ? (
        <Skeleton className='h-5 w-24' />
      ) : (
        <span className='gw-auth-brand text-[15px] font-semibold'>
          {systemName}
        </span>
      )}
    </Link>
  )

  return (
    <div className='gw-auth-shell relative grid h-svh max-w-none overflow-y-auto'>
      {/* Single centred column: brand block → card → copyright.
          `m-auto` keeps tall forms (sign-up, reset) scrollable instead of
          clipping their top in short viewports. */}
      <div className='gw-auth-stack m-auto w-full px-6 py-10'>
        <div className='gw-auth-brand-block'>{brand}</div>
        <div className='gw-auth-card'>{children}</div>
        <p className='gw-auth-copy'>
          © {new Date().getFullYear()} {systemName}
        </p>
      </div>
    </div>
  )
}
