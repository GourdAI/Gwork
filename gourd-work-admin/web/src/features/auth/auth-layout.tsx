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
    <div className='gw-auth-shell relative grid h-svh max-w-none'>
      {/* ── Left: brand panel (hidden on mobile) ── */}
      <aside className='gw-auth-aside hidden lg:flex' aria-hidden='true'>
        <div className='gw-auth-aside-inner'>
          {brand}
          <div className='gw-auth-pitch'>
            <p className='gw-eyebrow'>console access</p>
            <h2 className='gw-auth-headline'>
              {t('Agent workspace')}<br />
              <span className='gw-auth-headline-dim'>
                {t('unified gateway')}
              </span>
            </h2>
            <p className='gw-auth-sub'>{systemName}</p>
            <ul className='gw-auth-points'>
              <li>
                {t('Multi-model routing across channels')}
              </li>
              <li>{t('Usage, quota and billing in one console')}</li>
              <li>{t('API keys with fine-grained groups')}</li>
            </ul>
          </div>
          <p className='gw-auth-copy'>© {new Date().getFullYear()} {systemName}</p>
        </div>
      </aside>

      {/* ── Right: form panel ── */}
      <section className='relative flex min-w-0 flex-col'>
        <div className='flex items-center justify-between px-6 pt-6 sm:px-10 sm:pt-8 lg:hidden'>
          {brand}
        </div>
        {/* `m-auto` (not `items-center`) centres the form but collapses to 0 on
            the overflowing axis, so tall forms (sign-up, reset) stay scrollable
            instead of having their top clipped in short viewports. */}
        <div className='flex flex-1 overflow-y-auto px-6 py-10 sm:px-10'>
          <div className='m-auto w-full max-w-[400px] space-y-1'>
            {children}
          </div>
        </div>
      </section>
    </div>
  )
}
