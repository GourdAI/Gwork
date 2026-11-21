/**
 * GWork 设备中转客户端（契约 .gwork/mobile-link/PROTOCOL.md §1/§3）。
 *
 * 移动端经官方后台把「会话/任务」请求中转给桌面客户端上的本地内核：
 * - REST：GET /api/gwork/devices 发现账号下的设备（Bearer JWT，信封 success/data）。
 * - WS：GET /api/gwork/link?token=&deviceId=，信封 req/res/frame/ready/ping/pong/device_offline。
 *   token 走 query（H5 无法自定义 WS header，契约三端统一 query）；日志不打印 token。
 * - reqId 自增 + pending Map（35s 超时 reject）；res 信封 status!=200 也 resolve，
 *   业务层按内核信封 code 自行判定（502=设备离线/内核不可达，403=白名单外）。
 * - 心跳 25s ping；断线清理 pending 并通知订阅者 device_offline，不自动重连
 *   （v1 简化：会话层发送前 ensureConnected，重连后由会话层 replay 补帧）。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import type { UniSocketTask } from '@/utils/request.ts'
import { i18n } from '@/locale/i18n.ts'
import { fieldString } from '@/utils/tools.ts'
import { ensureFresh } from '@/utils/gwork-auth.ts'
import type { GworkSession } from '@/utils/gwork-auth.ts'
import { gworkRequest, gworkOrigin, gworkHostIndex, sessionHeader, ensureGworkHost } from '@/utils/gwork-request.ts'
import { GWORK_BASES } from '@/config/gwork-config.ts'
import type { ApiBody } from '@/utils/request.ts'
import type { DeviceOption } from '@/data/app-data'

export type LinkState = 'disconnected' | 'connecting' | 'ready'

/** WS 信封里的内核流帧原文（字段类型不稳定，读取一律 fieldString/判型） */
export type LinkFrame = ApiBody

export type FrameHandler = (sessionId: string, frame: LinkFrame) => void
export type OfflineHandler = () => void

type PendingEntry = {
	resolve: (body: ApiBody) => void
	reject: (err: Error) => void
	timer: number
}

/** 后台超时 35s，本地略放宽避免与后台的 502 res 竞争 */
const REQUEST_TIMEOUT_MS: number = 36000
const HEARTBEAT_MS: number = 25000
const CONNECT_TIMEOUT_MS: number = 15000

const linkState: Ref<LinkState> = ref<LinkState>('disconnected')

let socket: UniSocketTask | null = null
/** 当前连接对应的设备；切换设备必须先 disconnect */
let linkedDeviceId: string = ''
let connecting: Promise<void> | null = null
/** 进行中连接的目标设备（socket 尚未建立时 linkedDeviceId 还是空，用它判目标） */
let connectingDeviceId: string = ''
let reqSeq: number = 0
let heartbeatTimer: number = 0
// UTS/Kotlin 对对象字面量 delete 不可靠，一律 Map
const pending: Map<string, PendingEntry> = new Map<string, PendingEntry>()
const frameHandlers: Map<string, FrameHandler> = new Map<string, FrameHandler>()
const offlineHandlers: Set<OfflineHandler> = new Set<OfflineHandler>()

function t(key: string): string {
	return i18n.global.t(key)
}

/* ---------------- 设备发现（REST） ---------------- */

/** 设备清单（含离线）。信封 success/data；note 由 UI 层按 lastSeen 生成文案 */
export async function fetchDevices(): Promise<DeviceOption[]> {
	const s: GworkSession = await ensureFresh()
	const res = await gworkRequest.get<ApiBody>('/api/gwork/devices', null, {
		anon: true,
		toast: false,
		header: sessionHeader({ 'Authorization': 'Bearer ' + s.accessToken })
	})
	const body = res.data as ApiBody
	const raw = body.data
	if (!Array.isArray(raw)) return []
	const list: DeviceOption[] = []
	const rows = raw as ApiBody[]
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]
		const deviceId = fieldString(row, 'deviceId')
		if (deviceId.length === 0) continue
		const lastSeenRaw = row.lastSeen
		list.push({
			deviceId: deviceId,
			name: fieldString(row, 'name'),
			online: row.online === true,
			note: '',
			lastSeen: typeof lastSeenRaw === 'number' ? lastSeenRaw as number : 0
		})
	}
	return list
}

/* ---------------- 帧/离线订阅 ---------------- */

/** 会话层按 sessionId 订阅流帧；同 id 重复订阅覆盖旧回调（会话重建场景） */
export function onFrame(sessionId: string, handler: FrameHandler): void {
	frameHandlers.set(sessionId, handler)
}

export function offFrame(sessionId: string): void {
	frameHandlers.delete(sessionId)
}

/** 设备离线/断线通知（契约 §3.3：后台关闭移动连接前发 device_offline） */
export function onDeviceOffline(handler: OfflineHandler): void {
	offlineHandlers.add(handler)
}

export function offDeviceOffline(handler: OfflineHandler): void {
	offlineHandlers.delete(handler)
}

/* ---------------- 连接管理 ---------------- */

function stopHeartbeat(): void {
	if (heartbeatTimer !== 0) {
		clearInterval(heartbeatTimer)
		heartbeatTimer = 0
	}
}

function rejectAllPending(reason: string): void {
	pending.forEach((entry: PendingEntry): void => {
		clearTimeout(entry.timer)
		entry.reject(new Error(reason))
	})
	pending.clear()
}

function notifyOffline(): void {
	offlineHandlers.forEach((handler: OfflineHandler): void => {
		handler()
	})
}

/** 主动断开（切换设备/登出）：不触发离线通知，调用方自己负责清态 */
export function disconnect(): void {
	stopHeartbeat()
	rejectAllPending(t('link.disconnected'))
	connecting = null
	connectingDeviceId = ''
	const task = socket
	socket = null
	linkedDeviceId = ''
	linkState.value = 'disconnected'
	if (task != null) {
		try {
			task.close({ code: 1000, complete: (): void => { } })
		} catch (_) {
			// 连接可能已被对端关闭，close 抛错无需处理
		}
	}
}

/** H5 走当前页面 origin + vite/网关代理前缀（与 REST 锁定同一站点）；原生直连站点 */
function socketUrl(token: string, deviceId: string): string {
	const query: string = '/api/gwork/link?token=' + encodeURIComponent(token) + '&deviceId=' + encodeURIComponent(deviceId)
	let url: string = ''
	// #ifdef WEB
	const base: string = GWORK_BASES[gworkHostIndex() >= 0 ? gworkHostIndex() : 0]
	const scheme: string = location.protocol === 'https:' ? 'wss://' : 'ws://'
	url = scheme + location.host + base + query
	// #endif
	// #ifndef WEB
	const origin: string = gworkOrigin()
	url = origin.replace('https://', 'wss://').replace('http://', 'ws://') + query
	// #endif
	return url
}

function handleEnvelope(text: string): void {
	let env: ApiBody | null = null
	try {
		env = JSON.parse(text) as ApiBody
	} catch (_) {
		return
	}
	if (env == null) return
	const kind = fieldString(env, 'type')
	if (kind === 'res') {
		const reqId = fieldString(env, 'reqId')
		const entry = pending.get(reqId)
		if (entry == null) return
		pending.delete(reqId)
		clearTimeout(entry.timer)
		const statusRaw = env.status
		const status: number = typeof statusRaw === 'number' ? statusRaw as number : 0
		const bodyText = fieldString(env, 'body')
		let body: ApiBody = {}
		if (bodyText.length > 0) {
			try {
				body = JSON.parse(bodyText) as ApiBody
			} catch (_) {
				body = {}
			}
		}
		// status!=200 也 resolve：502/403 等由业务层按内核信封 code 处理
		if (status !== 200 && body.code == null) {
			body = { code: status, description: 'link http ' + status.toString() }
		}
		entry.resolve(body)
		return
	}
	if (kind === 'frame') {
		const sessionId = fieldString(env, 'sessionId')
		const payload = env.payload
		if (sessionId.length === 0 || payload == null || typeof payload !== 'object') return
		const handler = frameHandlers.get(sessionId)
		if (handler != null) handler(sessionId, payload as ApiBody)
		return
	}
	if (kind === 'device_offline') {
		// 契约 §3.3：随后后台会关闭本连接（4001），先通知订阅者落离线态
		notifyOffline()
		return
	}
	// ready / pong 无需额外处理：ready 由 connect 的 onOpen 后置状态覆盖
}

/**
 * 连接目标设备；已连同一设备直接复用。同设备并发 connect 共享同一 Promise。
 * 切换设备请先 disconnect（useDevices.selectDevice 负责）。
 */
export function connect(deviceId: string): Promise<void> {
	if (linkState.value === 'ready' && socket != null && linkedDeviceId === deviceId) {
		return Promise.resolve()
	}
	if (connecting != null) {
		// 进行中的连接若目标不是本设备（快速切换设备），先主动断开再按新目标重建；
		// 同目标则共享同一 Promise，避免并发双连接
		if (connectingDeviceId !== deviceId) {
			disconnect()
			connecting = null
			connectingDeviceId = ''
		} else {
			return connecting
		}
	}
	linkState.value = 'connecting'
	connectingDeviceId = deviceId
	connecting = new Promise<void>((resolve, reject) => {
		let settled: boolean = false
		let guardTimer: number = 0
		/** 本次 connect 创建的 socket（凭据阶段还是 null）；用于识别「已被替换」 */
		let myTask: UniSocketTask | null = null
		const fail = (message: string): void => {
			if (settled) return
			// 这条连接已被 disconnect/切换设备替换（socket 易主）：静默收尾，
			// 绝不能清掉新连接的状态或 reject 早已 settle 的 Promise
			if (myTask != null && socket !== myTask) {
				settled = true
				clearTimeout(guardTimer)
				return
			}
			settled = true
			clearTimeout(guardTimer)
			connecting = null
			connectingDeviceId = ''
			linkState.value = 'disconnected'
			const task = socket
			socket = null
			linkedDeviceId = ''
			if (task != null) {
				try {
					task.close({ code: 1000, complete: (): void => { } })
				} catch (_) { }
			}
			reject(new Error(message))
		}
		const succeed = (): void => {
			if (settled) return
			settled = true
			clearTimeout(guardTimer)
			connecting = null
			connectingDeviceId = ''
			linkState.value = 'ready'
			resolve()
		}
		ensureGworkHost().then((_idx: number): Promise<GworkSession> => {
			return ensureFresh()
		}).then((s: GworkSession): void => {
			const url: string = socketUrl(s.accessToken, deviceId)
			const task: UniSocketTask = uni.connectSocket({
				url: url,
				// 回调统一走 task.onXxx；complete 仅为满足参数类型
				complete: (): void => { }
			})
			// 凭据阶段被 disconnect 抢先（切换设备/登出）：这条连接直接关掉，不留孤儿 socket
			if (connectingDeviceId !== deviceId) {
				try {
					task.close({ code: 1000, complete: (): void => { } })
				} catch (_) { }
				return
			}
			socket = task
			myTask = task
			linkedDeviceId = deviceId
			guardTimer = setTimeout((): void => {
				fail(t('link.connectTimeout'))
			}, CONNECT_TIMEOUT_MS)
			task.onOpen((_res): void => {
				// 凭据阶段后、open 前被 disconnect 抢先：这条 socket 已易主，直接关掉
				if (socket !== task) {
					try {
						task.close({ code: 1000, complete: (): void => { } })
					} catch (_) { }
					return
				}
				// 后台连上即回 ready 信封，但 onOpen 已可收发；以 open 为准就绪
				stopHeartbeat()
				heartbeatTimer = setInterval((): void => {
					const live = socket
					if (live == null) return
					try {
						live.send({ data: '{"type":"ping"}', fail: (): void => { } })
					} catch (_) { }
				}, HEARTBEAT_MS)
				succeed()
			})
			task.onMessage((res): void => {
				// v1 只处理文本帧；ArrayBuffer（协议层 ping 等）忽略
				if (typeof res.data === 'string') handleEnvelope(res.data as string)
			})
			task.onError((_err): void => {
				fail(t('link.connectFailed'))
			})
			task.onClose((_res): void => {
				const wasSocket = socket === task
				if (!wasSocket) return
				stopHeartbeat()
				socket = null
				linkedDeviceId = ''
				linkState.value = 'disconnected'
				rejectAllPending(t('link.disconnected'))
				if (!settled) {
					fail(t('link.connectFailed'))
					return
				}
				notifyOffline()
			})
		}, (err: any): void => {
			const msg: string = err instanceof Error ? err.message : t('link.connectFailed')
			fail(msg)
		})
	})
	return connecting
}

/** 发送前确保链路可用：同设备已连直接过，否则重连（UI 层触发，v1 不做后台自动重连） */
export async function ensureConnected(deviceId: string): Promise<void> {
	if (deviceId.length === 0) throw new Error(t('chat.deviceRequired'))
	await connect(deviceId)
}

/* ---------------- 请求中转 ---------------- */

/**
 * 经后台中转内核 REST。query 不含 '?'（如 'root='）；body 为原始字符串
 * （form 或 json，contentType 决定）；cwd 传原始绝对路径（契约 §2.1：设备侧
 * 负责 percent-encode 一次转 X-Session-Cwd，移动端再编码会双重编码导致项目路由错）。
 * 调用前须 ensureConnected；返回内核信封 {code,data|description}。
 */
export function request(method: 'GET' | 'POST', path: string, query: string = '', body: string = '', cwd: string = '', contentType: string = 'application/json'): Promise<ApiBody> {
	const task = socket
	if (task == null || linkState.value !== 'ready') {
		return Promise.reject(new Error(t('link.disconnected')))
	}
	reqSeq += 1
	const reqId: string = 'm-' + reqSeq.toString()
	const envelope: ApiBody = {
		type: 'req',
		reqId: reqId,
		method: method,
		path: path,
		query: query,
		cwd: cwd,
		body: body,
		contentType: contentType
	}
	return new Promise<ApiBody>((resolve, reject) => {
		const timer: number = setTimeout((): void => {
			pending.delete(reqId)
			reject(new Error(t('link.requestTimeout')))
		}, REQUEST_TIMEOUT_MS)
		pending.set(reqId, { resolve: resolve, reject: reject, timer: timer })
		try {
			task.send({
				data: JSON.stringify(envelope),
				fail: (): void => {
					const entry = pending.get(reqId)
					if (entry == null) return
					pending.delete(reqId)
					clearTimeout(entry.timer)
					reject(new Error(t('link.disconnected')))
				}
			})
		} catch (_) {
			pending.delete(reqId)
			clearTimeout(timer)
			reject(new Error(t('link.disconnected')))
		}
	})
}

/** 内核信封 code 判定（code 类型不稳定，String 归一化） */
export function kernelOk(body: ApiBody): boolean {
	return String(body.code ?? '') === '200'
}

export function useLinkState(): Ref<LinkState> {
	return linkState
}
