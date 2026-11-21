/**
 * 设备清单与当前设备的跨页面共享状态（模块级单例）。
 *
 * 数据来自官方后台 GET /api/gwork/devices（utils/gwork-link.fetchDevices）。
 * activeDeviceId 持久化在 uni storage（gwork_active_device）；登录态变化
 * （gworkSignedIn watch，覆盖登录页登录成功与 App.onLaunch 异步恢复两条路径）
 * 触发刷新。切换设备 = 断开旧链路 + 清会话缓存 + 拉新设备会话列表
 * （清缓存/拉列表由 useConversations 对 activeDeviceId 的 watch 承接，避免循环依赖）。
 */
import { computed, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { i18n } from '@/locale/i18n.ts'
import { formatRelativeTime } from '@/utils/tools.ts'
import { gworkSignedIn } from '@/utils/gwork-auth.ts'
import { fetchDevices, disconnect, onDeviceOffline, useLinkState } from '@/utils/gwork-link.ts'
import type { LinkState } from '@/utils/gwork-link.ts'
import type { DeviceOption } from '@/data/app-data'

const STORAGE_KEY: string = 'gwork_active_device'

const devices: Ref<DeviceOption[]> = ref<DeviceOption[]>([])
const activeDeviceId: Ref<string> = ref<string>(readStoredId())
const loading: Ref<boolean> = ref<boolean>(false)
/** 最近一次刷新失败文案；空串=正常（离线引导用） */
const loadError: Ref<string> = ref<string>('')

let watching: boolean = false
let offlineBound: boolean = false

function readStoredId(): string {
	const raw = uni.getStorageSync(STORAGE_KEY) as string
	return raw != null ? raw : ''
}

function persistActive(): void {
	if (activeDeviceId.value.length === 0) {
		uni.removeStorageSync(STORAGE_KEY)
		return
	}
	uni.setStorageSync(STORAGE_KEY, activeDeviceId.value)
}

function deviceOf(id: string): DeviceOption | null {
	const found: DeviceOption | undefined = devices.value.find((item: DeviceOption): boolean => item.deviceId === id)
	return found ?? null
}

/** 离线设备的备注行：上次在线相对时间；在线为空 */
function noteOf(item: DeviceOption): string {
	if (item.online || item.lastSeen <= 0) return ''
	return i18n.global.t('home.device.lastSeen', { time: formatRelativeTime(item.lastSeen) })
}

/** 拉取设备清单并校正当前选中：优先持久化 id，其次第一台在线设备 */
export async function refreshDevices(): Promise<void> {
	if (!gworkSignedIn().value) {
		devices.value = []
		return
	}
	if (loading.value) return
	loading.value = true
	const prevId: string = activeDeviceId.value
	try {
		const list: DeviceOption[] = await fetchDevices()
		devices.value = list.map((item: DeviceOption): DeviceOption => {
			return { deviceId: item.deviceId, name: item.name, online: item.online, note: noteOf(item), lastSeen: item.lastSeen }
		})
		loadError.value = ''
		const stored: DeviceOption | null = deviceOf(activeDeviceId.value)
		if (stored == null) {
			const firstOnline: DeviceOption | undefined = devices.value.find((item: DeviceOption): boolean => item.online)
			activeDeviceId.value = firstOnline != null ? firstOnline.deviceId : ''
			persistActive()
			// 冷启动恢复的持久化 id 不触发 watch（值未变），显式断链兜底：
			// 进程内不可能已有旧链路，但保证「选中变化必断链」的不变式无旁路
			if (activeDeviceId.value !== prevId) disconnect()
		}
	} catch (err: any) {
		loadError.value = err instanceof Error ? err.message : i18n.global.t('chat.loadFailed')
	} finally {
		loading.value = false
	}
}

/**
 * 切换设备：断开旧链路 + 持久化。会话缓存清理与新设备会话列表拉取
 * 由 useConversations 对 activeDeviceId 的 watch 承接（单向依赖）。
 */
export function selectDevice(deviceId: string): void {
	if (deviceId === activeDeviceId.value) return
	disconnect()
	activeDeviceId.value = deviceId
	persistActive()
}

/** 后台通知设备离线：本地在线态即时置灰（发送入口据此拦截） */
function markActiveOffline(): void {
	const id: string = activeDeviceId.value
	devices.value = devices.value.map((item: DeviceOption): DeviceOption => {
		if (item.deviceId !== id) return item
		return { deviceId: item.deviceId, name: item.name, online: false, note: item.note, lastSeen: Date.now() }
	})
}

/** 登出清理：断链路 + 清清单（保留持久化 id，下个账号若同设备可复用） */
function resetDevices(): void {
	disconnect()
	devices.value = []
	loadError.value = ''
}

function ensureWatchers(): void {
	if (!watching) {
		watching = true
		watch(gworkSignedIn(), (signedIn: boolean): void => {
			if (signedIn) {
				refreshDevices()
			} else {
				resetDevices()
			}
		})
		// 冷启动：App.onLaunch 异步恢复登录态可能早于首个 hook 调用，watch 追不上，
		// 这里对「已登录但清单为空」补一次拉取（幂等，loading 去重）
		if (gworkSignedIn().value && devices.value.length === 0) {
			refreshDevices()
		}
	}
	if (!offlineBound) {
		offlineBound = true
		onDeviceOffline((): void => {
			markActiveOffline()
		})
	}
}

export type Devices = {
	devices: Ref<DeviceOption[]>
	activeDeviceId: Ref<string>
	activeDevice: ComputedRef<DeviceOption | null>
	/** 当前设备展示名；无设备时空串，UI 落引导文案 */
	deviceName: ComputedRef<string>
	deviceOnline: ComputedRef<boolean>
	loading: Ref<boolean>
	loadError: Ref<string>
	linkState: Ref<LinkState>
	refreshDevices: () => Promise<void>
	selectDevice: (deviceId: string) => void
}

export function useDevices(): Devices {
	ensureWatchers()

	const activeDevice: ComputedRef<DeviceOption | null> = computed<DeviceOption | null>((): DeviceOption | null => {
		return deviceOf(activeDeviceId.value)
	})
	const deviceName: ComputedRef<string> = computed<string>((): string => {
		const item: DeviceOption | null = activeDevice.value
		return item != null ? item.name : ''
	})
	const deviceOnline: ComputedRef<boolean> = computed<boolean>((): boolean => {
		const item: DeviceOption | null = activeDevice.value
		return item != null && item.online
	})

	return {
		devices,
		activeDeviceId,
		activeDevice,
		deviceName,
		deviceOnline,
		loading,
		loadError,
		linkState: useLinkState(),
		refreshDevices,
		selectDevice
	}
}
