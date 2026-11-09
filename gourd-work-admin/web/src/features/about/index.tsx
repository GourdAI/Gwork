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
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Blocks, FolderLock, Sparkles, Workflow } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { PublicLayout } from '@/components/layout'
import { Button } from '@/components/ui/button'
import { RichContent } from '@/components/rich-content'
import { Skeleton } from '@/components/ui/skeleton'
import { isHttpUrl, isLikelyHtml } from '@/lib/content-format'
import { requireServerSuccess } from '@/lib/server-error-message'

import { getAboutContent } from './api'

const HIGHLIGHTS = [
  { icon: Workflow, key: 'Agent orchestration' },
  { icon: Blocks, key: 'Skills & plugins' },
  { icon: FolderLock, key: 'Local-first workspace' },
  { icon: Sparkles, key: 'Unified model access' },
] as const

function EmptyAboutState() {
  const { t } = useTranslation()

  return (
    <div className='mx-auto max-w-4xl px-6 py-16 md:py-24'>
      <div className='gw-about-hero flex flex-col items-start gap-6'>
        <span className='gw-eyebrow gw-about-badge'>
          <Sparkles className='size-3.5' aria-hidden='true' />
          {t('About GWork')}
        </span>
        <h1 className='text-[clamp(2rem,4vw,3rem)] leading-tight font-semibold tracking-tight'>
          {t('One desktop for')}{' '}
          <span className='text-muted-foreground'>{t('all your AI work')}</span>
        </h1>
        <p className='text-muted-foreground max-w-2xl text-base leading-relaxed'>
          {t(
            'GWork brings multi-model access, agent task orchestration, a skill marketplace and a local workspace together, so conversations, coding, documents and automation all happen on your desktop.'
          )}
        </p>
        <Button
          className='group h-11 rounded-xl px-5 text-sm font-medium'
          render={<a href='/#downloads' />}
        >
          {t('Download GWork')}
          <ArrowRight
            className='ml-1.5 size-4 transition-transform duration-200 group-hover:translate-x-0.5'
            aria-hidden='true'
          />
        </Button>
      </div>

      <div className='mt-16 grid grid-cols-1 gap-4 sm:grid-cols-2'>
        {HIGHLIGHTS.map(({ icon: Icon, key }) => (
          <div
            key={key}
            className='gw-about-card'
          >
            <Icon className='text-foreground/80 size-5' aria-hidden='true' />
            <h2 className='mt-4 text-sm font-semibold tracking-tight'>{t(key)}</h2>
            <p className='text-muted-foreground mt-1.5 text-sm leading-relaxed'>
              {t(`${key} description`)}
            </p>
          </div>
        ))}
      </div>

      <p className='text-muted-foreground/60 mt-16 text-xs'>
        &copy; {new Date().getFullYear()} GWork
      </p>
    </div>
  )
}

export function About() {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery({
    queryKey: ['about-content'],
    queryFn: async () => requireServerSuccess(await getAboutContent()),
  })

  const rawContent = data?.data?.trim() ?? ''
  const hasContent = rawContent.length > 0
  const isUrl = hasContent && isHttpUrl(rawContent)
  const contentIsHtml = hasContent && isLikelyHtml(rawContent)

  if (isLoading) {
    return (
      <PublicLayout>
        <div className='mx-auto flex max-w-4xl flex-col gap-4 py-12'>
          <Skeleton className='h-8 w-[45%]' />
          <Skeleton className='h-4 w-full' />
          <Skeleton className='h-4 w-[90%]' />
          <Skeleton className='h-4 w-[80%]' />
        </div>
      </PublicLayout>
    )
  }

  if (!hasContent) {
    return (
      <PublicLayout showMainContainer={false}>
        <EmptyAboutState />
      </PublicLayout>
    )
  }

  if (isUrl) {
    return (
      <PublicLayout showMainContainer={false}>
        <iframe
          src={rawContent}
          className='h-[calc(100vh-3.5rem)] w-full border-0'
          title={t('About')}
          sandbox='allow-forms allow-popups allow-popups-to-escape-sandbox allow-scripts'
        />
      </PublicLayout>
    )
  }

  if (contentIsHtml) {
    return (
      <PublicLayout showMainContainer={false}>
        <RichContent
          mode='html'
          htmlVariant='isolated'
          content={rawContent}
          className='prose-neutral dark:prose-invert max-w-none'
        />
      </PublicLayout>
    )
  }

  return (
    <PublicLayout>
      <div className='mx-auto max-w-6xl px-4 py-8'>
        <RichContent
          mode='markdown'
          content={rawContent}
          className='prose-neutral dark:prose-invert max-w-none'
        />
      </div>
    </PublicLayout>
  )
}
