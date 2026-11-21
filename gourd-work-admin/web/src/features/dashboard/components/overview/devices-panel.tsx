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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Laptop,
  MonitorSmartphone,
  RotateCw,
  Smartphone,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { IconBadge } from '@/components/ui/icon-badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { handleServerError } from '@/lib/handle-server-error'
import { cn } from '@/lib/utils'

import { deleteGworkDevice, getGworkDevices } from '../../api'
import type { GworkDevice } from '../../types'
import { PanelWrapper } from '../ui/panel-wrapper'

const DEVICES_QUERY_KEY = ['dashboard', 'overview', 'gwork-devices']

/** Online first, then most recently seen. */
function sortDevices(devices: GworkDevice[]): GworkDevice[] {
  return [...devices].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1
    return (b.lastSeen ?? 0) - (a.lastSeen ?? 0)
  })
}

function platformIcon(platform: string) {
  const p = platform.toLowerCase()
  if (p === 'android' || p === 'ios') return Smartphone
  if (p === 'windows' || p === 'macos' || p === 'linux') return Laptop
  return MonitorSmartphone
}

function formatLastSeen(lastSeen: number, t: (key: string) => string): string {
  if (!lastSeen) return t('Never connected')
  return new Date(lastSeen).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function DeviceRow(props: {
  device: GworkDevice
  isLast: boolean
  onDelete: (device: GworkDevice) => void
}) {
  const { t } = useTranslation()
  const device = props.device
  const Icon = platformIcon(device.platform)

  return (
    <div
      className={cn(
        'hover:bg-muted/40 flex items-center justify-between gap-2 px-3 py-2 transition-colors sm:px-5 sm:py-2.5',
        !props.isLast && 'border-border/40 border-b'
      )}
    >
      <div className='flex min-w-0 items-center gap-2.5'>
        <span
          className={cn(
            'inline-block size-2 shrink-0 rounded-full',
            device.online ? 'bg-emerald-500' : 'bg-muted-foreground/40'
          )}
          aria-hidden='true'
        />
        <Icon
          className='text-muted-foreground size-4 shrink-0'
          aria-hidden='true'
        />
        <div className='flex min-w-0 flex-col'>
          <span className='truncate text-sm font-medium'>{device.name}</span>
          <span className='text-muted-foreground truncate font-mono text-xs'>
            {device.platform || 'unknown'}
            {device.appVersion ? ` · v${device.appVersion}` : ''}
          </span>
        </div>
      </div>
      <div className='flex shrink-0 items-center gap-2'>
        <div className='flex flex-col items-end'>
          <span
            className={cn(
              'text-xs font-medium',
              device.online ? 'text-success' : 'text-muted-foreground'
            )}
          >
            {device.online ? t('Online') : t('Offline')}
          </span>
          {!device.online && (
            <span className='text-muted-foreground/70 text-xs tabular-nums'>
              {formatLastSeen(device.lastSeen, t)}
            </span>
          )}
        </div>
        <Button
          variant='ghost'
          size='sm'
          className='text-muted-foreground hover:text-destructive size-7 p-0'
          disabled={device.online}
          title={
            device.online
              ? t('The device is online; disconnect it before deleting')
              : t('Delete')
          }
          aria-label={t('Delete')}
          onClick={() => props.onDelete(device)}
        >
          <Trash2 className='size-3.5' />
        </Button>
      </div>
    </div>
  )
}

export function DevicesPanel() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [pendingDelete, setPendingDelete] = useState<GworkDevice | null>(null)

  const devicesQuery = useQuery({
    queryKey: DEVICES_QUERY_KEY,
    queryFn: async () => {
      const result = await getGworkDevices()
      return result.success ? (result.data ?? []) : []
    },
    // Online state lives in server memory and changes with heartbeats;
    // keep the card fresh while the overview page is open.
    refetchInterval: 30 * 1000,
    staleTime: 15 * 1000,
  })

  const deleteMutation = useMutation({
    mutationFn: async (device: GworkDevice) => {
      const result = await deleteGworkDevice(device.deviceId)
      if (!result.success) {
        throw result
      }
      return result
    },
    onSuccess: () => {
      toast.success(t('Device deleted'))
      setPendingDelete(null)
      void queryClient.invalidateQueries({ queryKey: DEVICES_QUERY_KEY })
    },
    onError: (error) => {
      handleServerError(error, t('Failed to delete device'))
    },
  })

  const devices = sortDevices(devicesQuery.data ?? [])
  const onlineCount = devices.filter((device) => device.online).length

  return (
    <>
      <PanelWrapper
        title={
          <span className='flex items-center gap-2'>
            <IconBadge tone='info' size='sm'>
              <MonitorSmartphone />
            </IconBadge>
            {t('My devices')}
            {devices.length > 0 && (
              <span className='text-muted-foreground bg-muted/60 rounded-md px-1.5 py-0.5 font-mono text-xs tabular-nums'>
                {onlineCount}/{devices.length}
              </span>
            )}
          </span>
        }
        description={t('Desktop devices linked to this account')}
        loading={devicesQuery.isLoading}
        empty={!devicesQuery.isLoading && devices.length === 0}
        emptyMessage={t(
          'No devices yet. Sign in on the GWork desktop app to link this device.'
        )}
        height='h-80'
        contentClassName='p-0'
        headerActions={
          <Button
            variant='ghost'
            size='sm'
            onClick={() => devicesQuery.refetch()}
            disabled={devicesQuery.isFetching}
            className='size-7 p-0'
          >
            <RotateCw
              className={cn('size-3.5', devicesQuery.isFetching && 'animate-spin')}
              aria-label={t('Refresh')}
            />
          </Button>
        }
      >
        <ScrollArea className='h-80'>
          <div>
            {devices.map((device, index) => (
              <DeviceRow
                key={device.deviceId}
                device={device}
                isLast={index === devices.length - 1}
                onDelete={setPendingDelete}
              />
            ))}
          </div>
        </ScrollArea>
      </PanelWrapper>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Are you sure?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('This will remove device')}{' '}
              <span className='font-semibold'>{pendingDelete?.name}</span>{' '}
              {t(
                'from your account. It will register again on its next sign-in.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t('Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                pendingDelete && deleteMutation.mutate(pendingDelete)
              }
              disabled={deleteMutation.isPending}
              variant='destructive'
            >
              {deleteMutation.isPending ? t('Deleting...') : t('Delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}