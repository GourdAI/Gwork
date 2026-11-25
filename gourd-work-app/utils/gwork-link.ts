/**
 * GWork 设备中转客户端（契约 .gwork/mobile-link/PROTOCOL.md §1/§3）。
 *
 * 移动端经官方后台把「会话/任务」请求中转给桌面客户端上的本地内核：
 * - REST：GET /api/gwork/devices 发现账号下的设备（Bearer JWT，信封 success/data）。
 * - WS：GET /api/gwork/link?token=&deviceId=，信封 req/res/frame/ready/ping/pong/device_offline。
 *   token 走 query（H5 无法自定义 WS header，契约三端统一 query）；日志不打印 token。
 * - reqId 自增 + pending Map（35s 超时 reject，条目记录所属 socket）；res 信封
 *   status!=200 也 resolve，业务层按内核信封 code 自行判定（502=设备离线/内核不可达，403=白名单外）。
 * - 心跳 25s ping，并带活性看门狗：连续 75s 无任何入站数据即判死（后台 60s 无帧就断，
 *   看门狗必须比后台更早发现才能主动重建，否则只能等迟到的 onClose）。
 * - 断线自愈：非用户主动断开（切换设备/登出）时按指数退避自动重连；offline→ready
 *   跃迁（无论由退避定时器还是有在途请求的强制重建达成）统一在 succeed() 里通知
 *   订阅者（onLinkResumed）以便会话层 replay 补帧、清离线提示。
 * - 重试纪律：request() 在链路非 ready 时先透明重连再发；已经「发出去过」的写请求
 *   绝不重放（设备侧可能已受理，重发 input 会命中 busy 分支把消息回滚掉），
 *   只有幂等 GET 或「帧根本没写进 socket」的失败才自动重试一次。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import type { UniSocketTask } from '@/utils/request.ts'
import { i18n } from '@/locale/i18n.ts'
import { fieldString } from '@/utils/tools.ts'
import { ensureFresh, gworkSignedIn } from '@/utils/gwork-auth.ts'
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
/** 链路恢复（自动重连成功）：会话层据此 replay 补帧 */
export type ResumedHandler = () => void

type PendingEntry = {
	resolve: (body: ApiBody) => void
	reject: (err: Error) => void
	timer: number
	/** 这一帧由哪条 socket 发出：清理只作用在该 socket 上，不误伤新连接的在途请求 */
	owner: UniSocketTask | null
}

/**
 * 链路失败原因。undelivered=true 表示这帧**确实没写进 socket**（没 socket/未 ready/
 * send fail/同步抛错），重发对非幂等请求也是安全的；否则「可能已投递」，
 * 对 POST /web/chat/input 绝不能重放（设备侧已受理，重发会命中 busy 分支把
 * 用户刚发的消息回滚掉，表现为「消息发出后自己消失」）。
 */
type LinkFailure = Error & { undelivered?: boolean }

function linkFailure(message: string, undelivered: boolean): LinkFailure {
	const err: LinkFailure = new Error(message) as LinkFailure
	err.undelivered = undelivered
	return err
}

function isUndelivered(err: any): boolean {
	return err != null && (err as LinkFailure).undelivered === true
}

/** 后台超时 35s，本地略放宽避免与后台的 502 res 竞争 */
const REQUEST_TIMEOUT_MS: number = 36000
const HEARTBEAT_MS: number = 25000
const CONNECT_TIMEOUT_MS: number = 15000
/** 连续这么久没有任何入站数据判死：后台 60s 无帧即断，必须更早发现才能主动重建 */
const IDLE_DEAD_MS: number = 75000
/** 自动重连退避（毫秒），最后一档保持 */
const RECONNECT_BACKOFF_MS: number[] = [1000, 2000, 4000, 8000, 15000]
/**
 * 链路稳活多久才认为「真的恢复了」并把退避计数清零。
 * 【不能一 open 就清零】设备真离线时后台先接受 WS、再回 device_offline + 4001 关链，
 * 若 succeed() 立刻 reconnectAttempt=0，就会变成「连上→被踢→1s 后再连」的无限
 * 重连风暴（实测 100ms 内就能建出多条连接）。稳活 30s 才算恢复。
 */
const STABLE_MS: number = 30000
/**
 * 重连成功后延迟多久才向会话层宣告「已恢复」。设备真离线时后台接受 WS 后会立刻
 * device_offline + 4001 关链，若一 open 就通知，离线提示会「清掉→又出现」反复闪，
 * 每次都白跑一遍 resumeRunning 补帧。宽限期过后仍 ready 才认恢复。
 */
const RESUMED_GRACE_MS: number = 1500

const linkState: Ref<LinkState> = ref<LinkState>('disconnected')

let socket: UniSocketTask | null = null
/** 当前连接对应的设备；切换设备必须先 disconnect */
let linkedDeviceId: string = ''
let connecting: Promise<void> | null = null
/** 在途 connect 的收尾函数：disconnect() 必须显式调用它来 settle，
 *  不能指望 onClose（连接从未 open 时很多平台不回调 close，Promise 会永久 pending） */
let connectingFail: ((message: string, undelivered: boolean) => void) | null = null
/** 进行中连接的目标设备（socket 尚未建立时 linkedDeviceId 还是空，用它判目标） */
let connectingDeviceId: string = ''
let reqSeq: number = 0
let heartbeatTimer: number = 0
/** 看门狗：最后一次收到任何入站数据的时刻（毫秒） */
let lastInboundAt: number = 0
/** 自动重连定时器（0 = 未安排）；主动 disconnect 必须清掉 */
let reconnectTimer: number = 0
let reconnectAttempt: number = 0
/** 最近一次连接成功的设备：断线自愈要回到它 */
let lastDeviceId: string = ''
/** 上层意图目标（useDevices 把 activeDeviceId 同步进来）：切换设备/登出后 request() 的
 *  透明重连以此为准，绝不回到旧设备。旧实现只靠 lastDeviceId，而 disconnect() 会清空它，
 *  于是切换设备瞬间的在途请求自愈「无目标可回」只能静默失败。 */
let intentDeviceId: string = ''
/** 主动断开标记：置位期间的 onClose 不触发自动重连，也不通知离线 */
let manualClose: boolean = false
/** 曾经连上过、且此后发生过掉线：只有这种「恢复」才通知 onLinkResumed（首连不算） */
let degraded: boolean = false
/** connect 代次：每次新连接自增，旧闭包据此识别「已被取代」，绝不清理新连接的状态 */
let connectGen: number = 0
// UTS/Kotlin 对对象字面量 delete 不可靠，一律 Map
const pending: Map<string, PendingEntry> = new Map<string, PendingEntry>()
const frameHandlers: Map<string, FrameHandler> = new Map<string, FrameHandler>()
const offlineHandlers: Set<OfflineHandler> = new Set<OfflineHandler>()
const resumedHandlers: Set<ResumedHandler> = new Set<ResumedHandler>()

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

/** 链路恢复通知：自动重连成功，会话层据此 replay 补帧 */
export function onLinkResumed(handler: ResumedHandler): void {
	resumedHandlers.add(handler)
}

export function offLinkResumed(handler: ResumedHandler): void {
	resumedHandlers.delete(handler)
}

/* ---------------- 连接管理 ---------------- */

function stopHeartbeat(): void {
	if (heartbeatTimer !== 0) {
		clearInterval(heartbeatTimer)
		heartbeatTimer = 0
	}
}

function cancelReconnect(): void {
	if (reconnectTimer !== 0) {
		clearTimeout(reconnectTimer)
		reconnectTimer = 0
	}
}

/**
 * 清掉在途请求。owner 非空时只清这条 socket 发出的帧：force 重建/切换设备时
 * 绝不能连带 reject 新连接上刚发出的请求（旧实现是全局清空）。
 * 这里的帧都已写进过 socket，故一律标记 undelivered=false（对端可能已受理），
 * 非幂等写请求不会再被重放。
 */
function rejectAllPending(reason: string, owner: UniSocketTask | null = null): void {
	const dead: string[] = []
	pending.forEach((entry: PendingEntry, reqId: string): void => {
		if (owner != null && entry.owner !== owner) return
		clearTimeout(entry.timer)
		entry.reject(linkFailure(reason, false))
		dead.push(reqId)
	})
	for (let i = 0; i < dead.length; i++) pending.delete(dead[i])
}

function notifyOffline(): void {
	degraded = true
	offlineHandlers.forEach((handler: OfflineHandler): void => {
		handler()
	})
}

function notifyResumed(): void {
	resumedHandlers.forEach((handler: ResumedHandler): void => {
		handler()
	})
}

/** 自愈目标：上层意图 > 最近成功 > 当前连接 */
function targetDevice(): string {
	if (intentDeviceId.length > 0) return intentDeviceId
	if (lastDeviceId.length > 0) return lastDeviceId
	return linkedDeviceId
}

/**
 * 断线自愈：非用户主动断开时按指数退避重建到同一设备。
 * 成功后的 onLinkResumed 由 connect 的 succeed() 统一发（覆盖「退避重建」与
 * 「有在途请求时的强制重建」两条路径），这里只负责重试节奏。
 * 不检查设备在线态（devices 列表可能滞后），连不上就继续退避即可。
 */
function scheduleReconnect(): void {
	if (manualClose) return
	const deviceId: string = targetDevice()
	if (deviceId.length === 0) return
	// 已有在途连接（别的路径正在重连）就不必再排：connect 内部单飞共享
	if (reconnectTimer !== 0) return
	const idx: number = reconnectAttempt < RECONNECT_BACKOFF_MS.length ? reconnectAttempt : RECONNECT_BACKOFF_MS.length - 1
	const delay: number = RECONNECT_BACKOFF_MS[idx]
	reconnectAttempt += 1
	reconnectTimer = setTimeout((): void => {
		reconnectTimer = 0
		// 期间用户可能已登出/切设备：认最新目标而不是闭包里的旧值
		if (manualClose || !gworkSignedIn().value) return
		const target: string = targetDevice()
		if (target.length === 0) return
		connect(target).then((): void => {
			// succeed() 已发过 onLinkResumed，这里不再重复
			reconnectAttempt = 0
		}, (): void => {
			// 一次失败可能是设备离线/网络抖动：继续退避，绝不放弃
			scheduleReconnect()
		})
	}, delay)
}

/**
 * 主动断开（切换设备/登出）：不触发离线通知、不触发自愈，调用方自己负责清态。
 * 【保留上层意图目标】旧实现连 lastDeviceId 一起清空，切换设备/清缓存后若还有
 * 在途请求，自愈会「无目标可回」而静默放弃——用户看到的是链路再不恢复。
 * 是否允许重连只由 manualClose 决定（登出时 gworkSignedIn 也为 false，双保险）。
 */
export function disconnect(): void {
	manualClose = true
	// 代次自增：所有在途 connect 闭包立即失效，不会再改状态/不会再 settle 到全局
	connectGen += 1
	cancelReconnect()
	reconnectAttempt = 0
	degraded = false
	stopHeartbeat()
	rejectAllPending(t('link.disconnected'))
	// 【必须主动 settle 在途 connect】连接尚未 open 时多数平台不会回调 onClose，
	// 只把 connecting 置 null 会让返回的 Promise 永久 pending，上层
	// `await ensureConnected` 的发送/停止/选模型链路一起挂死
	// —— 用户看到的就是「点发送没有任何反应」。
	const pendingFail = connectingFail
	connectingFail = null
	if (pendingFail != null) pendingFail(t('link.disconnected'), true)
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

/**
 * 同步上层意图目标（useDevices 的 activeDeviceId）。切换设备必须先 disconnect()
 * 再调用本函数；request() 的透明重连以它为准，不会回到旧设备。
 */
export function setLinkTarget(deviceId: string): void {
	intentDeviceId = deviceId
}


/** 只允许回环主机使用明文 ws://：token 只能走 query（H5 无法设 WS header），
 * 对非回环主机降级成 ws:// 等于把会话凭据明文发到网络上。 */
function isLoopbackUrl(url: string): boolean {
	const m = /^ws:\/\/(\[[^\]]+\]|[^:/]+)/.exec(url)
	if (m == null) return false
	const host: string = m[1].replace(/^\[|\]$/g, '')
	return host === '127.0.0.1' || host === 'localhost' || host === '::1'
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
	if (url.indexOf('ws://') === 0 && !isLoopbackUrl(url)) {
		// 绝不静默用明文发送会话 token：调用方按连接失败处理（提示检查站点配置）
		throw new Error('insecure ws:// for non-loopback host: ' + url.split('?')[0])
	}
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
 * force=true 时丢弃现有 socket 强制新建：用于「链路看似 ready 实则已死」的自愈
 * （例如 close 在途、或远端已断但 onClose 尚未回调）。
 */
export function connect(deviceId: string, force: boolean = false): Promise<void> {
	if (!force && linkState.value === 'ready' && socket != null && linkedDeviceId === deviceId) {
		return Promise.resolve()
	}
	// 未登录一律不建链：登出时 resetDevices 会 setLinkTarget('') + disconnect()，
	// 若此时还有在途请求在飞，透明重连会借 lastDeviceId 把链路重新拉起来（幽灵连接）。
	if (!gworkSignedIn().value) {
		return Promise.reject(linkFailure(t('link.disconnected'), true))
	}
	// 已有在途连接（单飞）：同目标一律共享——force 也共享，绝不叠加出第二条 socket，
	// 否则多个在途请求各自 force 重建会互相把对方的 socket 关掉（实测 3 个请求 → 3 条连接）。
	if (connecting != null) {
		if (connectingDeviceId === deviceId) return connecting
		// 目标不同（快速切设备）：旧闭包靠 connectGen 自行收尾，这里只让位。
		// 【不要调用 disconnect()】它会置 manualClose 并把并发在途请求一起 reject；
		// 切换设备的清态是 useDevices.selectDevice 的职责，不在这里顺手做。
		connectGen += 1
		// 旧的 fail 已随代次失效：解绑，避免 disconnect() 误 settle 到一个死闭包
		connectingFail = null
		connecting = null
		connectingDeviceId = ''
	}
	const gen: number = connectGen + 1
	connectGen = gen
	linkState.value = 'connecting'
	connectingDeviceId = deviceId
	// 显式 connect 就是用户/上层要连：解除主动断开标记并撤掉待执行的自愈，
	// 否则 disconnect() 里置位的 manualClose 会让本次连接的 onClose 不再自愈。
	manualClose = false
	cancelReconnect()
	lastDeviceId = deviceId
	// 只在链路层还不知道用户意图时采纳本次目标：意图的权威来源是 setLinkTarget
	// （useDevices 的 activeDeviceId）。无条件覆盖会让一个迟到的 connect(旧设备)
	// 把用户刚切过去的新设备意图踩掉，自愈又跑回旧设备。
	if (intentDeviceId.length === 0) intentDeviceId = deviceId
	// force 重建：先丢掉旧 socket（存在 close 在途/半开的情况），否则新 socket
	// 会被旧 socket 的 onClose 误伤（wasSocket 判定为 false 而不清理新连接状态）。
	// 在途请求按 owner 精确清理，只 reject 这条死 socket 发出的帧。
	if (force) {
		const stale = socket
		// 丢弃一条真实存在的旧连接＝链路刚从「可用」退化：置 degraded 让 succeed()
		// 在重建成功后补发 onLinkResumed。半开连接（onClose 迟迟不回调）从不触发
		// notifyOffline，若只靠 offline 置位，这条最常见的自愈路径就不会通知会话层，
		// 断线期间的回答也就不会 replay 续上。
		if (stale != null) degraded = true
		socket = null
		linkedDeviceId = ''
		stopHeartbeat()
		rejectAllPending(t('link.disconnected'), stale)
		if (stale != null) {
			try {
				stale.close({ code: 1000, complete: (): void => { } })
			} catch (_) { }
		}
	}
	connecting = new Promise<void>((resolve, reject) => {
		let settled: boolean = false
		let guardTimer: number = 0
		/** 本次 connect 创建的 socket（凭据阶段还是 null）；用于识别「已被替换」 */
		let myTask: UniSocketTask | null = null
		/**
		 * 收尾并 settle。任何分支都必须 settle（旧实现在「连接已被取代」时直接 return，
		 * Promise 永远 pending，上层 await ensureConnected 的发送/停止/选模型链路永久挂住，
		 * 用户看到的就是「点了发送没有任何反应」）。
		 * 已被取代时不碰全局状态（connecting/linkState/socket 都属于新连接）。
		 */
		const fail = (message: string, undelivered: boolean = false): void => {
			if (settled) return
			settled = true
			clearTimeout(guardTimer)
			if (connectingFail === fail) connectingFail = null
			// 本连接已被取代（代次变了 / socket 已易主）：只清自己这条 socket，
			// 绝不碰新连接的 socket 与全局限流状态（旧实现在这种情形直接 return，
			// 既不 settle 也不清 connecting）。
			const superseded: boolean = gen !== connectGen || (myTask != null && socket !== myTask)
			if (superseded) {
				const orphan = myTask
				myTask = null
				if (orphan != null) {
					try {
						orphan.close({ code: 1000, complete: (): void => { } })
					} catch (_) { }
				}
				reject(linkFailure(message, undelivered))
				return
			}
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
			reject(linkFailure(message, undelivered))
			// 曾经建好过、现在重建失败（设备刚睡醒/网络还没回来）：继续退避重试，
			// 绝不停在 disconnected 等用户手动操作，否则就是「一直显示已断开」。
			// 首连失败（degraded=false）不自动重试：交给调用方提示，避免冷启动狂刷后台。
			if (degraded && !manualClose && gworkSignedIn().value) scheduleReconnect()
		}
		// 登记给 disconnect()：连接未 open 时平台可能不回调 onClose，必须由外部主动 settle
		connectingFail = fail
		const succeed = (): void => {
			if (settled) return
			settled = true
			clearTimeout(guardTimer)
			if (connectingFail === fail) connectingFail = null
			connecting = null
			connectingDeviceId = ''
			linkState.value = 'ready'
			// 【不要在这里把 reconnectAttempt 清零】设备真离线时后台先接受 WS、紧接着
			// device_offline + 4001 关链，一 open 就清零会退化成 1s 一轮的重连风暴。
			// 只有稳活 STABLE_MS 才算真恢复（见下）。
			// 【offline→ready 跃迁必须通知】旧实现只在退避定时器那一支 notifyResumed()，
			// 而最常见路径（发消息途中抖动 → request() 强制重建 → connect 成功）从不通知：
			// 会话层收不到 ⇒ 离线提示永不清、断线期间的回答不再 replay 补帧。
			// 统一收敛到 succeed()，两条自愈路径都覆盖；首连（degraded=false）不算恢复。
			// 【延迟一个宽限期再通知】设备真离线时后台先接受 WS、紧接着 device_offline +
			// 4001 关链：若 open 即通知，离线提示会「清掉→1s 后又出现」反复闪，
			// 且每次都会触发一次 resumeRunning 补帧。稳过 RESUMED_GRACE_MS 才认恢复。
			const mine: UniSocketTask | null = myTask
			if (degraded) {
				setTimeout((): void => {
					if (mine != null && socket === mine && linkState.value === 'ready' && degraded) {
						degraded = false
						notifyResumed()
					}
				}, RESUMED_GRACE_MS)
			}
			setTimeout((): void => {
				// 稳活判据：这条 socket 仍是在用连接且状态仍 ready，才清零退避计数
				if (mine != null && socket === mine && linkState.value === 'ready') reconnectAttempt = 0
			}, STABLE_MS)
			resolve()
		}
		ensureGworkHost().then((_idx: number): Promise<GworkSession> => {
			return ensureFresh()
		}).then((s: GworkSession): void => {
			// 凭据阶段期间被 disconnect/切设备抢先：直接收尾，不留孤儿 socket
			if (gen !== connectGen) {
				fail(t('link.disconnected'), true)
				return
			}
			let url: string = ''
			try {
				url = socketUrl(s.accessToken, deviceId)
			} catch (err: any) {
				// 非回环主机被拒绝降级成明文 ws://：按连接失败收尾，
				// 绝不静默把会话 token 明文发出去。
				fail(err instanceof Error ? err.message : t('link.connectFailed'), true)
				return
			}
			const task: UniSocketTask = uni.connectSocket({
				url: url,
				// 回调统一走 task.onXxx；complete 仅为满足参数类型
				complete: (): void => { }
			})
			// 凭据阶段被 disconnect 抢先（切换设备/登出）：这条连接直接关掉，不留孤儿 socket。
			// 【必须 settle】见 fail() 注释。
			if (gen !== connectGen) {
				try {
					task.close({ code: 1000, complete: (): void => { } })
				} catch (_) { }
				fail(t('link.disconnected'), true)
				return
			}
			socket = task
			myTask = task
			linkedDeviceId = deviceId
			lastInboundAt = Date.now()
			guardTimer = setTimeout((): void => {
				fail(t('link.connectTimeout'), true)
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
				lastInboundAt = Date.now()
				stopHeartbeat()
				heartbeatTimer = setInterval((): void => {
					const live = socket
					if (live == null) return
					// 活性看门狗：后台 60s 收不到帧就断连，而 onClose 在半开连接上
					// 可能长时间不触发（移动网络 NAT 超时/切网最典型）。连续 75s
					// 没有任何入站数据即判定已死，主动关闭以触发自愈重建，
					// 而不是让用户对着一个「状态 ready、实际已死」的链路反复发送失败。
					if (Date.now() - lastInboundAt > IDLE_DEAD_MS) {
						try {
							live.close({ code: 1000, complete: (): void => { } })
						} catch (_) { }
						return
					}
					try {
						live.send({ data: '{"type":"ping"}', fail: (): void => { } })
					} catch (_) { }
				}, HEARTBEAT_MS)
				succeed()
			})
			task.onMessage((res): void => {
				// 任何入站数据都算链路活着（后台的 pong / ready / res / frame）
				lastInboundAt = Date.now()
				// v1 只处理文本帧；ArrayBuffer（协议层 ping 等）忽略
				if (typeof res.data === 'string') handleEnvelope(res.data as string)
			})
			task.onError((_err): void => {
				fail(t('link.connectFailed'))
			})
			task.onClose((_res): void => {
				const wasSocket = socket === task
				// 已被取代的 socket 关闭：只清它自己的在途帧，不碰新连接的状态
				if (!wasSocket) {
					rejectAllPending(t('link.disconnected'), task)
					return
				}
				stopHeartbeat()
				socket = null
				linkedDeviceId = ''
				linkState.value = 'disconnected'
				rejectAllPending(t('link.disconnected'), task)
				if (!settled) {
					fail(t('link.connectFailed'))
					return
				}
				// 【自愈】非主动断开的关闭（网络抖动/后台 60s 判死/设备重连踢旧连接）
				// 必须自动重建并补帧。旧实现只 notifyOffline 就结束：链路一旦断过，
				// linkState 永久停在 disconnected，后续每次 request() 直接抛
				// 「设备连接已断开」，用户看到的就是「一直显示设备连接已断开」。
				// 重连成功后的 onLinkResumed 由 succeed() 统一发（不在这里发，
				// 否则「退避那一支也发」会重复通知）。
				notifyOffline()
				scheduleReconnect()
			})
		}, (err: any): void => {
			const msg: string = err instanceof Error ? err.message : t('link.connectFailed')
			// 凭据阶段失败＝帧还没进 socket，标记为「未投递」，写请求可以安全重试
			fail(msg, true)
		})
	})
	return connecting
}

/** 发送前确保链路可用：同设备已连直接过，否则重连 */
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
 *
 * 重试纪律（评审 P0-2）：只有「帧确实没写进 socket」(undelivered) 或 GET（幂等）
 * 才自动重试一次。链路抖动时 onClose 会先 rejectAllPending，此时设备侧可能**已经受理**
 * 了 POST /web/chat/input；旧实现把它当「没发出去」在新连接上重发一次，第二次命中
 * 内核 data:"busy" 分支 → useConversations 走 rollbackOptimisticSend 把用户刚发的
 * 消息和 AI 占位一起撤掉，用户看到「消息发出后自己消失了」。
 */
export function request(method: 'GET' | 'POST', path: string, query: string = '', body: string = '', cwd: string = '', contentType: string = 'application/json'): Promise<ApiBody> {
	const idempotent: boolean = method === 'GET'
	/** 直接在当前 socket 上发一帧；要求调用时链路已 ready */
	const sendNow = (): Promise<ApiBody> => {
		const task = socket
		if (task == null || linkState.value !== 'ready') {
			return Promise.reject(linkFailure(t('link.disconnected'), true))
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
			const entry: PendingEntry = { resolve: resolve, reject: reject, timer: timer, owner: task }
			pending.set(reqId, entry)
			try {
				task.send({
					data: JSON.stringify(envelope),
					fail: (): void => {
						const current = pending.get(reqId)
						if (current == null) return
						pending.delete(reqId)
						clearTimeout(current.timer)
						// 帧未写入 socket：对端不可能受理，标记「未投递」可安全重发
						reject(linkFailure(t('link.disconnected'), true))
					}
				})
			} catch (_) {
				pending.delete(reqId)
				clearTimeout(timer)
				reject(linkFailure(t('link.disconnected'), true))
			}
		})
	}
	/** 透明重连到目标设备后发送 */
	const reconnectAndSend = (force: boolean): Promise<ApiBody> => {
		const target: string = targetDevice()
		if (target.length === 0) return Promise.reject(linkFailure(t('link.disconnected'), true))
		return connect(target, force).then((): Promise<ApiBody> => {
			return sendNow()
		}, (_err: any): never => {
			throw linkFailure(t('link.disconnected'), true)
		})
	}
	/** 可重试：幂等 GET，或对端确定未受理（undelivered） */
	const mayRetry = (err: any): boolean => {
		const msg: string = err instanceof Error ? err.message : ''
		if (msg !== t('link.disconnected')) return false
		return idempotent || isUndelivered(err)
	}
	if (socket != null && linkState.value === 'ready') {
		return sendNow().catch((err: any): Promise<ApiBody> => {
			// 半开连接 / close 在途：socket 已死但 onClose 还没回调，linkState 仍是 ready，
			// send 会立即失败。这时强制重建一次再发；只重试一次，绝不无限重试
			// （设备真离线时后台会回 502 信封，由业务层按内核码提示，而不是在这里吞掉）。
			if (!mayRetry(err)) throw err
			return reconnectAndSend(true)
		})
	}
	// 【自愈】链路未就绪（刚断/正在退避重连）：先透明重连到目标设备，成功即照常发送。
	// 旧实现此处直接 reject「设备连接已断开」，只要链路断过一次且用户没手动切设备，
	// 之后每次发送都会立刻失败——这正是「一直显示设备连接已断开」。
	return reconnectAndSend(false)
}

/** 内核信封 code 判定（code 类型不稳定，String 归一化） */
export function kernelOk(body: ApiBody): boolean {
	return String(body.code ?? '') === '200'
}

export function useLinkState(): Ref<LinkState> {
	return linkState
}
