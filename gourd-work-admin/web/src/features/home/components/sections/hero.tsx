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
import { ArrowRight, Download } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { HeroAppDemo } from '../hero-app-demo'

interface HeroProps {
  className?: string
  isAuthenticated?: boolean
}

/**
 * Handbook-style hero: centred mark, plain two-line headline and — instead of
 * the old request/response terminal mock — the desktop app window demo from
 * https://www.gourdwork.com/ (an agent rebuilding the website, revealed on a
 * timeline). No split columns, no gradient text, no aurora glow.
 */
export function Hero(props: HeroProps) {
  const { t } = useTranslation()

  return (
    <section id='top' className={cn('gw-section gw-hero', props.className)}>
      <div className='gw-container'>
        <div className='gw-hero-mark'>
          <img src='/logo.png' alt='GWork' />
        </div>

        <span className='gw-hero-badge'>
          <span className='gw-dot' aria-hidden='true' />
          {t('Desktop AI Workspace')}
        </span>

        <h1>
          {t('One desktop for')}{' '}
          <span className='gw-accent'>{t('all your AI work')}</span>
        </h1>

        <p className='gw-hero-tagline'>{t('Built for everyday work')}</p>

        <p className='gw-hero-desc'>
          {t(
            'GWork brings multi-model access, agent task orchestration, a skill marketplace and a local workspace together, so conversations, coding, documents and automation all happen on your desktop.'
          )}
        </p>

        <div className='gw-hero-actions'>
          <Button
            className='gw-btn gw-btn-lg'
            render={<a href='#downloads' />}
          >
            <Download className='mr-1.5 size-4' aria-hidden='true' />
            {t('Download GWork')}
            <ArrowRight className='ml-1.5 size-4' aria-hidden='true' />
          </Button>
          <Button
            variant='outline'
            className='gw-btn gw-btn-lg'
            render={<a href='#features' />}
          >
            {t('Explore capabilities')}
          </Button>
        </div>

        <div className='gw-hero-meta'>
          <span className='gw-chip'>{t('Chat')}</span>
          <span className='gw-chip'>{t('Coding')}</span>
          <span className='gw-chip'>{t('Documents')}</span>
          <span className='gw-chip'>{t('Automation')}</span>
        </div>

        <p className='gw-hero-note'>
          {props.isAuthenticated
            ? t(
                'Already signed in? Download the desktop app and connect it to this workspace.'
              )
            : t(
                'Plan, execute and review multi-step tasks without leaving your local workspace.'
              )}
        </p>

        <HeroAppDemo />
      </div>
    </section>
  )
}
