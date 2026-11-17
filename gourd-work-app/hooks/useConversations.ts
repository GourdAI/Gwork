/**
 * 会话域模型的跨页面共享状态：会话列表、当前会话、消息、置顶。
 *
 * 当前为演示数据 + 模拟流式回复（思考中 → 按字吐正文 → 完成/停止，行为对齐 uni-ai-x 状态机），
 * 接入真实后端时仅需替换 createConversation / sendMessage / stopMessage 的数据来源。
 */
import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { i18n } from '@/locale/i18n.ts'
import { DEFAULT_WORKSPACE } from '@/data/app-data'
import type { ChatMessage, Conversation } from '@/data/app-data'

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
}

const conversations: Ref<Conversation[]> = ref<Conversation[]>(buildSeedConversations())
const activeConvId: Ref<string> = ref<string>(conversations.value[0].id)

let seq: number = conversations.value.length

// 模拟流式回复的进行中定时器（thinking 阶段 setTimeout、吐字阶段 setInterval 共用一个槽位）。
// 与 uni-ai-x 的会话级 processing 一致：同一会话同时只允许一轮回复；用 Map 而非 Record，
// UTS/Kotlin 侧对对象字面量的 delete 不可靠
const activeStreams: Map<string, number> = new Map<string, number>()

function nextId(): string {
	seq += 1
	return 'c' + seq.toString()
}

function mockId(): string {
	seq += 1
	return 'm' + seq.toString()
}

function t(key: string, values?: Record<string, string>): string {
	if (values == null) return i18n.global.t(key)
	return i18n.global.t(key, values)
}

/** 演示会话：与设计稿一致，updatedAt 取相对当前时刻的偏移，保证相对时间合理 */
function seed(id: string, workspace: string, title: string, minutesAgo: number, pinned: boolean = false): Conversation {
	return {
		id,
		title,
		workspace,
		pinned,
		updatedAt: Date.now() - minutesAgo * 60000,
		messages: []
	}
}

function buildSeedConversations(): Conversation[] {
	return [
		seed('c1', DEFAULT_WORKSPACE, '今天天气如何？', 0),
		seed('c2', DEFAULT_WORKSPACE, '设计移动端APP', 0),
		seed('c3', DEFAULT_WORKSPACE, '你好', 10),
		seed('c4', DEFAULT_WORKSPACE, '询问如何签到 GWork', 34),
		seed('c5', '2026-08-15-16-14-35', '为 GWork 设计 logo 动物形象', 60),
		seed('c6', '2026-08-15-16-14-35', '123', 60),
		seed('c7', '助理', 'GWork和trae是否支持减席位', 18 * 60),
		seed('c8', '助理', '为企业后台原型添加模型管理功能', 4 * 24 * 60)
	]
}

function conversationOf(id: string): Conversation | null {
	const found: Conversation | undefined = conversations.value.find((item: Conversation): boolean => item.id === id)
	return found ?? null
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

export function useConversations(): Conversations {
	const activeConversation: ComputedRef<Conversation | null> = computed<Conversation | null>((): Conversation | null => {
		return conversationOf(activeConvId.value)
	})

	const defaultConversations: ComputedRef<Conversation[]> = computed<Conversation[]>((): Conversation[] => {
		return sortInWorkspace(conversations.value.filter((item: Conversation): boolean => item.workspace === DEFAULT_WORKSPACE))
	})

	function conversationsOf(workspace: string): Conversation[] {
		return sortInWorkspace(conversations.value.filter((item: Conversation): boolean => item.workspace === workspace))
	}

	function setActive(id: string): void {
		activeConvId.value = id
	}

	function createConversation(workspace: string, firstText?: string): string {
		const conv: Conversation = {
			id: nextId(),
			title: firstText != null && firstText.length > 0 ? titleFromText(firstText) : t('conv.newChat'),
			workspace,
			pinned: false,
			updatedAt: Date.now(),
			messages: []
		}
		conversations.value = [conv].concat(conversations.value)
		activeConvId.value = conv.id
		return conv.id
	}

	function renameConversation(id: string, title: string): void {
		const trimmed: string = title.trim()
		if (trimmed.length === 0) return
		conversations.value = conversations.value.map((item: Conversation): Conversation => {
			if (item.id !== id) return item
			return { id: item.id, title: trimmed, workspace: item.workspace, pinned: item.pinned, updatedAt: item.updatedAt, messages: item.messages }
		})
	}

	function togglePin(id: string): boolean {
		let pinned: boolean = false
		conversations.value = conversations.value.map((item: Conversation): Conversation => {
			if (item.id !== id) return item
			pinned = !item.pinned
			return { id: item.id, title: item.title, workspace: item.workspace, pinned, updatedAt: item.updatedAt, messages: item.messages }
		})
		return pinned
	}

	/** 删除后若是当前会话，activeConv 落到第一条（设计稿行为）；删除时回收进行中的模拟流定时器 */
	function removeConversation(id: string): void {
		clearStream(id)
		const rest: Conversation[] = conversations.value.filter((item: Conversation): boolean => item.id !== id)
		conversations.value = rest
		if (activeConvId.value === id) {
			activeConvId.value = rest.length > 0 ? rest[0].id : ''
		}
	}

	function clearStream(id: string): void {
		const timer: number | undefined = activeStreams.get(id)
		if (timer == null) return
		clearInterval(timer)
		clearTimeout(timer)
		activeStreams.delete(id)
	}

	/** 会话是否有一轮回复仍在进行（含思考中），发送入口据此禁止重复发送 */
	function isProcessing(id: string): boolean {
		return activeStreams.has(id)
	}

	/** 手动停止：对齐 uni-ai-x 的 state='stop' + abortRequest——保留已吐出的内容并落停止态 */
	function stopMessage(id: string): void {
		if (!isProcessing(id)) return
		clearStream(id)
		const conv: Conversation | null = conversationOf(id)
		if (conv == null || conv.messages.length === 0) return
		const last: ChatMessage = conv.messages[conv.messages.length - 1]
		if (last.role !== 'ai' || last.status !== 'processing') return
		last.status = 'stopped'
		last.thinking = false
		last.meta = t('chat.metaStopped')
		conv.updatedAt = Date.now()
	}

	function sendMessage(id: string, text: string): void {
		const conv: Conversation | null = conversationOf(id)
		if (conv == null) return
		// 数据层兜底：processing 期间拒绝再发（UI 层已把发送按钮换成停止按钮，对齐 uni-ai-x）
		if (isProcessing(id)) {
			uni.showToast({ title: t('chat.busySend'), icon: 'none' })
			return
		}
		const userMsg: ChatMessage = { id: mockId(), role: 'user', text: text.trim(), meta: '', status: 'done', thinking: false }
		conv.messages.push(userMsg)
		conv.updatedAt = Date.now()
		const prefix: string = text.trim().length > 28 ? text.trim().slice(0, 28) + '…' : text.trim()
		const full: string = t('chat.mockReply', { text: prefix })
		const aiMsg: ChatMessage = { id: mockId(), role: 'ai', text: '', meta: '', status: 'processing', thinking: true }
		conv.messages.push(aiMsg)
		conv.updatedAt = Date.now()
		// 流式期间要持续改写消息，必须从响应式数组回读 proxy 再持有：
		// 闭包若捕获 push 前的原始对象，属性变更不会触发视图更新（Vue 3 响应式边界）
		const reactiveAiMsg: ChatMessage = conv.messages[conv.messages.length - 1]
		startMockStream(id, conv, reactiveAiMsg, full)
	}

	/** 模拟 uni-ai-x 流式：先思考约 1s（loading），再按 40ms/3 字吐正文，完成后落 done + 耗时 meta */
	function startMockStream(id: string, conv: Conversation, aiMsg: ChatMessage, full: string): void {
		const startedAt: number = Date.now()
		activeStreams.set(id, setTimeout((): void => {
			aiMsg.thinking = false
			let cursor: number = 0
			activeStreams.set(id, setInterval((): void => {
				cursor += 3
				aiMsg.text = full.slice(0, cursor)
				if (cursor >= full.length) {
					clearStream(id)
					aiMsg.status = 'done'
					aiMsg.meta = t('chat.metaDone', { n: Math.max(1, Math.round((Date.now() - startedAt) / 1000)).toString() })
					conv.updatedAt = Date.now()
				}
			}, 40))
		}, 1000))
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
		stopMessage
	}
}
