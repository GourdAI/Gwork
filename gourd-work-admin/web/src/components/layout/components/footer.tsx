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
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'

import { useStatus } from '@/hooks/use-status'
import { useSystemConfig } from '@/hooks/use-system-config'
import { cn } from '@/lib/utils'

interface FooterLink {
  text: string
  href: string
}

interface FooterColumnProps {
  title: string
  links: FooterLink[]
}

interface FooterProps {
  logo?: string
  name?: string
  columns?: FooterColumnProps[]
  copyright?: string
  className?: string
}

function FooterLinkItem(props: { link: FooterLink }) {
  const { t } = useTranslation()
  const isExternal = props.link.href.startsWith('http')
  const isAnchor = props.link.href.includes('#')
  const label = t(props.link.text)

  if (isExternal || isAnchor) {
    return (
      <a
        href={props.link.href}
        {...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        className='gw-footer-link'
      >
        {label}
      </a>
    )
  }

  return (
    <Link to={props.link.href} className='gw-footer-link'>
      {label}
    </Link>
  )
}

// Renders User Agreement / Privacy Policy links inline with the parent's
// copyright row when either is configured in System Settings → Site. Emits
// fragmented siblings so the parent flex container's gap controls spacing.
function LegalLinks(props: { leadingSeparator?: boolean }) {
  const { t } = useTranslation()
  const { status } = useStatus()
  const items: { key: string; label: string; href: string }[] = []
  if (status?.user_agreement_enabled) {
    items.push({
      key: 'user-agreement',
      label: t('User Agreement'),
      href: '/user-agreement',
    })
  }
  if (status?.privacy_policy_enabled) {
    items.push({
      key: 'privacy-policy',
      label: t('Privacy Policy'),
      href: '/privacy-policy',
    })
  }
  if (items.length === 0) return null
  return (
    <>
      {items.map((item, index) => (
        <Fragment key={item.key}>
          {(props.leadingSeparator || index > 0) && (
            <span aria-hidden='true' className='gw-footer-sep'>
              ·
            </span>
          )}
          <Link to={item.href} className='gw-footer-link'>
            {item.label}
          </Link>
        </Fragment>
      ))}
    </>
  )
}

/**
 * Handbook-style footer: one horizontal brand row, an optional link row and a
 * single copyright line. Replaces the multi-column marketing footer.
 * Custom footer HTML and legal-link injection are preserved.
 */
export function Footer(props: FooterProps) {
  const { t } = useTranslation()
  const { systemName, logo: systemLogo, footerHtml, demoSiteEnabled } =
    useSystemConfig()

  const displayLogo = systemLogo || props.logo || '/logo.png'
  const displayName = systemName || props.name || 'GWork'
  const isDemoSiteMode = Boolean(demoSiteEnabled)
  const currentYear = new Date().getFullYear()

  const columns: FooterColumnProps[] = props.columns ?? [
    {
      title: t('footer.columns.product.title'),
      links: [
        { text: t('footer.columns.product.links.workspace'), href: '/#features' },
        { text: t('footer.columns.product.links.downloads'), href: '/#downloads' },
        { text: t('footer.columns.product.links.pricing'), href: '/pricing' },
      ],
    },
    {
      title: t('footer.columns.resources.title'),
      links: [
        { text: t('footer.columns.resources.links.about'), href: '/about' },
        { text: t('footer.columns.resources.links.models'), href: '/models' },
        { text: t('footer.columns.resources.links.dashboard'), href: '/dashboard' },
      ],
    },
    {
      title: t('footer.columns.workspace.title'),
      links: [
        { text: t('footer.columns.workspace.links.signIn'), href: '/sign-in' },
        { text: t('footer.columns.workspace.links.profile'), href: '/profile' },
        { text: t('footer.columns.workspace.links.keys'), href: '/keys' },
      ],
    },
  ]

  if (footerHtml) {
    return (
      <footer className={cn('gw-footer', props.className)}>
        <div className='gw-footer-inner'>
          <div
            className='custom-footer gw-footer-custom'
            dangerouslySetInnerHTML={{ __html: footerHtml }}
          />
          <div className='gw-footer-copy'>
            <LegalLinks />
            <span>
              &copy; {currentYear} {displayName}
            </span>
          </div>
        </div>
      </footer>
    )
  }

  return (
    <footer className={cn('gw-footer', props.className)}>
      <div className='gw-footer-inner'>
        <Link to='/' className='gw-footer-brand'>
          <img
            src={displayLogo}
            alt={displayName}
            className='gw-brand-mark size-7 rounded-lg object-contain'
          />
          <span className='gw-wordmark'>{displayName}</span>
          <span className='gw-sub'>
            {t('One desktop for all your AI work.')}
          </span>
        </Link>

        <nav className='gw-footer-links'>
          {isDemoSiteMode
            ? columns.map((column, index) => (
                <Fragment key={index}>
                  {column.links.map((link, linkIndex) => (
                    <FooterLinkItem key={linkIndex} link={link} />
                  ))}
                </Fragment>
              ))
            : null}
          <Link to='/about' className='gw-footer-link'>
            {t('About GWork')}
          </Link>
          <a href='/#downloads' className='gw-footer-link'>
            {t('All downloads')}
          </a>
          <a href='/#quickstart' className='gw-footer-link'>
            {t('Quick start')}
          </a>
        </nav>

        <div className='gw-footer-copy'>
          <span>
            &copy; {currentYear} {displayName}.{' '}
            {props.copyright ?? t('footer.defaultCopyright')}
          </span>
          <LegalLinks leadingSeparator />
          <span className='gw-footer-tagline'>
            {t('Local-first AI workspace, built for everyday work.')}
          </span>
        </div>
      </div>
    </footer>
  )
}
