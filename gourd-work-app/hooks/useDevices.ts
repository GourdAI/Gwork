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
import { fetchDevices, disconnect, onDeviceOffline, onLinkResumed, setLinkTarget, useLinkState } from '@/utils/gwork-link.ts'
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
let resumedBound: boolean = false
/** 恢复后权威清单校正的去抖定时器（0 = 未安排） */
let reconcileTimer: number = 0

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
			setLinkTarget(activeDeviceId.value)
			// 只有「选中的设备真的换了」才断链。旧实现这里无条件 disconnect()：
			// 后台设备清单存在短暂滞后（设备刚上线、或 online 字段偶发 false）时，
			// deviceOf() 取不到就把 activeDeviceId 清空并断链，正在发送的消息
			// 立刻拿到「设备连接已断开」——设备明明在线，用户看到的就是这个提示。
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
	// 先 disconnect 再同步意图目标：切换后 request() 的透明自愈必须回新设备，
	// 绝不会回到刚被切走的旧设备（旧实现在这里让 lastDeviceId 归零，自愈直接放弃）。
	setLinkTarget(deviceId)
}

/** 后台通知设备离线：本地在线态即时置灰（发送入口据此拦截） */
function markActiveOffline(): void {
	const id: string = activeDeviceId.value
	devices.value = devices.value.map((item: DeviceOption): DeviceOption => {
		if (item.deviceId !== id) return item
		return { deviceId: item.deviceId, name: item.name, online: false, note: item.note, lastSeen: Date.now() }
	})
}

/**
 * 链路已自动恢复：把当前设备在线态拨回 true。
 * 不加这步，「一次抖动」留下的 online=false 会永久固化在内存清单里，
 * UI 一直显示已断开，直到下一次 refreshDevices 才可能修正——用户看到的就是
 * 「一直显示设备连接已断开」。
 * 但这里是**乐观**回弹：重连成功只证明链路通到后台，不证明设备真的在线
 * （后台可能紧接着回 device_offline 并 4001）。所以同时安排一次权威清单刷新校正，
 * 避免把「设备确实离线」长期误显示为在线（评审 P1-5）。
 */
function markActiveOnline(): void {
	const id: string = activeDeviceId.value
	if (id.length === 0) return
	devices.value = devices.value.map((item: DeviceOption): DeviceOption => {
		if (item.deviceId !== id) return item
		if (item.online) return item
		return { deviceId: item.deviceId, name: item.name, online: true, note: '', lastSeen: item.lastSeen }
	})
	// 去抖校正：抖动重连可能连续触发多次 resumed，只刷一次即可（loading 自带去重）
	if (reconcileTimer !== 0) clearTimeout(reconcileTimer)
	reconcileTimer = setTimeout((): void => {
		reconcileTimer = 0
		refreshDevices()
	}, 800)
}

/** 登出清理：断链路 + 清清单 + 清自愈目标（保留持久化 id，下个账号若同设备可复用） */
function resetDevices(): void {
	// 先清意图目标再断链：登出后绝不能再自动重连回这台设备
	setLinkTarget('')
	disconnect()
	devices.value = []
	loadError.value = ''
}

function ensureWatchers(): void {
	if (!watching) {
		watching = true
		// 冷启动/热重启都先把当前选中设备同步给链路层：request() 的透明自愈以它为准
		setLinkTarget(activeDeviceId.value)
		watch(activeDeviceId, (id: string): void => {
			setLinkTarget(id)
		})
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
	if (!resumedBound) {
		resumedBound = true
		onLinkResumed((): void => {
			markActiveOnline()
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
