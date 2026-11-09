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

interface CTAProps {
  className?: string
  isAuthenticated?: boolean
}

/** Flat ruled panel: copy on the left, actions on the right. No glow. */
export function CTA(props: CTAProps) {
  const { t } = useTranslation()

  return (
    <section id='about' className='gw-section'>
      <div className='gw-container'>
        <div className='gw-cta'>
          <div>
            <h2>
              {t('Bring AI work back to')}
              <br />
              <span className='gw-cta-accent'>{t('your own desktop')}</span>
            </h2>
            <p>
              {t(
                'Download GWork, connect a model, and let agents handle the multi-step work while you stay in control.'
              )}
            </p>
          </div>
          <div className='gw-cta-actions'>
            <Button
              className='gw-btn gw-btn-lg'
              render={<a href='#downloads' />}
            >
              <Download className='mr-1.5 size-4' aria-hidden='true' />
              {props.isAuthenticated
                ? t('Get the desktop app')
                : t('Download GWork')}
              <ArrowRight className='ml-1.5 size-4' aria-hidden='true' />
            </Button>
            <Button
              variant='outline'
              className='gw-btn gw-btn-lg'
              render={<a href='#quickstart' />}
            >
              {t('Quick start')}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
