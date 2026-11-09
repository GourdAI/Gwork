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
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { LanguageSwitcher } from '@/components/language-switcher'
import { NotificationPopover } from '@/components/notification-popover'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { ThemeSwitch } from '@/components/theme-switch'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { SystemUpdateAction } from '@/features/system-update/system-update-action'
import { useNotifications } from '@/hooks/use-notifications'
import { useSystemConfig } from '@/hooks/use-system-config'
import { useTopNavLinks } from '@/hooks/use-top-nav-links'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'

import { defaultTopNavLinks } from '../config/top-nav.config'
import type { TopNavLink } from '../types'
import { HeaderLogo } from './header-logo'

const AUTH_PROMPT_SECONDS = 5

type AuthPromptTarget = {
  title: string
  href: string
}

export interface PublicHeaderProps {
  navLinks?: TopNavLink[]
  mobileLinks?: TopNavLink[]
  navContent?: React.ReactNode
  showThemeSwitch?: boolean
  showLanguageSwitcher?: boolean
  logo?: React.ReactNode
  siteName?: string
  homeUrl?: string
  leftContent?: React.ReactNode
  rightContent?: React.ReactNode
  showNavigation?: boolean
  showAuthButtons?: boolean
  showNotifications?: boolean
  className?: string
}

/**
 * Handbook-style header: a full-width hairline sticky bar with plain text
 * links. Replaces the floating, scroll-shrinking pill navigation that made the
 * site read as a generic landing-page template.
 * All behaviour (auth prompt, notifications, language/theme switchers, mobile
 * menu) is preserved; only the DOM/layout changed.
 */
export function PublicHeader(props: PublicHeaderProps) {
  const {
    navLinks = defaultTopNavLinks,
    showThemeSwitch = true,
    showLanguageSwitcher = true,
    logo: customLogo,
    siteName: customSiteName,
    homeUrl = '/',
    showAuthButtons = true,
    showNotifications = true,
  } = props

  const { t } = useTranslation()
  const navigate = useNavigate()
  const [scrolled, setScrolled] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [authPromptTarget, setAuthPromptTarget] =
    useState<AuthPromptTarget | null>(null)
  const [authPromptSecondsLeft, setAuthPromptSecondsLeft] =
    useState(AUTH_PROMPT_SECONDS)
  const { auth } = useAuthStore()
  const {
    systemName,
    logo: systemLogo,
    loading,
    logoLoaded,
  } = useSystemConfig()
  const dynamicLinks = useTopNavLinks()
  const notifications = useNotifications()
  const routerState = useRouterState()
  const pathname = routerState.location.pathname

  const user = auth.user
  const isAuthenticated = !!user
  const displaySiteName = customSiteName || systemName
  const links = dynamicLinks.length > 0 ? dynamicLinks : navLinks

  let logoContent: ReactNode = (
    <HeaderLogo
      src={systemLogo}
      loading={loading}
      logoLoaded={logoLoaded}
      className='size-full rounded-lg object-contain'
    />
  )
  if (customLogo) logoContent = customLogo
  if (loading) logoContent = <Skeleton className='size-full rounded-lg' />

  let authContent = (
    <Button
      size='sm'
      className='gw-btn gw-btn-sm'
      render={<Link to='/sign-in' />}
    >
      {t('Sign in')}
    </Button>
  )
  if (isAuthenticated) authContent = <ProfileDropdown />
  if (loading) authContent = <Skeleton className='h-8 w-20 rounded-lg' />

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    document.body.style.overflow = mobileOpen ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [mobileOpen])

  useEffect(() => {
    if (!authPromptTarget) return

    const intervalId = window.setInterval(() => {
      setAuthPromptSecondsLeft((seconds) => Math.max(seconds - 1, 0))
    }, 1000)

    const timeoutId = window.setTimeout(() => {
      const redirect = authPromptTarget.href
      setAuthPromptTarget(null)
      navigate({ to: '/sign-in', search: { redirect } })
    }, AUTH_PROMPT_SECONDS * 1000)

    return () => {
      window.clearInterval(intervalId)
      window.clearTimeout(timeoutId)
    }
  }, [authPromptTarget, navigate])

  const closeAuthPrompt = useCallback(() => {
    setAuthPromptTarget(null)
    setAuthPromptSecondsLeft(AUTH_PROMPT_SECONDS)
  }, [])

  const navigateToSignIn = useCallback(() => {
    const redirect = authPromptTarget?.href || '/'
    setAuthPromptTarget(null)
    navigate({ to: '/sign-in', search: { redirect } })
  }, [authPromptTarget?.href, navigate])

  const handleNavLinkClick = useCallback(
    (
      event: React.MouseEvent<HTMLAnchorElement>,
      link: TopNavLink,
      closeMobile = false
    ) => {
      if (link.disabled) {
        event.preventDefault()
        return
      }

      if (link.requiresAuth) {
        event.preventDefault()
        if (closeMobile) setMobileOpen(false)
        setAuthPromptSecondsLeft(AUTH_PROMPT_SECONDS)
        setAuthPromptTarget({
          title: t(link.title),
          href: link.href,
        })
        return
      }

      if (closeMobile) setMobileOpen(false)
    },
    [t]
  )

  const renderLink = (link: TopNavLink, isActive: boolean, closeMobile: boolean) => {
    const className = cn(
      'gw-nav-link',
      isActive && 'gw-nav-link--active',
      link.disabled && 'pointer-events-none opacity-50'
    )
    if (link.external) {
      return (
        <a
          key={`${link.title}:${link.href}`}
          href={link.href}
          title={t(link.title)}
          target='_blank'
          rel='noopener noreferrer'
          aria-disabled={link.disabled}
          tabIndex={link.disabled ? -1 : undefined}
          onClick={(event) => handleNavLinkClick(event, link, closeMobile)}
          className={className}
          data-active={isActive || undefined}
        >
          {t(link.title)}
        </a>
      )
    }
    return (
      <Link
        key={`${link.title}:${link.href}`}
        to={link.href}
        title={t(link.title)}
        disabled={link.disabled}
        onClick={(event) => handleNavLinkClick(event, link, closeMobile)}
        className={className}
        data-active={isActive || undefined}
      >
        {t(link.title)}
      </Link>
    )
  }

  return (
    <>
      <header className={cn('gw-nav', props.className)} data-scrolled={scrolled}>
        <div className='gw-nav-inner'>
          <Link to={homeUrl} className='gw-brand'>
            <span className='flex size-8 shrink-0 items-center justify-center'>
              {logoContent}
            </span>
            <span className='gw-wordmark truncate' title={displaySiteName}>
              {loading ? <Skeleton className='h-4 w-16' /> : displaySiteName}
            </span>
          </Link>
          <SystemUpdateAction presentation='version' />

          <nav className='gw-nav-links'>
            {links.map((link) => renderLink(link, pathname === link.href, false))}
          </nav>

          <div className='gw-nav-actions'>
            {showLanguageSwitcher && <LanguageSwitcher />}
            {showThemeSwitch && <ThemeSwitch />}
            {showNotifications && (
              <NotificationPopover
                open={notifications.popoverOpen}
                onOpenChange={notifications.setPopoverOpen}
                unreadCount={notifications.unreadCount}
                activeTab={notifications.activeTab}
                onTabChange={notifications.setActiveTab}
                notice={notifications.notice}
                announcements={notifications.announcements}
                loading={notifications.loading}
              />
            )}
            {showAuthButtons && (
              <>
                <span className='gw-nav-sep' aria-hidden='true' />
                {authContent}
              </>
            )}
          </div>

          <div className='gw-nav-mobile'>
            {showThemeSwitch && <ThemeSwitch />}
            {showAuthButtons && !loading && isAuthenticated && (
              <ProfileDropdown />
            )}
            <Button
              type='button'
              variant='ghost'
              size='icon'
              className='size-9'
              onClick={() => setMobileOpen((v) => !v)}
              aria-label={t('Toggle navigation menu')}
            >
              <div className='relative size-4'>
                <span
                  className={cn(
                    'absolute inset-x-0 block h-[1.5px] origin-center rounded-full bg-current transition-all duration-300',
                    mobileOpen ? 'top-[7px] rotate-45' : 'top-[3px]'
                  )}
                />
                <span
                  className={cn(
                    'absolute inset-x-0 top-[7px] block h-[1.5px] rounded-full bg-current transition-all duration-300',
                    mobileOpen ? 'scale-x-0 opacity-0' : 'opacity-100'
                  )}
                />
                <span
                  className={cn(
                    'absolute inset-x-0 block h-[1.5px] origin-center rounded-full bg-current transition-all duration-300',
                    mobileOpen ? 'top-[7px] -rotate-45' : 'top-[11px]'
                  )}
                />
              </div>
            </Button>
          </div>
        </div>
      </header>

      {/* Mobile dropdown menu (replaces the full-screen blur overlay) */}
      {mobileOpen ? (
        <div className='gw-mobile-menu lg:hidden'>
          <nav>
            {links.map((link) => renderLink(link, pathname === link.href, true))}
          </nav>
          <div className='gw-mobile-cta'>
            {showAuthButtons && (
              <Link
                to={isAuthenticated ? '/dashboard' : '/sign-in'}
                onClick={() => setMobileOpen(false)}
                className='gw-btn gw-btn-sm gw-mobile-signin'
              >
                {isAuthenticated ? t('Go to Dashboard') : t('Sign in')}
              </Link>
            )}
          </div>
        </div>
      ) : null}

      <Dialog
        open={!!authPromptTarget}
        onOpenChange={(open) => {
          if (!open) closeAuthPrompt()
        }}
        title={t('Sign in required')}
        description={t('Please sign in to view {{module}}.', {
          module: authPromptTarget?.title || '',
        })}
        contentClassName='sm:max-w-md'
        contentHeight='auto'
        footer={
          <>
            <Button variant='outline' onClick={closeAuthPrompt}>
              {t('Cancel')}
            </Button>
            <Button onClick={navigateToSignIn}>{t('Sign in now')}</Button>
          </>
        }
      >
        <div className='bg-muted/40 text-muted-foreground rounded-lg px-3 py-2 text-sm'>
          {t('Redirecting to sign in in {{seconds}} seconds.', {
            seconds: authPromptSecondsLeft,
          })}
        </div>
      </Dialog>
    </>
  )
}
