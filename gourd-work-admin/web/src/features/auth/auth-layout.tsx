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

/* Qoder-style brand illustration: floating capability tiles (terminal /
   spark / chat / code card) dropping into a folder. Pure inline SVG so the
   auth pages stay offline-safe; every fill/stroke resolves through the
   .gw-art-* classes in gw-console.css (theme tokens only, no literals). */
function AuthBrandArt() {
  return (
    <svg
      viewBox='0 0 260 240'
      fill='none'
      xmlns='http://www.w3.org/2000/svg'
      aria-hidden='true'
    >
      <circle cx='130' cy='118' r='96' className='gw-art-halo' />
      <g className='gw-art-float'>
        <rect x='34' y='52' width='52' height='52' rx='14' className='gw-art-tile-dark' />
        <path d='M48 70l9 8-9 8' className='gw-art-stroke-light' />
        <line x1='61' y1='86' x2='72' y2='86' className='gw-art-stroke-light' />
      </g>
      <g className='gw-art-float gw-art-f2'>
        <rect x='104' y='20' width='52' height='52' rx='14' className='gw-art-tile-light' />
        <path
          d='M130 34c2.6 8.4 6.9 12.7 15.3 15.3-8.4 2.6-12.7 6.9-15.3 15.3-2.6-8.4-6.9-12.7-15.3-15.3 8.4-2.6 12.7-6.9 15.3-15.3z'
          className='gw-art-accent-fill'
        />
      </g>
      <g className='gw-art-float gw-art-f3'>
        <rect x='172' y='58' width='52' height='52' rx='14' className='gw-art-tile-dark' />
        <path
          d='M186 76h24a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4h-12l-7 6v-6h-5a4 4 0 0 1-4-4V80a4 4 0 0 1 4-4z'
          className='gw-art-stroke-light-fill'
        />
      </g>
      <path
        d='M52 128h44l12 12h100a10 10 0 0 1 10 10v62a10 10 0 0 1-10 10H52a10 10 0 0 1-10-10v-74a10 10 0 0 1 10-10z'
        className='gw-art-folder-back'
      />
      <g className='gw-art-float gw-art-f4'>
        <rect
          x='112'
          y='112'
          width='56'
          height='44'
          rx='9'
          transform='rotate(-8 140 134)'
          className='gw-art-tile-accent'
        />
        <path d='M132 128l-7 8 7 8M150 128l7 8-7 8' className='gw-art-stroke-contrast' />
      </g>
      <path
        d='M42 152h176v60a10 10 0 0 1-10 10H52a10 10 0 0 1-10-10v-60z'
        className='gw-art-folder-front'
      />
    </svg>
  )
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

  /* Qoder-style split screen: left brand-visual panel (handwritten slogan +
     floating-icon art + mark), right form column. Below 1000px the visual
     panel is hidden by CSS and the form column falls back to full width —
     no auth functionality lives in the visual panel. */
  return (
    <div className='gw-auth-shell relative grid h-svh max-w-none overflow-y-auto'>
      <div className='gw-auth-visual'>
        <div className='gw-auth-slogan'>
          {t('Beyond execution, pure creation.')}
        </div>
        <div className='gw-auth-art'>
          <AuthBrandArt />
        </div>
        <div className='gw-auth-visual-mark'>{systemName}</div>
      </div>
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
