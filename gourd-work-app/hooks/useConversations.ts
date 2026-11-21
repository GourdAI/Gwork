/**
 * 会话域模型的跨页面共享状态：会话列表、当前会话、消息、置顶。
 *
 * 真实链路（契约 .gwork/mobile-link/PROTOCOL.md §4）：列表/历史/发送/停止/改名/删除
 * 经 utils/gwork-link 的 WS 中转打到桌面内核 /web/chat/*；流式正文消费 frame 信封
 * （text 增量拼正文、reason 维持 thinking、action_* 落工具名 meta、done/error 收口）。
 * eventSeq 每会话去重；断线后对进行中的会话 replay?afterSeq= 补帧再续。
 * 置顶内核无端点，本地 storage 持久化（保留设计稿组内重排行为）。
 *
 * UTS 响应式纪律：流式改写必须从响应式数组回读 proxy 再持有（见 sendMessage 尾注），
 * 闭包捕获 push 前的原始对象不会触发视图更新。
 */
import { computed, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { i18n } from '@/locale/i18n.ts'
import { fieldString } from '@/utils/tools.ts'
import { gworkSignedIn } from '@/utils/gwork-auth.ts'
import { ensureConnected, request, kernelOk, onFrame, offFrame, onDeviceOffline } from '@/utils/gwork-link.ts'
import type { LinkFrame } from '@/utils/gwork-link.ts'
import { useDevices } from '@/hooks/useDevices'
import { useRunEnv } from '@/hooks/useRunEnv'
import { useWorkspaces, setProjectRoots, clearWorkspaces } from '@/hooks/useWorkspaces'
import { DEFAULT_WORKSPACE, PERMISSIONS } from '@/data/app-data'
import type { ApiBody } from '@/utils/request.ts'
import type { ChatMessage, Conversation, WorkspaceOption } from '@/data/app-data'

export type Conversations = {
	conversations: Ref<Conversation[]>
	activeConvId: Ref<string>
	activeConversation: ComputedRef<Conversation | null>
	defaultConversations: ComputedRef<Conversation[]>
	conversationsOf: (workspace: string) => Conversation[]
	setActive: (id: string) => void
	createConversation: (workspace: string, firstText?: string) => string
	renameConversation: (id: string, title: string) => void
	togglePin: (id: string) => boolean
	removeConversation: (id: string) => void
	sendMessage: (id: string, text: string) => void
	stopMessage: (id: string) => void
	/** 列表刷新（登录/选设备后自动触发；下拉/重试可手动调） */
	refresh: () => Promise<void>
	listLoading: Ref<boolean>
	listError: Ref<string>
}

const conversations: Ref<Conversation[]> = ref<Conversation[]>([])
const activeConvId: Ref<string> = ref<string>('')
const listLoading: Ref<boolean> = ref<boolean>(false)
const listError: Ref<string> = ref<string>('')

/** 每会话流式游标：eventSeq 去重 + runId 记录（interrupt 用）+ 本轮起始时刻（done 耗时） */
type StreamCursor = { lastSeq: number; runId: string; startedAt: number }
// UTS/Kotlin 对对象字面量 delete 不可靠，一律 Map
const cursors: Map<string, StreamCursor> = new Map<string, StreamCursor>()
/** 历史已加载的会话（懒加载去重）；发送失败/删除后允许重拉 */
const loaded: Set<string> = new Set<string>()
/** 进行中的会话（发送成功→done/error 之间），断线重连后据此 replay */
const running: Set<string> = new Set<string>()
const PIN_KEY: string = 'gwork_pinned_sessions'
// 惰性初始化：readPins 引用 PIN_KEY，模块顶层调用在 H5/Vite 编译产物下
// 会因声明顺序触发 TDZ（Cannot access 'PIN_KEY' before initialization）整页白屏
let pinsLoaded: boolean = false
const pinnedIds: Set<string> = new Set<string>()

function ensurePins(): void {
	if (pinsLoaded) return
	pinsLoaded = true
	readPins().forEach((id: string) => {
		pinnedIds.add(id)
	})
}

let msgSeq: number = 0
let watching: boolean = false
/** 列表刷新代际：设备切换/登出后旧响应不得回写 */
let refreshGen: number = 0

function t(key: string, values?: Record<string, string>): string {
	if (values == null) return i18n.global.t(key)
	return i18n.global.t(key, values)
}

function toast(key: string, values?: Record<string, string>): void {
	uni.showToast({ title: t(key, values), icon: 'none' })
}

function readPins(): string[] {
	const raw = uni.getStorageSync(PIN_KEY) as string
	if (raw == null || raw.length === 0) return []
	try {
		const arr = JSON.parse(raw) as string[]
		return Array.isArray(arr) ? arr : []
	} catch (_) {
		return []
	}
}

function persistPins(): void {
	const list: string[] = []
	pinnedIds.forEach((id: string): void => {
		list.push(id)
	})
	uni.setStorageSync(PIN_KEY, JSON.stringify(list))
}

function nextMsgId(): string {
	msgSeq += 1
	return 'm' + msgSeq.toString()
}

/** 契约 §4：新任务允许客户端自带 work-<uuid8> id */
function newConvId(): string {
	let hex: string = ''
	for (let i = 0; i < 8; i++) {
		hex += Math.floor(Math.random() * 16).toString(16)
	}
	return 'work-' + hex
}

function conversationOf(id: string): Conversation | null {
	const found: Conversation | undefined = conversations.value.find((item: Conversation): boolean => item.id === id)
	return found ?? null
}

function cursorOf(id: string): StreamCursor {
	let cursor: StreamCursor | undefined = cursors.get(id)
	if (cursor == null) {
		cursor = { lastSeq: 0, runId: '', startedAt: 0 }
		cursors.set(id, cursor)
	}
	return cursor
}

/** 取文字前 16 字做标题，超出加省略号（与设计稿 newChat 行为一致） */
function titleFromText(text: string): string {
	const trimmed: string = text.trim()
	if (trimmed.length <= 16) return trimmed
	return trimmed.slice(0, 16) + '…'
}

/** 置顶只在所属工作区分组内重排，组外槽位不动（设计稿 togglePin 行为） */
function sortInWorkspace(list: Conversation[]): Conversation[] {
	return list.slice().sort((a: Conversation, b: Conversation): number => {
		if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
		return 0
	})
}

/** 会话归属工作区键：root 空=全局区，否则绝对路径 */
function workspaceKeyOf(root: string): string {
	return root.length === 0 ? DEFAULT_WORKSPACE : root
}

/** 会话的 root（delete/rename 必须显式带 root，内核按它路由项目目录） */
function rootOf(conv: Conversation): string {
	return conv.workspace === DEFAULT_WORKSPACE ? '' : conv.workspace
}

function isProcessing(id: string): boolean {
	return running.has(id)
}

/** 权限模式 → 内核 accessMode（'允许完全访问'→full，其余→default）。
 * useRunEnv 不反向依赖本文件，顶层 import 无循环 */
function accessModeNow(): string {
	const { permission } = useRunEnv()
	return permission.value === PERMISSIONS[1].name ? 'full' : 'default'
}

/* ---------------- 列表 ---------------- */

function convFromSessionRow(row: ApiBody, root: string): Conversation | null {
	const id = fieldString(row, 'sessionId')
	if (id.length === 0) return null
	const timeRaw = row.time
	const updatedAt: number = typeof timeRaw === 'number' ? timeRaw as number : Date.now()
	const label = fieldString(row, 'label')
	const existing: Conversation | null = conversationOf(id)
	ensurePins()
	return {
		id: id,
		title: label.length > 0 ? label : t('conv.newChat'),
		workspace: workspaceKeyOf(root),
		pinned: pinnedIds.has(id),
		updatedAt: updatedAt,
		// 已加载的历史/进行中的流不被列表刷新覆盖
		messages: existing != null ? existing.messages : []
	}
}

/**
 * 拉全局区 + 各项目区会话。项目根路径来源：全局区行内出现过的 projectRoot
 * （内核全局列表已剔除绑定项目的会话，正常为空）+ 已知项目区清单（持久于 useWorkspaces，
 * 设备切换时清空）。任一区失败不拖垮整体，但记录 listError 供 UI 提示。
 */
export async function refreshConversations(): Promise<void> {
	const devices = useDevices()
	if (!gworkSignedIn().value || devices.activeDeviceId.value.length === 0) {
		conversations.value = []
		activeConvId.value = ''
		return
	}
	if (listLoading.value) return
	listLoading.value = true
	const gen: number = refreshGen
	try {
		await ensureConnected(devices.activeDeviceId.value)
		const { projects } = useWorkspaces()
		// 契约 §4：工作区权威清单 = 桌面注册的项目（/web/chat/projects，name+path）；
		// sessions 的 projectRoot 只作兜底补充，避免「桌面有项目但还没会话」时移动端看不见
		const named: WorkspaceOption[] = []
		try {
			const pbody: ApiBody = await request('GET', '/web/chat/projects')
			if (kernelOk(pbody) && Array.isArray(pbody.data)) {
				const prows = pbody.data as ApiBody[]
				for (let i = 0; i < prows.length; i++) {
					const ppath: string = fieldString(prows[i], 'path')
					if (ppath.length === 0) continue
					named.push({ name: fieldString(prows[i], 'name'), root: ppath })
				}
			}
		} catch (_) { /* 项目清单拉取失败不阻塞会话列表，兜底走 projectRoot */ }
		setProjectRoots([], named)
		const roots: string[] = ['']
		projects.value.forEach((item): void => {
			roots.push(item.root)
		})
		const collected: Conversation[] = []
		const seenRoots: Set<string> = new Set<string>()
		projects.value.forEach((item): void => {
			seenRoots.add(item.root)
		})
		let failed: boolean = false
		for (let i = 0; i < roots.length; i++) {
			const root: string = roots[i]
			let body: ApiBody
			try {
				body = await request('GET', '/web/chat/sessions', 'root=' + encodeURIComponent(root))
			} catch (_) {
				failed = true
				continue
			}
			if (!kernelOk(body)) {
				failed = true
				continue
			}
			const rows = body.data
			if (!Array.isArray(rows)) continue
			const items = rows as ApiBody[]
			for (let j = 0; j < items.length; j++) {
				const row = items[j]
				const rowRoot = fieldString(row, 'projectRoot')
				const effectiveRoot: string = rowRoot.length > 0 ? rowRoot : root
				if (effectiveRoot.length > 0) seenRoots.add(effectiveRoot)
				const conv = convFromSessionRow(row, effectiveRoot)
				if (conv != null) collected.push(conv)
			}
		}
		if (gen !== refreshGen) return
		const rootsList: string[] = []
		seenRoots.forEach((root: string): void => {
			rootsList.push(root)
		})
		setProjectRoots(rootsList, named)
		// 本地新建但尚未出现在服务端的会话（发送中）保留在头部
		const serverIds: Set<string> = new Set<string>()
		collected.forEach((item: Conversation): void => {
			serverIds.add(item.id)
		})
		const localOnly: Conversation[] = conversations.value.filter((item: Conversation): boolean => {
			return !serverIds.has(item.id) && (running.has(item.id) || item.messages.length > 0)
		})
		conversations.value = localOnly.concat(collected)
		if (activeConvId.value.length > 0 && conversationOf(activeConvId.value) == null) {
			activeConvId.value = conversations.value.length > 0 ? conversations.value[0].id : ''
		}
		listError.value = failed ? t('chat.loadFailed') : ''
		// 断线期间设备端可能已续跑：对进行中的会话补帧
		resumeRunning()
	} catch (err: any) {
		if (gen !== refreshGen) return
		listError.value = err instanceof Error ? err.message : t('chat.loadFailed')
	} finally {
		if (gen === refreshGen) listLoading.value = false
	}
}

/* ---------------- 历史懒加载 ---------------- */

function messageFromHistoryRow(row: ApiBody): ChatMessage {
	const role = fieldString(row, 'role')
	return {
		id: nextMsgId(),
		role: role === 'USER' ? 'user' : 'ai',
		text: fieldString(row, 'content'),
		meta: '',
		status: 'done',
		thinking: false
	}
}

async function loadMessages(id: string): Promise<void> {
	if (loaded.has(id) || running.has(id)) return
	const devices = useDevices()
	if (devices.activeDeviceId.value.length === 0) return
	const conv: Conversation | null = conversationOf(id)
	if (conv == null) return
	// 加载态复用 thinking 语义：AI 占位气泡渲染 loading（契约 v1 无独立加载态字段）
	const placeholder: ChatMessage = { id: nextMsgId(), role: 'ai', text: '', meta: '', status: 'processing', thinking: true }
	conv.messages = [placeholder]
	try {
		await ensureConnected(devices.activeDeviceId.value)
		const body: ApiBody = await request('GET', '/web/chat/messages', 'sessionId=' + encodeURIComponent(id), '', rootOf(conv))
		const current: Conversation | null = conversationOf(id)
		if (current == null) return
		if (!kernelOk(body) || !Array.isArray(body.data)) {
			current.messages = []
			toast('chat.loadFailed')
			return
		}
		const rows = body.data as ApiBody[]
		const list: ChatMessage[] = []
		for (let i = 0; i < rows.length; i++) {
			const msg = messageFromHistoryRow(rows[i])
			if (msg.role === 'ai' && msg.text.length === 0) continue
			list.push(msg)
		}
		current.messages = list
		loaded.add(id)
		// 历史加载后发现设备端仍在跑：replay 尾帧接上 live 流
		await probeRunning(id)
	} catch (_) {
		const current: Conversation | null = conversationOf(id)
		if (current != null) current.messages = []
		toast('chat.loadFailed')
	}
}

/** 打开会话时探测设备端是否有进行中的轮次，有则接流（replay afterSeq=0 只取运行态） */
async function probeRunning(id: string): Promise<void> {
	const conv: Conversation | null = conversationOf(id)
	if (conv == null) return
	// 已在接流（busy 分支二次进入 / 历史加载后重复探测）不重复探测：
	// 否则会重置 startedAt 并二次 replay，耗时统计与缓冲管理都会被打乱
	if (running.has(id)) return
	try {
		const body: ApiBody = await request('GET', '/web/chat/replay', 'sessionId=' + encodeURIComponent(id) + '&afterSeq=0&limit=1', '', rootOf(conv))
		if (!kernelOk(body)) return
		const data = body.data != null && typeof body.data === 'object' ? body.data as ApiBody : {}
		if (data.running !== true) return
		const cursor = cursorOf(id)
		cursor.runId = fieldString(data, 'runId')
		cursor.startedAt = Date.now()
		running.add(id)
		onFrame(id, (sessionId: string, frame: LinkFrame): void => {
			handleStreamFrame(sessionId, frame)
		})
		appendStreamingPlaceholder(conv)
		replayFrom(id, 0)
	} catch (_) {
		// 探测失败不打扰：用户发送时会再走 ensureConnected
	}
}

/* ---------------- 帧消费 ---------------- */

function lastAiMessage(conv: Conversation): ChatMessage | null {
	for (let i = conv.messages.length - 1; i >= 0; i--) {
		const msg: ChatMessage = conv.messages[i]
		if (msg.role === 'ai') return msg
	}
	return null
}

/** 追加流式占位（processing/thinking）；已有进行中的尾条则复用 */
function appendStreamingPlaceholder(conv: Conversation): void {
	const last: ChatMessage | null = lastAiMessage(conv)
	if (last != null && last.status === 'processing') return
	const aiMsg: ChatMessage = { id: nextMsgId(), role: 'ai', text: '', meta: '', status: 'processing', thinking: true }
	conv.messages.push(aiMsg)
}

function consumeFrame(sessionId: string, frame: LinkFrame): void {
	const conv: Conversation | null = conversationOf(sessionId)
	if (conv == null) return
	const cursor = cursorOf(sessionId)
	const seqRaw = frame.eventSeq
	const seq: number = typeof seqRaw === 'number' ? seqRaw as number : 0
	// eventSeq 去重（replay 与 live 重叠、多端广播重复）
	if (seq > 0 && seq <= cursor.lastSeq) return
	if (seq > 0) cursor.lastSeq = seq
	const runId = fieldString(frame, 'runId')
	if (runId.length > 0) cursor.runId = runId
	const kind = fieldString(frame, 'type')

	// 手动停止后设备端仍可能吐出少量在途帧：不再复活占位（done/error 只做收口清理）
	if (!running.has(sessionId) && kind !== 'done' && kind !== 'error') {
		const tail: ChatMessage | null = lastAiMessage(conv)
		if (tail != null && tail.status === 'stopped') return
	}

	if (kind === 'text') {
		const msg: ChatMessage | null = ensureStreamingTail(conv)
		if (msg == null) return
		msg.thinking = false
		msg.text += fieldString(frame, 'text')
		conv.updatedAt = Date.now()
		return
	}
	if (kind === 'reason_start' || kind === 'reason') {
		// v1 不渲染思考正文，仅维持 thinking 态
		ensureStreamingTail(conv)
		return
	}
	if (kind === 'action_start') {
		const msg: ChatMessage | null = ensureStreamingTail(conv)
		if (msg == null) return
		const tool = fieldString(frame, 'toolName')
		msg.meta = t('chat.metaTool', { name: tool.length > 0 ? tool : '…' })
		return
	}
	if (kind === 'action_args' || kind === 'action_end') {
		return
	}
	if (kind === 'question' || kind === 'hitl') {
		const msg: ChatMessage | null = ensureStreamingTail(conv)
		if (msg == null) return
		msg.meta = t('chat.pendingDesktop')
		return
	}
	if (kind === 'question_answered' || kind === 'hitl_released') {
		const msg: ChatMessage | null = lastAiMessage(conv)
		if (msg != null && msg.status === 'processing') msg.meta = ''
		return
	}
	if (kind === 'done') {
		const msg: ChatMessage | null = lastAiMessage(conv)
		running.delete(sessionId)
		if (msg != null && msg.status === 'processing') {
			msg.thinking = false
			msg.status = 'done'
			if (frame.suspended === true) {
				msg.meta = t('chat.pendingDesktop')
			} else {
				const elapsed: number = cursor.startedAt > 0 ? Math.max(1, Math.round((Date.now() - cursor.startedAt) / 1000)) : 1
				msg.meta = t('chat.metaDone', { n: elapsed.toString() })
			}
		}
		conv.updatedAt = Date.now()
		return
	}
	if (kind === 'error') {
		const msg: ChatMessage | null = ensureStreamingTail(conv)
		running.delete(sessionId)
		if (msg != null) {
			msg.thinking = false
			msg.status = 'stopped'
			const desc = fieldString(frame, 'text')
			msg.meta = desc.length > 0 ? desc : t('chat.metaError')
		}
		conv.updatedAt = Date.now()
		return
	}
	// user / todos / usage 等其余帧 v1 不消费
}

/** 帧到达时保证有可写的 processing 尾条（replay 先于占位到达的场景） */
function ensureStreamingTail(conv: Conversation): ChatMessage | null {
	const last: ChatMessage | null = lastAiMessage(conv)
	if (last != null && last.status === 'processing') return last
	appendStreamingPlaceholder(conv)
	// 回读 proxy：push 后必须从响应式数组取，直接持有 push 前对象不触发视图更新
	return conv.messages[conv.messages.length - 1]
}

/** 补帧期间到达的 live 帧先缓冲：若直接消费会把游标推过未取回的中间分页，
 * afterSeq 跳过整段正文（桌面 app-streaming.js recoverStreamingSession 同款策略）。
 * replay 分页拉全后按 eventSeq 升序回放，重叠由 consumeFrame 去重兜底。 */
const replayBuffers: Map<string, LinkFrame[]> = new Map<string, LinkFrame[]>()

function handleStreamFrame(id: string, frame: LinkFrame): void {
	const buffer: LinkFrame[] | undefined = replayBuffers.get(id)
	if (buffer != null) {
		// 护栏：病态流缓冲上限 2 万帧，超出丢弃最旧（replay 终会补回）
		if (buffer.length >= 20000) buffer.shift()
		buffer.push(frame)
		return
	}
	consumeFrame(id, frame)
}

/** 断线重连补帧：afterSeq=lastSeq 起继续；分页只看 hasMore（内核 After 分支的
 * latestSeq=本页末帧 seq，不是全文件最大 seq，不能拿它当续拉判据——桌面先例
 * app-streaming.js:1939 同样只看 hasMore）。游标只由 replay 页推进；
 * running=false 时收口占位。 */
async function replayFrom(id: string, afterSeq: number): Promise<void> {
	let cursorSeq: number = afterSeq
	replayBuffers.set(id, [])
	try {
		// 页数护栏：单页 500 帧，最多 40 页（2 万帧），防病态流打爆链路
		for (let page = 0; page < 40; page++) {
			const pageConv: Conversation | null = conversationOf(id)
			if (pageConv == null) return
			const body: ApiBody = await request('GET', '/web/chat/replay', 'sessionId=' + encodeURIComponent(id) + '&afterSeq=' + cursorSeq.toString() + '&limit=500', '', rootOf(pageConv))
			if (!kernelOk(body)) return
			const data = body.data != null && typeof body.data === 'object' ? body.data as ApiBody : {}
			const events = data.events
			let pageMax: number = cursorSeq
			if (Array.isArray(events)) {
				const frames = events as LinkFrame[]
				for (let i = 0; i < frames.length; i++) {
					consumeFrame(id, frames[i])
					const seqRaw = frames[i].eventSeq
					const seq: number = typeof seqRaw === 'number' ? seqRaw as number : 0
					if (seq > pageMax) pageMax = seq
				}
			}
			cursorSeq = pageMax
			const runId = fieldString(data, 'runId')
			if (runId.length > 0) cursorOf(id).runId = runId
			if (data.hasMore === true) continue
			// 分页补齐：回放缓冲的 live 帧（升序；与 replay 重叠段被 eventSeq 去重）
			const buffered: LinkFrame[] | undefined = replayBuffers.get(id)
			if (buffered != null) {
				buffered.sort((a: LinkFrame, b: LinkFrame): number => {
					const sa = a.eventSeq
					const sb = b.eventSeq
					const na: number = typeof sa === 'number' ? sa as number : 0
					const nb: number = typeof sb === 'number' ? sb as number : 0
					return na - nb
				})
				for (let i = 0; i < buffered.length; i++) {
					consumeFrame(id, buffered[i])
				}
			}
			if (data.running !== true && running.has(id)) {
				// 设备端已结束但 done 帧没赶上：按 replay 结果收口
				const current: Conversation | null = conversationOf(id)
				running.delete(id)
				if (current != null) {
					const msg: ChatMessage | null = lastAiMessage(current)
					if (msg != null && msg.status === 'processing') {
						msg.thinking = false
						msg.status = 'done'
						msg.meta = t('chat.metaDone', { n: '1' })
					}
				}
			}
			return
		}
	} catch (_) {
		// 补帧失败保持占位，用户可停止或重发
	} finally {
		// 任何退出路径（完成/失败/会话已删/页数护栏）都必须撤缓冲，
		// 否则该会话后续 live 帧会被永远吞掉
		replayBuffers.delete(id)
	}
}



function resumeRunning(): void {
	running.forEach((id: string): void => {
		replayFrom(id, cursorOf(id).lastSeq)
	})
}

/* ---------------- 发送 / 停止 ---------------- */

function sendMessage(id: string, text: string): void {
	const conv: Conversation | null = conversationOf(id)
	if (conv == null) return
	if (!gworkSignedIn().value) {
		toast('chat.loginRequired')
		return
	}
	const devices = useDevices()
	if (devices.activeDeviceId.value.length === 0) {
		toast('chat.deviceRequired')
		return
	}
	if (!devices.deviceOnline.value) {
		toast('chat.deviceOffline')
		return
	}
	// 数据层兜底：processing 期间拒绝再发（UI 层已把发送按钮换成停止按钮）
	if (isProcessing(id)) {
		toast('chat.busySend')
		return
	}
	const content: string = text.trim()
	const userMsg: ChatMessage = { id: nextMsgId(), role: 'user', text: content, meta: '', status: 'done', thinking: false }
	conv.messages.push(userMsg)
	conv.updatedAt = Date.now()
	const aiMsg: ChatMessage = { id: nextMsgId(), role: 'ai', text: '', meta: '', status: 'processing', thinking: true }
	conv.messages.push(aiMsg)
	// 先占 running：连接期间 UI 立即出停止按钮，且防重复发送
	running.add(id)
	const cursor = cursorOf(id)
	cursor.startedAt = Date.now()
	cursor.lastSeq = 0
	cursor.runId = ''
	onFrame(id, (sessionId: string, frame: LinkFrame): void => {
		handleStreamFrame(sessionId, frame)
	})
	const root: string = rootOf(conv)
	const payload: ApiBody = { sessionId: id, input: content, accessMode: accessModeNow() }
	ensureConnected(devices.activeDeviceId.value).then((): Promise<ApiBody> => {
		return request('POST', '/web/chat/input', '', JSON.stringify(payload), root)
	}).then((body: ApiBody): void => {
		if (!kernelOk(body)) {
			failSend(id, fieldString(body, 'description'))
			return
		}
		// 忙时 data:"busy"（他端同会话在跑）：本轮 input 未受理（消息不落设备端），
		// 但设备端正有进行中的轮次——接上它的 live 流并 replay 补帧（继续任务场景），
		// 而不是只弹提示后留一个空白会话。
		if (typeof body.data === 'string' && body.data === 'busy') {
			toast('chat.busySend')
			probeRunning(id)
			return
		}
		loaded.add(id)
	}, (err: any): void => {
		failSend(id, err instanceof Error ? err.message : '')
	})
}



function failSend(id: string, detail: string): void {
	running.delete(id)
	const conv: Conversation | null = conversationOf(id)
	if (conv != null) {
		const last: ChatMessage | null = lastAiMessage(conv)
		if (last != null && last.status === 'processing') {
			last.thinking = false
			last.status = 'stopped'
			last.meta = detail.length > 0 ? detail : t('chat.metaError')
		}
	}
	toast('chat.sendFailed')
}

/** 手动停止：interrupt form sessionId&runId；turn_changed 用返回 runId 重试一次 */
function stopMessage(id: string): void {
	if (!isProcessing(id)) return
	const conv: Conversation | null = conversationOf(id)
	if (conv == null) return
	const devices = useDevices()
	if (devices.activeDeviceId.value.length === 0) return
	const cursor = cursorOf(id)
	const root: string = rootOf(conv)
	const doInterrupt = (runId: string): Promise<ApiBody> => {
		const form: string = 'sessionId=' + encodeURIComponent(id) + '&runId=' + encodeURIComponent(runId)
		return request('POST', '/web/chat/interrupt', '', form, root, 'application/x-www-form-urlencoded')
	}
	ensureConnected(devices.activeDeviceId.value).then((): Promise<ApiBody> => {
		return doInterrupt(cursor.runId)
	}).then((body: ApiBody): Promise<ApiBody> => {
		if (!kernelOk(body)) return Promise.resolve(body)
		const data = body.data != null && typeof body.data === 'object' ? body.data as ApiBody : {}
		if (fieldString(data, 'status') === 'turn_changed') {
			const authoritative = fieldString(data, 'runId')
			cursor.runId = authoritative
			return doInterrupt(authoritative)
		}
		return Promise.resolve(body)
	}).then((_body: ApiBody): void => {
		markStopped(id)
	}, (_err: any): void => {
		// 中断请求失败也落本地停止态：用户意图明确，设备端 done 帧若再来会被状态守卫忽略
		markStopped(id)
	})
}

function markStopped(id: string): void {
	running.delete(id)
	const conv: Conversation | null = conversationOf(id)
	if (conv == null) return
	const last: ChatMessage | null = lastAiMessage(conv)
	if (last != null && last.status === 'processing') {
		last.status = 'stopped'
		last.thinking = false
		last.meta = t('chat.metaStopped')
	}
	conv.updatedAt = Date.now()
}

/* ---------------- 会话管理 ---------------- */

function setActive(id: string): void {
	activeConvId.value = id
	loadMessages(id)
}

function createConversation(workspace: string, firstText?: string): string {
	const conv: Conversation = {
		id: newConvId(),
		title: firstText != null && firstText.length > 0 ? titleFromText(firstText) : t('conv.newChat'),
		workspace: workspace,
		pinned: false,
		updatedAt: Date.now(),
		messages: []
	}
	conversations.value = [conv].concat(conversations.value)
	activeConvId.value = conv.id
	// 本地即视为已加载：历史拉取会把乐观渲染的用户消息冲掉
	loaded.add(conv.id)
	return conv.id
}

function renameConversation(id: string, title: string): void {
	const trimmed: string = title.trim()
	if (trimmed.length === 0) return
	const conv: Conversation | null = conversationOf(id)
	if (conv == null) return
	conversations.value = conversations.value.map((item: Conversation): Conversation => {
		if (item.id !== id) return item
		return { id: item.id, title: trimmed, workspace: item.workspace, pinned: item.pinned, updatedAt: item.updatedAt, messages: item.messages }
	})
	const devices = useDevices()
	if (devices.activeDeviceId.value.length === 0) return
	// 内核 RenameForm：label 为主字段（title 兼容），root 路由项目目录
	const form: string = 'sessionId=' + encodeURIComponent(id) + '&label=' + encodeURIComponent(trimmed) + '&root=' + encodeURIComponent(rootOf(conv))
	ensureConnected(devices.activeDeviceId.value).then((): Promise<ApiBody> => {
		return request('POST', '/web/chat/sessions/rename', '', form, rootOf(conv), 'application/x-www-form-urlencoded')
	}).then((body: ApiBody): void => {
		if (!kernelOk(body)) toast('chat.loadFailed')
	}, (): void => {
		toast('chat.loadFailed')
	})
}

function togglePin(id: string): boolean {
	ensurePins()
	let pinned: boolean = false
	conversations.value = conversations.value.map((item: Conversation): Conversation => {
		if (item.id !== id) return item
		pinned = !item.pinned
		return { id: item.id, title: item.title, workspace: item.workspace, pinned: pinned, updatedAt: item.updatedAt, messages: item.messages }
	})
	if (pinned) {
		pinnedIds.add(id)
	} else {
		pinnedIds.delete(id)
	}
	persistPins()
	return pinned
}

/** 删除后若是当前会话，activeConv 落到第一条（设计稿行为） */
function removeConversation(id: string): void {
	const conv: Conversation | null = conversationOf(id)
	running.delete(id)
	cursors.delete(id)
	loaded.delete(id)
	replayBuffers.delete(id)
	offFrame(id)
	if (pinnedIds.has(id)) {
		pinnedIds.delete(id)
		persistPins()
	}
	const rest: Conversation[] = conversations.value.filter((item: Conversation): boolean => item.id !== id)
	conversations.value = rest
	if (activeConvId.value === id) {
		activeConvId.value = rest.length > 0 ? rest[0].id : ''
	}
	if (conv == null) return
	const devices = useDevices()
	if (devices.activeDeviceId.value.length === 0) return
	// 内核 delete 接受 query 或 form；显式 root 防止项目会话按全局区解析而漏删
	const form: string = 'sessionId=' + encodeURIComponent(id) + '&root=' + encodeURIComponent(rootOf(conv))
	ensureConnected(devices.activeDeviceId.value).then((): Promise<ApiBody> => {
		return request('POST', '/web/chat/sessions/delete', '', form, rootOf(conv), 'application/x-www-form-urlencoded')
	}).then((body: ApiBody): void => {
		if (!kernelOk(body)) {
			toast('chat.loadFailed')
			refreshConversations()
		}
	}, (): void => {
		toast('chat.loadFailed')
	})
}

/* ---------------- 设备/登录态联动 ---------------- */

/** 设备切换/登出：清会话缓存与流订阅，再按新设备拉列表（useDevices 单向驱动，无循环依赖） */
function resetForDeviceChange(): void {
	refreshGen += 1
	listLoading.value = false
	running.forEach((id: string): void => {
		offFrame(id)
	})
	running.clear()
	cursors.clear()
	loaded.clear()
	replayBuffers.clear()
	conversations.value = []
	activeConvId.value = ''
	listError.value = ''
	clearWorkspaces()
}

function ensureWatchers(): void {
	if (watching) return
	watching = true
	const devices = useDevices()
	watch(devices.activeDeviceId, (_id: string): void => {
		resetForDeviceChange()
		if (gworkSignedIn().value && devices.activeDeviceId.value.length > 0) {
			refreshConversations()
		}
	})
	watch(gworkSignedIn(), (signedIn: boolean): void => {
		if (!signedIn) {
			resetForDeviceChange()
			return
		}
		// 登录成功但设备清单尚未回来：activeDeviceId watch 会接力触发
		if (devices.activeDeviceId.value.length > 0) refreshConversations()
	})
	// 冷启动：登录态在首个 hook 调用前已恢复且设备 id 来自 storage（watch 追不上），
	// 对「已登录+有设备+列表为空」补一次拉取；refreshConversations 自带 loading 去重
	if (gworkSignedIn().value && devices.activeDeviceId.value.length > 0 && conversations.value.length === 0) {
		refreshConversations()
	}
	onDeviceOffline((): void => {
		// 链路已断（后台 4001）：进行中的会话保持占位，重连成功后 replay 续流
		listError.value = t('chat.deviceOffline')
	})
}

export function useConversations(): Conversations {
	ensureWatchers()

	const activeConversation: ComputedRef<Conversation | null> = computed<Conversation | null>((): Conversation | null => {
		return conversationOf(activeConvId.value)
	})

	const defaultConversations: ComputedRef<Conversation[]> = computed<Conversation[]>((): Conversation[] => {
		return sortInWorkspace(conversations.value.filter((item: Conversation): boolean => item.workspace === DEFAULT_WORKSPACE))
	})

	function conversationsOf(workspace: string): Conversation[] {
		return sortInWorkspace(conversations.value.filter((item: Conversation): boolean => item.workspace === workspace))
	}

	return {
		conversations,
		activeConvId,
		activeConversation,
		defaultConversations,
		conversationsOf,
		setActive,
		createConversation,
		renameConversation,
		togglePin,
		removeConversation,
		sendMessage,
		stopMessage,
		refresh: refreshConversations,
		listLoading,
		listError
	}
}
