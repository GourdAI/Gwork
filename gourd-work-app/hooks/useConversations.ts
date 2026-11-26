/**
 * 会话域模型的跨页面共享状态：会话列表、当前会话、消息、置顶。
 *
 * 真实链路（契约 .gwork/mobile-link/PROTOCOL.md §4）：列表/历史/发送/停止/改名/删除
 * 经 utils/gwork-link 的 WS 中转打到桌面内核 /web/chat/*；流式正文消费 frame 信封
 * （text 增量拼最终正文；reason / action_* / agent_* / question / hitl 落结构化过程卡；done/error 收口）。
 * eventSeq 每会话去重；断线后对进行中的会话 replay?afterSeq= 补帧再续。
 * 置顶内核无端点，本地 storage 持久化（保留设计稿组内重排行为）。
 *
 * UTS 响应式纪律：流式改写必须从响应式数组回读 proxy 再持有（见 sendMessage 尾注），
 * 闭包捕获 push 前的原始对象不会触发视图更新。
 */
import { computed, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { i18n } from '@/locale/i18n.ts'
import { fieldString, formatElapsed, formatBatchElapsed, formatMsgTime } from '@/utils/tools.ts'
import { bareToolName, resolveToolLabel } from '@/utils/tool-presentation.ts'
import { gworkSignedIn } from '@/utils/gwork-auth.ts'
import { ensureConnected, request, kernelOk, onFrame, offFrame, onDeviceOffline, onLinkResumed } from '@/utils/gwork-link.ts'
import type { LinkFrame } from '@/utils/gwork-link.ts'
import { useDevices } from '@/hooks/useDevices'
import { useRunEnv, inheritSelectionToSession, skillPrefix } from '@/hooks/useRunEnv'
import type { ModelConfig } from '@/hooks/useRunEnv'
import { useWorkspaces, setProjectRoots, clearWorkspaces } from '@/hooks/useWorkspaces'
import { DEFAULT_WORKSPACE } from '@/data/app-data'
import type { ApiBody } from '@/utils/request.ts'
import type { AskAnswer, AskOption, AskQuestion, ChatBlock, ChatBlockKind, ChatBlockStatus, ChatFileChange, ChatMessage, ChatMsgStatus, Conversation, PendingAttachment, SkillOption, WorkspaceOption } from '@/data/app-data'

export type Conversations = {
	conversations: Ref<Conversation[]>
	activeConvId: Ref<string>
	activeConversation: ComputedRef<Conversation | null>
	defaultConversations: ComputedRef<Conversation[]>
	conversationsOf: (workspace: string) => Conversation[]
	setActive: (id: string) => void
	createConversation: (workspace: string, firstText?: string) => { id: string; ready: Promise<void> }
	renameConversation: (id: string, title: string) => void
	togglePin: (id: string) => boolean
	removeConversation: (id: string) => void
	/** 发送。返回 false = 未受理（校验拦截/超限），调用方必须保留草稿与附件；
	 *  受理后的异步失败（busy/网络）经 onFail 回调回填「当时实际发送的正文与附件」。 */
	sendMessage: (id: string, text: string, ready?: Promise<void>, attachments?: PendingAttachment[], onFail?: (text: string, atts: PendingAttachment[]) => void) => boolean
	stopMessage: (id: string) => void
	/** 审批：同意/拒绝挂起中的 HITL（actionId 为空时按会话内最后一张待审批卡提交） */
	approveHitl: (id: string, actionId: string, approved: boolean) => void
	/** 问答：把整卡作答态一次性提交给内核 */
	answerQuestion: (id: string, actionId: string) => void
	/** 更新某题作答态（UI 选项点击 / 自由输入 / 跳过都走这里） */
	setQuestionAnswer: (id: string, actionId: string, index: number, patch: AskAnswer) => void
	/** 列表刷新（登录/选设备后自动触发；下拉/重试可手动调） */
	refresh: () => Promise<void>
	/** 历史回放降级后重试：幂等清掉本次快照并重新走 replay 帧重建 */
	retryHistory: (id: string) => void
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
/** 历史加载在途（会话 id → Promise）：
 *  一次点击会同步触发两次 setActive（抽屉 onOpenConv + 首页 onOpenConv），
 *  而 loaded.add 位于全部 await 之后。旧实现只靠 loaded/running 守卫，两次调用
 *  会各自清空 conv.messages、resetTurnState、replayFrom 全量回放并交错写同一数组，
 *  表现为「消息错乱 / 重复」。用 Promise 表在首个 await 之前占位即可幂等。 */
const loadingMessages: Map<string, Promise<void>> = new Map<string, Promise<void>>()
/** 进行中的会话（发送成功→done/error 之间），断线重连后据此 replay */
const running: Set<string> = new Set<string>()
/** 已渲染/已裁决的插话键（sessionId:steerId）：实时帧 + replay 补帧/断线重叠回放会重复
 *  下发同一 steerId，不登记会重复建插话气泡（桌面 steerResolved 同语义）。
 *  【必须带会话前缀且随 rebuildHistory 清除】桌面在会话 LRU 淘汰/重建时清空
 *  steerResolved，否则回放还原出的同一 steerId 被当「已处理」静默丢弃——插话气泡
 *  刷新后消失。移动端 rebuildHistory 会清空 conv.messages 全量重放，同步清本会话的键。 */
const steerResolved: Set<string> = new Set<string>()

function steerKey(sessionId: string, steerId: string): string {
	return sessionId + ':' + steerId
}

/** 会话消息即将整体重建（rebuildHistory）：作废本会话已登记的插话键，
 *  让 replay 能重新还原插话气泡（bubble 容器随 messages 一起清空了）。 */
function clearSteerResolved(sessionId: string): void {
	const prefix: string = sessionId + ':'
	const dead: string[] = []
	steerResolved.forEach((k: string): void => {
		if (k.indexOf(prefix) === 0) dead.push(k)
	})
	dead.forEach((k: string): void => { steerResolved.delete(k) })
}
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

/** 每轮按帧时序累积的轨迹状态：桌面端 sess.toolCardsById / agentStates / GourdTurnBatch 的等价物。
 *  Map 而非对象字面量：UTS/Kotlin 对 delete 不可靠（既有纪律）。 */
type TurnState = {
	reasonKey: string
	reasonOwner: string
	batchId: string
	batchOpen: boolean
	startedAt: number
	tools: number
	reasons: number
	agents: number
	batches: number
	/** 过程正文段数（工具/思考之间吐出的解释性 text），桌面 buildSummary 的 texts 口径 */
	texts: number
	/** 当前活跃正文段的过程块 id（'' = 尚无正文段）。
	 *  【时序修复】旧实现把全部 text 攒进 msg.text、只在「正文后又来过程帧」时把
	 *  已累积正文整体搬进过程区——过程区恒渲染在最终正文上方，于是工具执行【前】
	 *  吐出的正文（含产物文件链接/卡片）全被搬到工具行上方（用户报障「产物卡片
	 *  跑到正文上面」），且过程 text 走纯文本渲染，markdown 原文（含注释样式的
	 *  链接标签）直接裸露。现改为桌面「正文指针推进」同款：正文按帧时序分段成块，
	 *  过程行落在其所属段之后；收口时最后一段提升为 msg.text 最终正文。 */
	textKey: string
	toolStarts: Map<string, number>
	agentKeys: Map<string, string>
	/** 本轮「当前骨架卡」标识：action_draft 建卡后，后续不带 actionId 的
	 *  action_args / action_end 必须复用它，否则每帧新建一行（工具行堆叠真因）。 */
	pendingToolKey: string
	/** 当前运行批次的开盖时间戳：ensureProcessBatch 写入 head.startedAt（UI 层每秒 tick
	 *  显示「正在执行中 · Ns」），closeBatch 用它落整批耗时后清零。 */
	batchStartedAt: number
}
const turnStates: Map<string, TurnState> = new Map<string, TurnState>()

function turnStateOf(id: string): TurnState {
	let state: TurnState | undefined = turnStates.get(id)
	if (state == null) {
		state = {
			reasonKey: '', reasonOwner: '', batchId: '', batchOpen: false,
			startedAt: Date.now(), tools: 0, reasons: 0, agents: 0, batches: 0, texts: 0, textKey: '',
			toolStarts: new Map<string, number>(), agentKeys: new Map<string, string>(), pendingToolKey: '', batchStartedAt: 0
		}
		turnStates.set(id, state)
	}
	return state
}

function resetTurnState(id: string): void {
	// 轮重置＝正文缓冲作废（重试丢弃/新轮/回放重建都走这里）：
	// 在途 delta 属于被丢弃的旧尝试，落账会把废文本写进新轮
	dropTextBuf(id)
	turnStates.set(id, {
		reasonKey: '', reasonOwner: '', batchId: '', batchOpen: false,
		startedAt: Date.now(), tools: 0, reasons: 0, agents: 0, batches: 0, texts: 0, textKey: '',
		toolStarts: new Map<string, number>(), agentKeys: new Map<string, string>(), pendingToolKey: '', batchStartedAt: 0
	})
}

function nextBlockId(): string {
	msgSeq += 1
	return 'b' + msgSeq.toString()
}

function emptyChatMessage(id: string, role: 'user' | 'ai', text: string, status: ChatMsgStatus, thinking: boolean, steer: boolean): ChatMessage {
	return {
		id, role, text, meta: '', status, thinking,
		blocks: [], summary: '', compactOpen: false,
		counts: { tools: 0, reasons: 0, agents: 0, batches: 0, texts: 0 },
		degradedNotice: '',
		imageUrls: [],
		steer
	}
}

function emptyBlock(kind: ChatBlockKind, label: string, icon: string): ChatBlock {
	return {
		id: nextBlockId(), kind, label, icon, args: '', preview: '', body: '',
		status: 'loading', duration: '', startedAt: 0, failed: false,
		// agent（子智能体徽章）与 error/retry/qa/notice 一样不随 Compact 折叠：
		// 桌面徽章挂在气泡本体，不在 [data-turn-process] 容器内，收口后仍常驻
		process: kind !== 'error' && kind !== 'retry' && kind !== 'qa' && kind !== 'notice' && kind !== 'agent',
		batchId: '', batchCount: 0, batchCollapsed: false, agentName: '', actionId: '',
		interact: '', questions: [], answers: [], submitting: false, submitError: '',
		command: '', resolvedText: '', changes: [], changesOpen: false, rowOpen: false,
		bareTool: '', fileName: '', diffAdd: '', diffDel: '', thoughtTime: ''
	}
}

/** 按 key 查过程块【只在本轮流式尾气泡内查】。
 *
 *  【消息错乱真因】旧实现从 conv.messages 末尾向前扫描【全部】AI 消息，且匹配
 *  `item.actionId === key`、`item.agentName === key`。历史回放后同一会话里会有
 *  多轮消息，actionId / agentName 在多轮之间会重复（rerun、子智能体同名复用、
 *  断线重连重复下发），于是新一帧会命中【上一轮】的块并把内容写进去：
 *  表现就是「消息错乱」—— 新回复的思考/工具窜到几天前那条消息里，
 *  旧消息被改写、新消息空着。
 *  桌面端每个 run 只操作当前气泡（renderRoot(sess) 单容器），从不跨轮查。
 *  这里同口径：只查最后一条 AI 消息；尾条不存在时才回退全量（回放首帧场景）。 */
function blockOf(conv: Conversation, key: string): ChatBlock | null {
	const tail: ChatMessage | null = lastAiMessage(conv)
	// 【有尾条时绝不下探历史轮】块 id 会被 ensureBlock 覆写成 `tool:<actionId>` /
	// `agent:<invocationId>` 这类跨轮可复用的键，一旦允许「尾条没命中就扫旧轮」，
	// 新一轮的同名工具/同名子智能体就会命中几天前那条消息里的块并往里写。
	// 尾条不存在时同样不扫历史：ensureBlock 会走 ensureStreamingTail 建占位，
	// 根本不需要跨轮查找（桌面 renderRoot(sess) 同样只看当前容器）。
	if (tail == null) return null
	const hit: ChatBlock | undefined = tail.blocks.find((item: ChatBlock): boolean =>
		item.id === key || item.actionId === key || (item.agentName.length > 0 && item.agentName === key))
	return hit != null ? hit : null
}

function ensureBlock(conv: Conversation, key: string, kind: ChatBlockKind, label: string, icon: string): ChatBlock {
	const found: ChatBlock | null = blockOf(conv, key)
	if (found != null) return found
	const msg: ChatMessage = ensureStreamingTail(conv) as ChatMessage
	const state: TurnState = turnStateOf(conv.id)
	const block: ChatBlock = emptyBlock(kind, label, icon)
	block.id = key
	block.batchId = state.batchId
	if (kind === 'tool') state.tools += 1
	if (kind === 'thinking') state.reasons += 1
	if (kind === 'agent') state.agents += 1
	msg.blocks.push(block)
	// 回读 proxy：push 后必须从响应式数组取，直接持有原始对象不触发视图更新
	const fresh: ChatBlock = msg.blocks[msg.blocks.length - 1]
	/* 【code review 补洞 · 入口 sink 的帧内窗口】consumeFrame 入口的 sinkChangesBlocks
	   只在「本帧开始时」收敛一次；本帧内若有变更卡在尾（挂起段收口/上一帧迟到快照）
	   而本帧又新建块（HITL 审批卡/问答卡/重试/notice 等【非过程帧】不走帧末 sink），
	   push 会把新块排到卡片之后——下一帧入口才纠正，交互卡可能长时间停在卡下方
	   （挂起期没有后续帧）。在唯一建块漏斗处补一次幂等收敛（常态零写入）：
	   任何新块落地即保证卡片仍在过程区末尾。 */
	sinkChangesBlocks(msg)
	return fresh
}

/** 过程帧到来时保证处于一个运行批次（桌面 GourdTurnBatch.ensureBatch 同款）：
 *  连续过程帧共用同一盖子；正文 / 轮结束收口后，下一批过程帧再开新批次。 */
function ensureProcessBatch(conv: Conversation, label: string): void {
	const state: TurnState = turnStateOf(conv.id)
	if (state.batchOpen) return
	const msg: ChatMessage = ensureStreamingTail(conv) as ChatMessage
	state.batchId = nextBlockId()
	state.batchOpen = true
	state.batches += 1
	state.batchStartedAt = Date.now()
	const head: ChatBlock = emptyBlock('batch', label, 'bars')
	head.id = state.batchId
	head.batchId = state.batchId
	head.status = 'loading'
	head.startedAt = state.batchStartedAt
	// 【口径纠正 2026-11 用户澄清】「默认折叠」指的是工具/思考的【卡体全文】
	// （rowOpen=false，点行头才展开），不是批次盖子本身：运行中批次必须默认
	// 【展开】（PC createHeader data-batch-open='true' 同款，成员行可见、
	// 限高滚动窗贴底跟随），closeBatch 收口后才折叠成一行统计。
	// 旧实现开盖即 batchCollapsed=true → 「正在执行中」恒收起，看不到过程。
	head.batchCollapsed = false
	msg.blocks.push(head)
}

function closeBatch(conv: Conversation, failed: boolean): void {
	const state: TurnState = turnStateOf(conv.id)
	if (!state.batchOpen) return
	const msg: ChatMessage | null = lastAiMessage(conv)
	if (msg == null) {
		state.batchOpen = false
		state.batchId = ''
		return
	}
	// 成员数按「真实归属」统计：思考增量会重复到达、closeBatch/ensureProcessBatch 交替时
	// 计数器清零时机也难对齐，故直接数本批次实际挂载的成员块。
	let members: number = 0
	msg.blocks.forEach((item: ChatBlock): void => {
		if (item.kind !== 'batch' && item.batchId === state.batchId) members += 1
	})
	// PC 收口文案：「执行工具 N 次 · 思考 M 次」分类计数（穿透并行组），
	// 两项全 0 才回落「已处理」；收口后不显示耗时（PC labelText 同口径）。
	let toolCount: number = 0
	let thinkCount: number = 0
	msg.blocks.forEach((item: ChatBlock): void => {
		if (item.batchId !== state.batchId) return
		if (item.kind === 'tool') toolCount += 1
		else if (item.kind === 'thinking') thinkCount += 1
	})
	const head: ChatBlock | undefined = msg.blocks.find((item: ChatBlock): boolean => item.id === state.batchId)
	if (head != null) {
		const parts: string[] = []
		if (toolCount > 0) parts.push(t('chat.batch_done_count', { count: toolCount.toString() }))
		if (thinkCount > 0) parts.push(t('chat.batch_thinking_count', { count: thinkCount.toString() }))
		head.label = parts.length > 0 ? parts.join(' · ') : t('chat.batch_done')
		head.status = failed ? 'reject' : 'done'
		head.batchCollapsed = true
		head.batchCount = members
		head.duration = ''
		head.startedAt = 0
	}
	msg.blocks.forEach((item: ChatBlock): void => {
		// 子智能体徽章不随批次折叠：桌面 appendAgentBadge 直接挂气泡，不进过程容器
		if (item.kind === 'agent') return
		if (item.id !== state.batchId && item.batchId === state.batchId) item.batchCollapsed = true
	})
	state.batchOpen = false
	state.batchId = ''
	state.batchStartedAt = 0
}

/** 轮终态 Compact：只留最终正文 + 一行统计摘要（桌面 compactBubble(ended:true) 同款）。
 *  桌面门禁（app-turn-display.js:600-712）：
 *  - FATAL_SELECTOR（.err-bubble/.chunk-error）命中 → classifyChildren 返回 null，
 *    不生成整轮摘要；批次盖子仍由 closeBatch 保持收口，错误块 process=false 常驻。
 *  - ended:true 时「无最终正文」的纯工具轮【也允许】折成一行统计摘要；
 *    但停止/挂起终态（endStatus !== 'done'）且无正文时返回 null。
 *  所有调用方都是终态（done/error/stopped/suspended/回放收口），故按 ended:true 处理。 */
function compactTurn(msg: ChatMessage, state: TurnState, elapsed: number, status: 'done' | 'stopped' | 'suspended'): void {
	let fatal: boolean = false
	// noFinal 判定必须看到完整正文：先落账在途合帧缓冲（否则慢流收尾时
	// msg.text 还差最后 120ms 的 delta，「无正文」误判会吞掉整轮 Compact）
	textBufs.forEach((buf: TextBuf, id: string): void => {
		if (buf.msg === msg) flushTextBuf(id)
	})
	// 最后一段正文提升为 msg.text 最终正文（复制源/锚点/历史快照依赖），
	// 之前的段留在过程区随 Compact 折叠（桌面「最后一个非空 .md-content = final」）。
	// 不依赖 textBufs 有无残留：慢流收口时缓冲可能已被非 text 帧 flush 清空。
	for (let ci = 0; ci < conversations.value.length; ci++) {
		const conv: Conversation = conversations.value[ci]
		if (conv.messages.indexOf(msg) >= 0) { promoteLastTextSegment(conv, msg); break }
	}
	msg.blocks.forEach((item: ChatBlock): void => {
		if (item.kind === 'error') fatal = true
	})
	const noFinal: boolean = msg.text.trim().length === 0
	// 失败证据轮 / 无正文的停止或挂起轮：不生成整轮折叠（错误块本身常驻可见）
	if (fatal || (noFinal && status !== 'done')) {
		msg.summary = ''
		msg.compactOpen = true
		return
	}
	msg.counts = { tools: state.tools, reasons: state.reasons, agents: state.agents, batches: state.batches, texts: state.texts }
	// 摘要头只留「状态词 + 耗时」（如「已完成 12s」）；分类计数不再拼长文本——
	// 窄屏下「已完成 · 102 次工具调用 · …」必然折行且与展开过程区叠字（用户报障遮挡），
	// 改为气泡层按 counts 渲染「图标+数字」紧凑 chips（长按 chip 弹 chat.turn.* 全文案 toast）。
	// 状态词 + 空格 + 耗时（<1s/Ns/Nmin Ns），不是「已完成 {n}s」插值（PC chat.turn_done 无占位符）
	const elapsedLabel: string = formatBatchElapsed(Date.now() - Math.max(0, elapsed) * 1000)
	const doneHead: string = elapsed > 0 ? t('chat.turn.doneNoTime') + ' ' + elapsedLabel : t('chat.turn.doneNoTime')
	msg.summary = status === 'suspended' ? t('chat.turn.suspended')
		: (status === 'stopped' ? t('chat.turn.stopped') : doneHead)
	msg.compactOpen = false
}

/** 失败证据轮不生成 Compact 折叠：把过程区展开，错误/重试/交互凭据保持常驻。 */
function revealProcess(msg: ChatMessage | null): void {
	if (msg == null) return
	msg.summary = ''
	msg.compactOpen = true
}

/** 桌面 clearRetryChunk：retry 是临时提示，后续任何真实内容到达即移除，
 *  且同一时刻只保留一张（app-message.js:2824-2848 复用同一元素）。 */
function clearRetryBlocks(msg: ChatMessage): void {
	const kept: ChatBlock[] = []
	msg.blocks.forEach((item: ChatBlock): void => {
		if (item.kind !== 'retry') kept.push(item)
	})
	msg.blocks = kept
}

/** Rust stream_retry / error_discarding 的 discardPartial 语义：
 *  丢弃该次失败尝试已经吐出的半成品正文与过程行（桌面 discardPartialRetryDom 同款）。 */
function discardPartialAttempt(conv: Conversation): void {
	const msg: ChatMessage | null = lastAiMessage(conv)
	if (msg == null || msg.status !== 'processing') return
	// 在途合帧 delta 属于失败尝试：直接作废，绝不落账进被清空的正文
	dropTextBuf(conv.id)
	msg.text = ''
	msg.blocks = []
	resetTurnState(conv.id)
	revealProcess(msg)
}

/** 思考行收口（PC「思考中」→「已思考 (Ns)」+ 移除计时器）：
 *  reasonKey 被清空的所有路径（工具开始/正文到达/子代理/批次声明）都意味着上一段思考结束。
 *  只收口【本会话尾条】里仍 loading 的思考块，落耗时文案；已收口的不重复写。 */
function settleThinking(conv: Conversation): void {
	const msg: ChatMessage | null = lastAiMessage(conv)
	if (msg == null) return
	msg.blocks.forEach((item: ChatBlock): void => {
		if (item.kind !== 'thinking' || item.status !== 'loading') return
		item.status = 'done'
		const secs: number = item.startedAt > 0 ? Math.max(1, Math.round((Date.now() - item.startedAt) / 1000)) : 0
		item.thoughtTime = secs > 0 ? secs.toString() + 's' : ''
		item.label = secs > 0 ? t('chat.segment.thinkingDone', { time: item.thoughtTime }) : t('chat.action_thinking_done')
		item.startedAt = 0
	})
}

function previewOf(text: string, last: boolean): string {
	const lines: string[] = text.split('\n').filter((line: string): boolean => {
		const s: string = line.trim()
		if (s.length === 0) return false
		// 行头摘要是给人看的一句话：markdown 标记/HTML 注释不是内容——
		// 首行是 <!-- 稳定块渲染缓存… --> 之类注释时曾直接裸露在过程行头
		// （用户报障「框里显示稳定块渲染缓存」），整行跳过取下一行。
		if (s.startsWith('<!--') || s.startsWith('-->')) return false
		return true
	})
	if (lines.length === 0) return ''
	let line: string = (last ? lines[lines.length - 1] : lines[0]).trim()
	// 常见行内标记降噪：标题井号/列表星号/引用尖括号/加粗星号（只动首尾，不改语义）
	while (line.startsWith('#')) line = line.slice(1).trim()
	if (line.startsWith('> ')) line = line.slice(2).trim()
	if (line.startsWith('- ') || line.startsWith('* ')) line = line.slice(2).trim()
	line = line.split('**').join('')
	return line.length > 120 ? line.slice(0, 120) + '…' : line
}

/** 内核已给 durationMs 时原样优先，否则按起始时间现算（与批次 tick 共用 formatElapsed）。 */
function durationLabel(startedAt: number, raw: string): string {
	return raw.length > 0 ? raw : formatElapsed(startedAt)
}

/** 字节数人类可读（PC 骨架参数进度 B/KB/MB 同口径） */
function formatBytes(n: number): string {
	if (n < 1024) return n.toString() + ' B'
	if (n < 1024 * 1024) return (Math.round(n / 102.4) / 10).toString() + ' KB'
	return (Math.round(n / 104857.6) / 10).toString() + ' MB'
}

function statusOf(frame: LinkFrame): ChatBlockStatus {
	if (frame['failed'] === true || frameArgs(frame)['success'] === false) return 'reject'
	if (frame['suspended'] === true) return 'warn'
	return 'done'
}

/** 帧上的 args 可能是 UTSJSONObject / 普通对象；只安全读取字符串字段 */
function frameArgs(frame: LinkFrame): ApiBody {
	const args = frame['args']
	if (args != null && typeof args === 'object') return args as ApiBody
	// 某些内核/中转会把 args 序列化成 JSON 字符串：不兼容会把 file_changes
	// 的 files[] 当成空对象，产物卡永远不出现（回放后只剩最终正文）。
	if (typeof args !== 'string' || args.length === 0) return {}
	try {
		const parsed: unknown = JSON.parse(args as string)
		return parsed != null && typeof parsed === 'object' ? parsed as ApiBody : {}
	} catch (_) {
		return {}
	}
}

function argString(frame: LinkFrame, key: string): string {
	return fieldString(frameArgs(frame), key)
}

/** 子智能体身份：优先 invocationId，回退名称 + 描述（对齐桌面端 resolveAgentState）。
 *  两套内核的归属字段命名不同：Java 用 args.agentDesc，Rust 用 args.description；
 *  text / reason 帧可能不带 args，此时回退顶层 toolName（agent_* 帧恒为 agentName）。 */
function agentArgDesc(frame: LinkFrame): string {
	const args = frameArgs(frame)
	const desc = fieldString(args, 'description')
	return desc.length > 0 ? desc : fieldString(args, 'agentDesc')
}

/* ---------------- 交互卡（question / hitl）解析与作答 ---------------- */

/** 把 question 帧的 args.questions 解析成可渲染题面（契约 §5.1 冻结形状）。
 *  纯函数、逐字段判型：帧字段来自模型生成的 JSON，任何一项都可能缺或类型不对，
 *  解析失败只降级为空数组，绝不抛异常打断整条帧链。
 *  description 与 detail 是历史别名（模型两种都写过），统一收进 description。 */
function parseAskQuestions(frame: LinkFrame): AskQuestion[] {
	const args = frameArgs(frame)
	const raw = args['questions']
	if (!Array.isArray(raw)) return []
	const out: AskQuestion[] = []
	const rows = raw as ApiBody[]
	for (let i = 0; i < rows.length; i++) {
		const q = rows[i]
		if (q == null || typeof q !== 'object') continue
		const row = q as ApiBody
		const options: AskOption[] = []
		const rawOpts = row['options']
		if (Array.isArray(rawOpts)) {
			const optRows = rawOpts as ApiBody[]
			for (let j = 0; j < optRows.length; j++) {
				const o = optRows[j]
				if (o == null || typeof o !== 'object') continue
				const opt = o as ApiBody
				// description 优先，detail 是模型自发用过的别名；两者都缺才留空
				const desc = fieldString(opt, 'description')
				options.push({
					label: fieldString(opt, 'label'),
					description: desc.length > 0 ? desc : fieldString(opt, 'detail'),
					recommended: opt['recommended'] === true
				})
			}
		}
		out.push({
			header: fieldString(row, 'header'),
			detail: fieldString(row, 'detail'),
			options: options,
			multiSelect: row['multiSelect'] === true
		})
	}
	return out
}

/** 新建空作答态：题数与 questions 等长同序，answered=false 表示未作答。
 *  出站时未作答的题按 skipped=true 提交（桌面 buildQuestionAnswersPayload 同款），
 *  这样后端拿到的 answers 数组长度恒等于题数，不会因缺项错位。 */
function emptyAskAnswers(count: number): AskAnswer[] {
	const out: AskAnswer[] = []
	for (let i = 0; i < count; i++) {
		out.push({
			index: i, text: '', selectedLabel: '', selectedLabels: [],
			supplement: '', skipped: false, custom: false, answered: false
		})
	}
	return out
}

/** 单选题出站文本：选项与补充并存时拼成「选项（补充：…）」，
 *  与后端 formatAnswerText 的「（用户自定义回答）」括号风格一致。 */
function composeAskText(selectedLabel: string, supplement: string): string {
	const sel: string = selectedLabel.trim()
	const sup: string = supplement.trim()
	if (sel.length === 0) return sup
	if (sup.length === 0) return sel
	return sel + '（补充：' + sup + '）'
}

/** 多选题出站文本：选中 label 以「、」连接，自由输入作为附加项追加在尾部。 */
function composeAskMultiText(labels: string[], supplement: string): string {
	const parts: string[] = []
	for (let i = 0; i < labels.length; i++) {
		if (labels[i].length > 0) parts.push(labels[i])
	}
	const sup: string = supplement.trim()
	if (sup.length > 0) parts.push(sup)
	return parts.join('、')
}

/** 作答态是否已有内容（用于「可以提交了吗」与未答题的 skipped 判定） */
function askAnswered(a: AskAnswer): boolean {
	return a.text.trim().length > 0
}

function askAnswerOf(block: ChatBlock, index: number): AskAnswer | null {
	if (index < 0 || index >= block.answers.length) return null
	return block.answers[index]
}

/** 答案回填：把 question_answered / hitl_released 帧里的内容写进已闭环卡。
 *  帧形状：question_answered { args: { answers: [{index,text,skipped,custom,texts?}] } }。
 *  拿不到结构化数组时退回空串，仍把卡置为 resolved（卡片已闭环这一事实优先）。 */
function resolvedAnswersText(frame: LinkFrame): string {
	const answers = frameArgs(frame)['answers']
	if (!Array.isArray(answers)) return ''
	const rows = answers as ApiBody[]
	const parts: string[] = []
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]
		if (row == null || typeof row !== 'object') continue
		const item = row as ApiBody
		if (item['skipped'] === true) continue
		const text: string = fieldString(item, 'text').trim()
		if (text.length > 0) parts.push(text)
	}
	return parts.join(' / ')
}

function agentNameOf(frame: LinkFrame): string {
	const name = fieldString(frameArgs(frame), 'agentName')
	return name.length > 0 ? name : fieldString(frame, 'toolName')
}

function agentKeyOf(frame: LinkFrame): string {
	const invocation = fieldString(frameArgs(frame), 'invocationId')
	if (invocation.length > 0) return 'agent:' + invocation
	const name = agentNameOf(frame)
	if (name.length === 0) return ''
	return 'agent:' + name + ':' + agentArgDesc(frame)
}

/** 归属 key 不能靠拼 desc 精确命中（Java agentDesc / Rust description 不同，且 text 帧
 *  可能根本没有描述）；优先在当前 AI 尾气泡里复用已存在的同名子智能体卡，
 *  对齐桌面 resolveAgentState「必须命中活跃卡才进卡体」的语义。 */
function agentOwnerKey(conv: Conversation, frame: LinkFrame): string {
	const exact: string = agentKeyOf(frame)
	if (exact.length === 0) return ''
	const invocation = fieldString(frameArgs(frame), 'invocationId')
	if (invocation.length > 0) return exact
	const name = agentNameOf(frame)
	const msg: ChatMessage | null = lastAiMessage(conv)
	if (msg != null) {
		for (let i = msg.blocks.length - 1; i >= 0; i--) {
			const item: ChatBlock = msg.blocks[i]
			if (item.kind === 'agent' && item.agentName === name) return item.id
		}
	}
	return exact
}

/* PC formatToolArgsStr 同口径（app-message.js:1855-1903）：
   语义优先级排序 + 抑制已由专门元素展示的键 + 单键免 key= 前缀 + 数组展开前 3 项。
   file_path/path → fileName chip；diff/content/todos → 卡体/统计，绝不挤进摘要。 */
const ARG_PRIORITY: string[] = ['command', 'cmd', 'pattern', 'query', 'url', 'prompt', 'description',
	'question', 'skill', 'text', 'message', 'name', 'key', 'agent_name']
const ARG_SUPPRESSED: string[] = ['file_path', 'path', 'diff', 'content', 'todos',
	'agentName', 'invocationId', 'background']

function formatArgValue(v: any | null): string {
	if (v == null) return ''
	if (typeof v === 'string') return v.split('\n').join(' ').trim()
	if (typeof v === 'number' || typeof v === 'boolean') return v.toString()
	if (Array.isArray(v)) {
		const arr = v as any[]
		const strs: string[] = []
		let hasObj: boolean = false
		for (let i = 0; i < arr.length; i++) {
			const x = arr[i]
			if (x != null && typeof x === 'object') { hasObj = true; break }
			strs.push(x == null ? '' : x.toString())
		}
		if (hasObj) return '[' + arr.length.toString() + i18n.global.t('chat.items') + ']'
		const head: string = strs.slice(0, 3).join(', ')
		return strs.length > 3 ? head + ' +' + (strs.length - 3).toString() + i18n.global.t('chat.items') : head
	}
	if (typeof v === 'object') {
		const obj = v as ApiBody
		const keys: string[] = Object.keys(obj)
		if (keys.length === 0) return '{}'
		if (keys.length > 3) return '{' + keys.slice(0, 2).join(',') + ',...}'
		const inner: string[] = []
		keys.forEach((k: string): void => { inner.push(k + ':' + formatArgValue(obj[k])) })
		const s: string = '{' + inner.join(',') + '}'
		return s.length > 30 ? '{' + keys.join(',') + '}' : s
	}
	return v.toString()
}

function summarizeObject(value: ApiBody): string {
	const all: string[] = Object.keys(value).filter((k: string): boolean => ARG_SUPPRESSED.indexOf(k) < 0)
	const rank = (k: string): number => {
		const i: number = ARG_PRIORITY.indexOf(k)
		return i < 0 ? ARG_PRIORITY.length : i
	}
	const keys: string[] = all.slice().sort((a: string, b: string): number => rank(a) - rank(b))
	const showKey: boolean = keys.length > 1
	const parts: string[] = []
	for (let i = 0; i < keys.length; i++) {
		const val: string = formatArgValue(value[keys[i]])
		if (val.length === 0) continue
		parts.push(showKey ? keys[i] + '=' + val : val)
	}
	const s: string = parts.join('  ')
	return s.length > 120 ? s.slice(0, 119) + '…' : s
}

/** 从 args 提取文件名 chip（PC .tool-file）：file_path/path 的 basename */
function fileNameOf(args: ApiBody): string {
	const fp: string = fieldString(args, 'file_path').length > 0 ? fieldString(args, 'file_path') : fieldString(args, 'path')
	if (fp.length === 0) return ''
	const norm: string = fp.split('\\').join('/')
	const slash: number = norm.lastIndexOf('/')
	return slash >= 0 ? norm.slice(slash + 1) : norm
}

/** 从 edit args.diff 统计增删行（PC .tool-diff-stat 同口径）：+N / -M 两段 */
function diffStatOf(args: ApiBody): string[] {
	const diff: string = fieldString(args, 'diff')
	if (diff.length === 0) return ['', '']
	let add: number = 0
	let del: number = 0
	diff.split('\n').forEach((line: string): void => {
		if (line.startsWith('+') && !line.startsWith('+++')) add += 1
		else if (line.startsWith('-') && !line.startsWith('---')) del += 1
	})
	return [add > 0 ? '+' + add.toString() : '', del > 0 ? '-' + del.toString() : '']
}

/** 桌面端 .tool-args / .preview-inline 同款：参数摘要只保留一行，避免原生 text 承载超长 payload。
 *  无参数时返回空串（调用方据此保留已有摘要，而不是写回「正在执行…」把参数覆盖掉）。 */
function summarizeArgs(frame: LinkFrame): string {
	const args: ApiBody = frameArgs(frame)
	const text: string = summarizeObject(args)
	return text.length > 0 ? previewOf(text, false) : ''
}

/** 正文按帧时序分段（桌面「正文指针推进」同款，app-message.js:1239/2657）：
 *  每段 text 落成气泡里独立的 'text' 块，位置即帧到达时序——工具执行【前】吐出的
 *  正文（含产物文件链接/卡片）留在工具行上方，工具后的续写落在其下方。
 *  旧实现把全部正文攒进 msg.text、过程区整体渲染在最终正文上方，导致「产物卡片
 *  跑到正文上面」，且过程正文被当纯文本 dump（markdown 原文裸露）。
 *  收口时 promoteLastTextSegment 把最后一段提升为 msg.text 最终正文（复制源/
 *  滚动锚点/历史快照都依赖它），之前的段留在过程区随 Compact 折叠。 */
function appendFinalText(conv: Conversation, msg: ChatMessage, state: TurnState, delta: string): void {
	if (delta.length === 0) return
	if (state.textKey.length === 0) {
		// 新正文段：先落账在途缓冲（上一段的尾巴不能漏），再按当前时序建块
		flushTextBuf(conv.id)
		const key: string = 'text:' + nextBlockId()
		const block: ChatBlock = ensureBlock(conv, key, 'text', t('chat.segment.answer'), 'edit')
		block.body = ''
		block.preview = ''
		block.status = 'loading'
		block.process = true
		state.textKey = key
	}
	const block: ChatBlock | null = blockOf(conv, state.textKey)
	if (block == null) { state.textKey = ''; return }
	// 可见写入走合帧缓冲（首段立即上屏）；段归属逐帧即时更新，不受节流影响
	bufferFinalText(conv.id, msg, delta, block!)
}

/** 过程帧边界：收口当前正文段（后续 text 另起新段，落在过程行之后）。
 *  与桌面「工具卡/思考块产出后新开空 .md-content」同口径。 */
function closeTextSegment(conv: Conversation): void {
	const state: TurnState = turnStateOf(conv.id)
	if (state.textKey.length === 0) return
	flushTextBuf(conv.id)
	const block: ChatBlock | null = blockOf(conv, state.textKey)
	if (block != null) {
		block!.status = 'done'
		block!.preview = previewOf(block!.body, false)
		// 计数按可见内容：纯注释段不算一段过程正文（与收口提升同口径）
		if (hasVisibleContent(block!.body)) state.texts += 1
	}
	state.textKey = ''
}

/** 正文段是否有「可见内容」：非空白且不是纯 HTML 注释（含跨行）。
 *  注释在 markdown 管道整段剥离（CommonMark raw HTML 口径），渲染态为空——
 *  收口提升/计数都必须按可见内容判定，否则纯注释段会把真回答挤进折叠区。 */
function hasVisibleContent(body: string): boolean {
	let s: string = body.trim()
	// 逐段剥「块级起始的完整注释」（与 mdCommentLineEnd 同口径：只认行首 <!--）：
	// 注释+正文+注释混排时不能只看第一个 -->，要剥到露出真实内容为止
	while (s.startsWith('<!--')) {
		const end: number = s.indexOf('-->')
		if (end < 0) return true // 流式未闭合：渲染态转义可见，算内容
		s = s.slice(end + 3).trim()
	}
	return s.length > 0
}

/** 轮收口：把最后一段正文提升为 msg.text 最终正文（桌面 classifyChildren 的
 *  「最后一个非空 .md-content = final」同款）。之前的段留在过程区（process=true）。
 *  必须在 compactTurn 读 msg.text 判 noFinal 之前调用。 */
function promoteLastTextSegment(conv: Conversation, msg: ChatMessage): void {
	flushTextBuf(conv.id)
	const state: TurnState = turnStateOf(conv.id)
	state.textKey = ''
	let lastIdx: number = -1
	for (let i = msg.blocks.length - 1; i >= 0; i--) {
		const item: ChatBlock = msg.blocks[i]
		// 【可见性判定，非 trim】纯 HTML 注释段（<!-- … -->）trim 非空但渲染态为空
		// （解析器整段剥离）：若被提升为 msg.text，气泡只剩「已完成」而过程区里
		// 真正的回答被 Compact 藏起来（用户看到空回答）。跳过无可见内容的段。
		if (item.kind === 'text' && hasVisibleContent(item.body)) { lastIdx = i; break }
	}
	if (lastIdx < 0) return
	const last: ChatBlock = msg.blocks[lastIdx]
	// 提升为最终正文：从过程块列表移除（避免同一内容渲染两遍），
	// 其余 text 段保持 process=true 随 Compact 折叠
	msg.text = last.body
	msg.blocks.splice(lastIdx, 1)
}

/* ---------------- 流式正文合帧（PC createStreamMd schedule/tick 同款语义） ----------------
 * text 帧的【累积】仍逐帧进行（批次收口/边界切分/Compact 计数依赖即时状态），
 * 只把 msg.text 的【可见写入】合并到 ~120ms 一次：uni-app x 逻辑层→视图层每次赋值
 * 都要过桥，高频小 delta 逐帧刷 rich-text 是移动端最大的无谓开销（PC 用 rAF+120ms
 * 定时器双通道合帧，这里用单定时器；后台时定时器照跑，天然覆盖 PC 的遮挡兜底场景）。
 * 护栏：
 * - 首段 delta 立即上屏（首字延迟不受节流影响，PC 首帧同口径）；
 * - 缓冲超 2000 字符立即 flush（病态快流下内存与延迟封顶）；
 * - 任何非 text 帧到达先 flush（工具卡插入/正文切分前必须落账，否则「答完了正文缺一截」）；
 * - done/error/停止/重试丢弃/回放收口等所有终态路径强制 flush（收尾一致性，PC finish 同款）；
 * - 回放（replay 循环）不节流：同步消费完再统一上屏，避免定时器与回放循环竞跑。 */
type TextBuf = { pending: string; timer: number; msg: ChatMessage | null; block: ChatBlock | null }
const textBufs: Map<string, TextBuf> = new Map<string, TextBuf>()
const TEXT_FLUSH_MS = 120
const TEXT_FLUSH_CHARS = 2000

function flushTextBuf(id: string): void {
	const buf: TextBuf | undefined = textBufs.get(id)
	if (buf == null) return
	if (buf.timer != 0) {
		clearTimeout(buf.timer)
		buf.timer = 0
	}
	if (buf.pending.length === 0) return
	const conv: Conversation | null = conversationOf(id)
	if (conv == null) { buf.pending = ''; return }
	// 目标钉住原属消息；仅在极端缺失时回落尾条
	const msg: ChatMessage | null = buf.msg != null ? buf.msg : lastAiMessage(conv)
	if (msg == null) { buf.pending = ''; return }
	// 正文按段入账：钉住的 text 段块写 body（时序位置由块在列表中的位置决定）；
	// 无段块（异常兜底）才写 msg.text。段块 preview 同步刷新（行头摘要）。
	if (buf.block != null) {
		buf.block!.body += buf.pending
		buf.block!.preview = previewOf(buf.block!.body, false)
	} else {
		msg!.text += buf.pending
	}
	buf.pending = ''
	conv.updatedAt = Date.now()
}

function dropTextBuf(id: string): void {
	const buf: TextBuf | undefined = textBufs.get(id)
	if (buf == null) return
	if (buf.timer != 0) clearTimeout(buf.timer)
	textBufs.delete(id)
}

/** 正文 delta 入账：首段/大缓冲/回放立即上屏，其余合并 120ms 刷一次。
 *  msg + block 显式钉住目标：flush 时若尾条已换（他端 user 帧插队等），delta 仍写进
 *  原属消息的原属正文段，绝不串轮/串段（落错气泡比晚 120ms 严重得多）。 */
function bufferFinalText(id: string, msg: ChatMessage, delta: string, block: ChatBlock): void {
	if (delta.length === 0) return
	if (historyReplay.has(id)) {
		block.body += delta
		block.preview = previewOf(block.body, false)
		return
	}
	let buf: TextBuf | undefined = textBufs.get(id)
	if (buf == null) {
		buf = { pending: '', timer: 0, msg: msg, block: block } as TextBuf
		textBufs.set(id, buf!)
	}
	const first: boolean = block.body.length === 0 && buf!.pending.length === 0
	buf!.pending += delta
	buf!.msg = msg
	buf!.block = block
	if (first || buf!.pending.length >= TEXT_FLUSH_CHARS) {
		flushTextBuf(id)
		return
	}
	if (buf!.timer == 0) {
		buf!.timer = setTimeout((): void => {
			const b: TextBuf | undefined = textBufs.get(id)
			if (b != null) b!.timer = 0
			flushTextBuf(id)
		}, TEXT_FLUSH_MS)
	}
}

function appendOwnedText(conv: Conversation, kind: ChatBlockKind, label: string, icon: string, delta: string, key: string): void {
	if (delta.length === 0) return
	const block: ChatBlock = ensureBlock(conv, key, kind, label, icon)
	block.body += delta
	block.preview = previewOf(block.body, kind === 'thinking')
	block.status = 'loading'
	// 批次成员数由 closeBatch 按真实归属统计，这里不再累加计数器
	// （旧实现每个增量帧 +1，思考一长就显示「已处理 · 87」这种虚高成员数）
}

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

/** 组内排序：置顶优先，同档按最近活跃时间倒序。
 *
 *  【为什么必须比 updatedAt】旧实现只比 pinned，其余一律 `return 0`，实际保留
 *  的是 `refreshConversations` 的拼接顺序：全局区先、各项目区后，而每个区的
 *  行序来自服务端 `last_activity` 倒序。跨区拼接后时间轴就被「按 root 分组
 *  堆叠」打断——一个 3 天前的全局会话会排在一个 1 分钟前的项目会话之上，
 *  同一屏里「刚刚」和旧时间交错出现，读起来完全无规律（用户报障「消息加载
 *  有点杂乱无章」）。服务端单区已排好，但移动端会把多区结果 concat，排序
 *  必须在客户端按时间轴重做一次。
 *
 *  同毫秒时用 id 兜底，保证排序稳定（否则 v-for 用 id 做 key 时行会抖动）。 */
function sortInWorkspace(list: Conversation[]): Conversation[] {
	return list.slice().sort((a: Conversation, b: Conversation): number => {
		if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
		if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
		return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)
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
	// permission 本身即协议码（'default'|'full'），不再用展示文案反查
	return permission.value === 'full' ? 'full' : 'default'
}

/** 纯附件消息的乐观占位文案（与 user 帧 imagePaths/filePaths 占位同口径） */
/** UTF-8 字节数（不依赖 TextEncoder，UTS 全端可用）：发送前信封体积预检用 */
export function utf8Bytes(s: string): number {
	let n: number = 0
	for (let i = 0; i < s.length; i++) {
		const c: number = s.charCodeAt(i)
		if (c < 0x80) n += 1
		else if (c < 0x800) n += 2
		else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++ }
		else n += 3
	}
	return n
}

/** input 信封字节预算：admin 网关 WS 帧限 16MiB（gwork.go SetReadLimit），
 *  留出 JSON 结构/字段名余量取 15MiB。超限在发送前明确拒绝，绝不静默踢断链路。 */
export const INPUT_MAX_BYTES: number = 15 * 1024 * 1024

/** 发送前预检：附件 base64 总量 + 正文 UTF-8 字节。超限返回 false 并 toast。 */
export function inputWithinBudget(text: string, atts: PendingAttachment[]): boolean {
	let total: number = utf8Bytes(text)
	atts.forEach((a: PendingAttachment): void => { total += a.dataBase64.length })
	if (total <= INPUT_MAX_BYTES) return true
	uni.showToast({ title: i18n.global.t('home.msg.tooLarge'), icon: 'none' })
	return false
}

function attachPlaceholder(atts: PendingAttachment[]): string {
	let images = 0
	let files = 0
	atts.forEach((a: PendingAttachment): void => {
		if (a.type === 'image') images += 1
		else files += 1
	})
	if (images > 0) return t('chat.attachmentImages', { n: images.toString() })
	if (files > 0) return t('chat.attachmentFiles', { n: files.toString() })
	return ''
}

/* ---------------- 附件缩略图升级（PC renderUserAttachmentPaths 同款） ---------------- */

/** 附件 meta 缓存：sessionId+path → dataUrl（成功才缓存；失败不缓存，下次渲染可重试）。
 *  历史回放每条 user 帧都可能带 imagePaths，同一张图多轮去重全靠这里。 */
const attachmentMetaCache: Map<string, string> = new Map<string, string>()
/** 在途去重：同 key 只发一次请求（PC attachMetaInflight 同款） */
const attachmentMetaInflight: Map<string, Promise<string | null>> = new Map<string, Promise<string | null>>()

function attachmentMetaKey(sessionId: string, path: string): string {
	return sessionId + '|' + path
}

/** 把一批 session 内相对路径经 /web/chat/attachment/meta 换成 dataUrl（按序返回，失败项 null）。
 *  内核按重复键 paths=a&paths=b 解析（attachments_api.rs parse_meta_query），≤32 路径/批。 */
function fetchAttachmentDataUrls(sessionId: string, root: string, paths: string[]): Promise<(string | null)[]> {
	const out: (string | null)[] = []
	const need: number[] = []
	for (let i = 0; i < paths.length; i++) {
		const cached: string | undefined = attachmentMetaCache.get(attachmentMetaKey(sessionId, paths[i]))
		if (cached != null) {
			out.push(cached)
		} else {
			out.push(null)
			need.push(i)
		}
	}
	if (need.length === 0) return Promise.resolve(out)
	const batchPaths: string[] = need.map((i: number): string => paths[i])
	// 32 路径上限分批（内核 ATTACHMENT_META_MAX_PATHS）
	const groups: string[][] = []
	for (let i = 0; i < batchPaths.length; i += 32) {
		groups.push(batchPaths.slice(i, i + 32))
	}
	const jobs: Promise<void>[] = []
	let cursor: number = 0
	groups.forEach((group: string[]): void => {
		const q: string[] = ['sessionId=' + encodeURIComponent(sessionId)]
		if (root.length > 0) q.push('root=' + encodeURIComponent(root))
		group.forEach((p: string): void => { q.push('paths=' + encodeURIComponent(p)) })
		const start: number = cursor
		cursor += group.length
		const p: Promise<void> = request('GET', '/web/chat/attachment/meta', q.join('&'), '', root).then((body: ApiBody): void => {
			if (!kernelOk(body) || body.data == null || typeof body.data !== 'object') return
			const items: any = (body.data as ApiBody)['items']
			if (!Array.isArray(items)) return
			const byPath: Map<string, string> = new Map<string, string>()
			for (let k = 0; k < items.length; k++) {
				const item: ApiBody = items[k] as ApiBody
				const pth: string = fieldString(item, 'path')
				const url: string = fieldString(item, 'dataUrl')
				// 带 error 的（too_large/budget/missing/invalid）不缓存：占位文案已兜底
				if (pth.length > 0 && url.length > 0) byPath.set(pth, url)
			}
			for (let g = 0; g < group.length; g++) {
				const got: string | undefined = byPath.get(group[g])
				if (got != null) {
					attachmentMetaCache.set(attachmentMetaKey(sessionId, group[g]), got!)
					out[start + g] = got!
				}
			}
		}).catch((_e): void => {
			// 整批失败：保持 null（不缓存），占位文案兜底
		})
		jobs.push(p)
	})
	return Promise.all(jobs).then((): (string | null)[] => out)
}

/** 消息级升级入口：给一条 user 消息的 imagePaths 拉缩略图并写入 imageUrls。
 *  单飞去重（inflight 表）；回放是时序消费，await 期间消息对象仍持有引用，
 *  会话被删/切设备时 row 已脱离 messages 数组，写入无害（无人再渲染）。 */
function upgradeUserAttachments(sessionId: string, root: string, msg: ChatMessage, imagePaths: string[]): void {
	if (imagePaths.length === 0 || msg.imageUrls.length > 0) return
	const key: string = sessionId + '|' + msg.id
	let job: Promise<string | null> | undefined = attachmentMetaInflight.get(key)
	if (job == null) {
		const p: Promise<(string | null)[]> = fetchAttachmentDataUrls(sessionId, root, imagePaths)
		job = p.then((urls: (string | null)[]): string | null => {
			attachmentMetaInflight.delete(key)
			const filled: string[] = []
			urls.forEach((u: string | null): void => { if (u != null && u!.length > 0) filled.push(u!) })
			if (filled.length > 0) msg.imageUrls = filled
			return null
		}).catch((_e): string | null => {
			attachmentMetaInflight.delete(key)
			return null
		})
		attachmentMetaInflight.set(key, job)
	}
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
		// 拉取失败不能当成「桌面没有任何工作区」：那样会把侧栏工作区连同任务整体清空，
		// 用户看到的就是「工作区没了、任务也没了」。失败时保留上一轮清单。
		let projectsOk: boolean = false
		try {
			const pbody: ApiBody = await request('GET', '/web/chat/projects')
			if (kernelOk(pbody) && Array.isArray(pbody.data)) {
				const prows = pbody.data as ApiBody[]
				for (let i = 0; i < prows.length; i++) {
					const ppath: string = fieldString(prows[i], 'path')
					if (ppath.length === 0) continue
					named.push({ name: fieldString(prows[i], 'name'), root: ppath })
				}
				projectsOk = true
			}
		} catch (_) { /* 项目清单拉取失败不阻塞会话列表，兜底走 projectRoot */ }
		// 预置清单（只有 projects，不含 sessions 兜底 root）：只刷展示，
		// 不在这一趟做「当前工作区是否还存在」的回落判断，避免中途把用户选中的工作区打回全局区
		if (projectsOk) setProjectRoots([], named, true)
		const roots: string[] = ['']
		projects.value.forEach((item): void => {
			roots.push(item.root)
		})
		const seenRoots: Set<string> = new Set<string>()
		projects.value.forEach((item): void => {
			seenRoots.add(item.root)
		})
		let failed: boolean = false
		// 【2026-11-26 性能修复】各 root 的会话列表并行拉取。旧实现按 root 逐个
		// await：每个 root 一次 WS 中转往返（手机→后台→PC→内核→回程），N 个项目
		// 就是 N+1 次串行往返叠加，选完设备后「工作空间 + 消息」的加载时间随
		// 项目数线性恶化（每跳 200-500ms 时 3 个项目就多出秒级等待）。
		// 【并发上限 · code review 2026-11-26】全量 roots 一次性 Promise.all 会把
		// N 个请求同时压到同一条中转 WS：慢网下在途帧排队 + 35s 超时连锁风险，
		// 且设备侧内核串行处理时突发并发没有收益。分批 4 个并行：串行 N 次往返
		// 收敛为 ceil(N/4) 批，在途压力有界。
		// 【UTS 纪律】闭包不写共享变量（UTS/Kotlin 对闭包捕获可变外部状态的处理
		// 不可靠）：每个 root 的结果连同「是否失败」「行内兜底 root」一并返回，
		// 归并统一在 await 之后主线程做，语义与串行版一致（任一失败置 failed、
		// projectRoot 兜底合并仍在本地）。
		type PerRoot = { failed: boolean, roots: string[], convs: Conversation[] }
		const REFRESH_CONCURRENCY: number = 4
		const fetchRoot = async (root: string): Promise<PerRoot> => {
			try {
				const body: ApiBody = await request('GET', '/web/chat/sessions', 'root=' + encodeURIComponent(root))
				if (!kernelOk(body)) {
					return { failed: true, roots: [], convs: [] }
				}
				const rows = body.data
				if (!Array.isArray(rows)) return { failed: false, roots: [], convs: [] }
				const items = rows as ApiBody[]
				const convs: Conversation[] = []
				const extraRoots: string[] = []
				for (let j = 0; j < items.length; j++) {
					const row = items[j]
					const rowRoot = fieldString(row, 'projectRoot')
					const effectiveRoot: string = rowRoot.length > 0 ? rowRoot : root
					if (effectiveRoot.length > 0) extraRoots.push(effectiveRoot)
					const conv = convFromSessionRow(row, effectiveRoot)
					if (conv != null) convs.push(conv)
				}
				return { failed: false, roots: extraRoots, convs: convs }
			} catch (_) {
				return { failed: true, roots: [], convs: [] }
			}
		}
		const perRoot: PerRoot[] = []
		let batchStart: number = 0
		while (batchStart < roots.length) {
			const batch: string[] = roots.slice(batchStart, batchStart + REFRESH_CONCURRENCY)
			batchStart += REFRESH_CONCURRENCY
			const results: PerRoot[] = await Promise.all(batch.map(fetchRoot))
			results.forEach((result: PerRoot): void => {
				perRoot.push(result)
			})
		}
		const collected: Conversation[] = []
		perRoot.forEach((result: PerRoot): void => {
			if (result.failed) failed = true
			result.roots.forEach((r: string): void => {
				seenRoots.add(r)
			})
			result.convs.forEach((item: Conversation): void => {
				collected.push(item)
			})
		})
		if (gen !== refreshGen) return
		const rootsList: string[] = []
		seenRoots.forEach((root: string): void => {
			rootsList.push(root)
		})
		// 项目清单失败时 named 为空，不能拿它覆盖已有清单（见上面 projectsOk 注释）：
		// 失败退化成本轮清单 = 上一轮已公布的项目（保留桌面展示名）+ sessions 里新出现的 root。
		// projectsOk=true 但 named=[]（桌面确实没注册项目，或该次响应为空）同理：
		// 不能把「成功但空」当成「桌面一个项目都没有」而清空清单并打回全局区。
		const namedFinal: WorkspaceOption[] = (projectsOk && named.length > 0) ? named : projects.value.slice()
		setProjectRoots(rootsList, namedFinal)
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

/** 历史全量回放代次：该集合内的会话，done/error 暂不把尾条改成终态，
 *  因为同一份流里后面还有 user 帧会开启下一轮；由 user 帧前与回放收尾统一收口。 */
const historyReplay: Set<string> = new Set<string>()

/** 本端刚发出的用户文本（sessionId → text）：live 流的 user 回显只对这一条去重。
 *  用 Set/全文匹配会把「用户第二次发同样的话」当重复丢掉（历史错位真因）。
 *  【轮收口必须销账】done/error/手动停止后清掉：否则登记残留会把下一条
 *  他端/Loop 的 user 帧当成本端 echo 吞掉（桌面端 done 清 _pendingEchoIds 同口径）。 */
const pendingUserEcho: Map<string, string> = new Map<string, string>()

/** 本端刚发出的那条的 clientMessageId（sessionId → id）：内核把 user 帧广播给
 *  该设备的所有客户端后，回显帧带回同一个 id 即证明是自己发的，按身份精确跳过，
 *  不再依赖「尾部同文」的猜测（连发两条相同消息时后者会被误吞）。
 *  没有 id 的旧设备端保持 undefined，走原文本去重路径。轮收口同样销账（见上）。 */
const pendingClientMsgId: Map<string, string> = new Map<string, string>()

/** 本次发送的 clientMessageId → 乐观 user 行 id：busy/失败回滚按行 id 精确定位。
 *  文本比对在技能前缀/纯附件占位场景必失配（wire ≠ 展示），会残留假气泡。 */
const optimisticUserId: Map<string, string> = new Map<string, string>()

/** 轮收口：撤销本会话的待回显登记（done / error / 手动停止统一调用）。
 *  内核 user 帧先于本轮所有输出落盘广播，正常路径登记早已被 echo 销账；
 *  这里兜的是异常路径（echo 丢失/断线），防残留登记误吞下一轮他端消息。 */
function clearPendingEcho(id: string): void {
	pendingUserEcho.delete(id)
	pendingClientMsgId.delete(id)
}

/** 收口一条仍在 processing 的 AI 尾条（历史回放中遇到下一个 user 帧、或回放结束时调用）。
 *  回放是已落盘的历史，拿不到真实耗时：传 elapsed=0 表示「无耗时」，
 *  不再显示伪造的「已完成 1s」。 */
function finishProcessingTail(conv: Conversation, elapsed: number): void {
	const msg: ChatMessage | null = lastAiMessage(conv)
	if (msg == null || msg.status !== 'processing') return
	flushTextBuf(conv.id)
	closeBatch(conv, false)
	msg.thinking = false
	msg.status = 'done'
	msg.meta = elapsed > 0 ? t('chat.metaDone', { n: elapsed.toString() }) : ''
	compactTurn(msg, turnStateOf(conv.id), elapsed, 'done')
}

function messageFromHistoryRow(row: ApiBody): ChatMessage {
	const role = fieldString(row, 'role')
	return emptyChatMessage(nextMsgId(), role === 'USER' ? 'user' : 'ai', fieldString(row, 'content'), 'done', false, false)
}

/** 桌面 app-history.js loadMessages 同款：历史不走 /messages 纯文本快照，
 *  而是用 rounds 合帧回放，按 user 帧切轮，重建过程轨迹 / 批次 / Compact。
 *
 *  【首屏只拉最新一页 · 2026-11-24 用户报障「消息加载极度慢/运行中任务卡住不动」真因】
 *  旧实现 for(;;) 把全部更早轮【串行倒拉完】才消费上屏：每页一次 WS 中转 RTT +
 *  内核全文件两遍扫描，长会话几十轮 = 几十次串行往返，首屏分钟级；期间 running/
 *  onFrame 都没建立，运行中任务的 live 帧全被丢弃。PC 端从来只拉最新
 *  REPLAY_PAGE_ROUNDS 轮、更早轮由 loadMoreMessages 按需翻——移动端对齐：
 *  这里只拉一页立即上屏，更早轮由 loadEarlierRounds 在接流之后逐页前插。
 *
 *  返回 { ok, degraded }：ok=本页完整；degraded=帧已渲染但回放链路不完整，
 *  调用方必须保留已重建的 blocks（只加提示/重试），绝不降级 /messages 清空过程。 */
async function rebuildHistory(id: string): Promise<HistoryResult> {
	const conv: Conversation | null = conversationOf(id)
	if (conv == null) return { ok: false, degraded: false } as HistoryResult
	const devices = useDevices()
	if (devices.activeDeviceId.value.length === 0) return { ok: false, degraded: false } as HistoryResult
	// 旧翻页链作废：重建后消息数组已清空，迟到的更早段前插会拼进错序历史
	earlierEpoch += 1
	earlierCursors.delete(id)
	earlierMore.delete(id)
	conv.messages = []
	// 气泡容器全量重建：已登记的插话键同步作废，replay 的 steer_applied 帧
	// 才能重新还原插话用户气泡（桌面淘汰会话清 steerResolved 同语义）
	clearSteerResolved(id)
	const cursor = cursorOf(id)
	cursor.lastSeq = 0
	cursor.runId = ''
	resetTurnState(id)
	historyReplay.add(id)
	try {
		await ensureConnected(devices.activeDeviceId.value)
		// 【必须用 rounds 合帧回放，不能 afterSeq 逐帧回放】（用户报障「已完成会话
		// 历史消息加载十几分钟」真因）：After 模式逐帧返回原始 token delta 且每页
		// 都全文件重扫；Rounds 模式一次扫描合帧投影。详见 replayRoundsPage 头注释。
		const ok: boolean = await replayRoundsPage(id)
		const current: Conversation | null = conversationOf(id)
		if (current == null) return { ok: false, degraded: false } as HistoryResult
		// 回放是历史快照，拿不到真实耗时：0 = 不伪造「已完成 1s」。
		// 【末页收口只动最后一条】更早轮的回放期收口由 user 帧切轮完成；
		// 若设备端仍在跑（running=true），尾条保持 processing 交给 probeRunning 接流。
		if (lastPageRunning.get(id) !== true) finishProcessingTail(current, 0)
		if (current.messages.length > 0) {
			return { ok: ok, degraded: !ok } as HistoryResult
		}
		// 【空窗口不是「无历史」· 三轮报障「历史只剩最终正文」真因】旧内核 Rounds
		// 投影以 user 帧切轮，无 user 帧的流（续跑/截断/纯附件轮）回空信封，但
		// latestSeq>0 说明流里明明有帧。旧实现降级 /messages 文本快照 → 过程轨迹
		// 全丢。这里改用 After 全量分页兜底（游标已归零，从 0 拉全；合帧只在
		// Rounds 有，After 逐帧但这类会话本来就短），保住完整过程。
		if (lastPageEmptyWithFrames.get(id) === true) {
			// 【必须先归零游标】空信封分支已把 cursor.lastSeq 对齐到 latestSeq(>0)，
			// replayFrom(0) 拉回的帧会被 consumeFrame 的 seq<=lastSeq 去重全丢
			// （S10 模拟实锤：After 拉回 5 帧、cursor=5，全部 DROP）。
			cursorOf(id).lastSeq = 0
			// 【replayFrom 不会自建占位】正常链路的占位由 loadMessagesInner 先铺、
			// rebuildHistory 清空后由 user 帧切轮重建；无头流没有 user 帧，必须
			// 手动铺占位，否则 ensureStreamingTail 走「迟到帧并回上一轮」拿不到
			// 尾条，全部帧被丢。
			appendStreamingPlaceholder(current)
			const pulled: boolean = await replayFrom(id, 0)
			const after: Conversation | null = conversationOf(id)
			if (after != null && hasReplayContent(after)) {
				if (lastPageRunning.get(id) !== true) finishProcessingTail(after, 0)
				return { ok: pulled, degraded: !pulled } as HistoryResult
			}
			// After 兜底也没拿到内容（病态流/链路失败）：清掉空占位再交调用方降级
			if (after != null) after.messages = []
		}
		return { ok: false, degraded: false } as HistoryResult
	} catch (_) {
		return { ok: false, degraded: hasReplayContent(conversationOf(id)) } as HistoryResult
	} finally {
		historyReplay.delete(id)
		lastPageRunning.delete(id)
	}
}

/** 文本快照降级：replay 不可用（旧设备/无 .stream.ndjson/回放中途失败）时至少保住正文。 */
async function loadTextSnapshot(id: string): Promise<void> {
	const conv: Conversation | null = conversationOf(id)
	if (conv == null) return
	const body: ApiBody = await request('GET', '/web/chat/messages', 'sessionId=' + encodeURIComponent(id), '', rootOf(conv))
	const current: Conversation | null = conversationOf(id)
	if (current == null) return
	if (kernelOk(body) && Array.isArray(body.data)) {
		const rows = body.data as ApiBody[]
		const list: ChatMessage[] = []
		for (let i = 0; i < rows.length; i++) {
			const msg = messageFromHistoryRow(rows[i])
			if (msg.role === 'ai' && msg.text.length === 0) continue
			list.push(msg)
		}
		current.messages = list
	} else {
		current.messages = []
	}
	// 【游标必须对齐快照】快照覆盖了整份已落盘历史，但 replay 游标可能停在
	// 半截（rebuildHistory 中途失败）甚至 0（旧设备无 stream 文件）。不对齐的话
	// probeRunning 的 replayFrom(lastSeq) 会把快照已含的旧帧再渲染一遍（成对
	// 重复）。用 rounds=1 拿最后一轮窗口：Rounds 分支的 latestSeq 是全文件
	// 最大 seq（session/mod.rs pass-1 全量扫描），且窗口只含末轮、开销有界。
	// 【不能用 afterSeq=-1&limit=1】After 分支的 latestSeq 只是「本页末帧
	// seq」（mod.rs bounds_of(&w.events)），limit=1 时拿到的是第一帧 seq，
	// 对齐后反而会把中间整段跳过。【也不用无参 Tail】默认尾窗 2000 帧原始
	// delta，长流上白白多传几 MB；rounds=1 走合帧投影，体积小得多。
	try {
		const probe: ApiBody = await request('GET', '/web/chat/replay', 'sessionId=' + encodeURIComponent(id) + '&rounds=1&maxBytes=' + REPLAY_MAX_BYTES.toString(), '', rootOf(current))
		if (kernelOk(probe) && probe.data != null && typeof probe.data === 'object') {
			const pdata = probe.data as ApiBody
			const latestRaw = pdata.latestSeq
			const latest: number = typeof latestRaw === 'number' ? latestRaw as number : 0
			if (latest > cursorOf(id).lastSeq) cursorOf(id).lastSeq = latest
		}
	} catch (_) {
		// 对齐失败保持现游标：旧设备无 replay 端点时 live 帧 seq 从当前 run 计，
		// consumeFrame 的去重/兜底仍可用，不阻塞快照展示
	}
}

/** 打开会话时同一 id 会被 setActive 同步调用两次（抽屉 onOpenConv + 首页 onOpenConv）。
 *  loaded / running 守卫要等全部 await 结束才写入，拦不住这次并发：两次
 *  rebuildHistory 会各自清空 messages、resetTurnState、全量 replay 并交错写同一数组
 *  （消息重复/错乱真因）。用 in-flight Promise 表在第一个 await 之前占位即可幂等。 */
function loadMessages(id: string): Promise<void> {
	const inflight: Promise<void> | undefined = loadingMessages.get(id)
	if (inflight != null) return inflight
	if (loaded.has(id) || running.has(id)) return Promise.resolve()
	const task: Promise<void> = loadMessagesInner(id)
	loadingMessages.set(id, task)
	const release = (): void => {
		// 只删自己：设备切换期间旧任务收尾时不能把新任务的占位抹掉
		if (loadingMessages.get(id) === task) loadingMessages.delete(id)
	}
	task.then(release, release)
	return task
}

type HistoryResult = { ok: boolean; degraded: boolean }

/** 回放帧是否已经产出可展示内容；只认结构化过程/终态摘要，不把空占位算成功。 */
function hasReplayContent(conv: Conversation | null): boolean {
	if (conv == null) return false
	return conv.messages.some((msg: ChatMessage): boolean =>
		msg.text.length > 0 || msg.blocks.length > 0 || msg.summary.length > 0)
}

/** 文本快照最终只能保住正文：给每条 AI 行落显式提示+重试入口，不假装完整。 */
function markDegradedHistory(id: string): void {
	const conv: Conversation | null = conversationOf(id)
	if (conv == null) return
	const notice: string = t('chat.history.degraded')
	let tail: ChatMessage | null = null
	conv.messages.forEach((msg: ChatMessage): void => {
		msg.degradedNotice = ''
		if (msg.role === 'ai') tail = msg
	})
	if (tail != null) tail.degradedNotice = notice
}

/** 用户点降级提示：清 loaded / in-flight，再走同一套幂等 replay 重建过程与产物卡。 */
function retryHistory(id: string): void {
	if (id.length === 0 || conversationOf(id) == null) return
	loaded.delete(id)
	loadingMessages.delete(id)
	earlierEpoch += 1
	earlierCursors.delete(id)
	earlierMore.delete(id)
	cancelResumeRetry(id)
	loadMessages(id)
}

async function loadMessagesInner(id: string): Promise<void> {
	const devices = useDevices()
	if (devices.activeDeviceId.value.length === 0) return
	const conv: Conversation | null = conversationOf(id)
	if (conv == null) return
	const placeholder: ChatMessage = emptyChatMessage(nextMsgId(), 'ai', '', 'processing', true, false)
	conv.messages = [placeholder]
	let textSnapshotLoaded: boolean = false
	try {
		await ensureConnected(devices.activeDeviceId.value)
		// 【2026-11-25 CodeReview 修复】四处 P0/P1 缺陷完整补救
		// ① 游标对齐丢失：保存首次游标，二次失败时恢复
		// ② degraded 合并：两次都 degraded 时接纳二次（messages 已清空，游标需同步）
		// ③ 异常处理：改为延迟决策，不重复调 loadTextSnapshot
		// ④ loaded 标记：确保所有路径都执行，包括异常处理中

		let built: HistoryResult = await rebuildHistory(id)
		const firstDegraded: boolean = built.degraded
		const firstHasContent: boolean = hasReplayContent(conversationOf(id))
		
		// 只在首次完全失败（无任何部分内容）时才触发二次重试，避免二次清空吞掉首次成果
		if (!built.ok && !firstHasContent) {
			// 【修复 P0-① 游标对齐丢失】保存首次游标，二次 rebuildHistory 会清零，
			// 若二次也失败则恢复首次游标以保证 probeRunning 续拉的游标正确
			const firstCursor = { lastSeq: cursorOf(id).lastSeq, runId: cursorOf(id).runId }
			
			const retryBuilt: HistoryResult = await rebuildHistory(id)
			// 二次若成功则接纳；若二次失败但两次都 degraded，说明虽然都没有完整内容
			// 但二次的游标已对齐（loadTextSnapshot 中会再调 rounds=1），需要恢复
			if (retryBuilt.ok) {
				built = retryBuilt
			} else if (retryBuilt.degraded && firstDegraded) {
				// 【修复 P0-① 游标保护】两次都失败且都 degraded，恢复首次游标
				// 防止 probeRunning 用混乱游标续拉导致重复消费帧
				cursorOf(id).lastSeq = firstCursor.lastSeq
				cursorOf(id).runId = firstCursor.runId
				built = retryBuilt
			} else if (retryBuilt.degraded && !firstDegraded) {
				// 【修复 P0-② degraded 合并】二次比首次更坏但至少有部分内容，
				// messages 已被二次清空，游标也已更新，不还原，接纳二次状态
				built = retryBuilt
			}
			// 否则两次都是完全失败（ok=false, degraded=false），conv.messages=[]，后续走快照兜底
		}
		
		// 【一次判决】先判是否有任何回放内容（包括首次部分 + 二次内容）
		const hasAnyContent: boolean = hasReplayContent(conversationOf(id))
		
		// 【修复 P1-③ 异常处理二次调用】只有完全无内容时才走文本快照，
		// 标记 textSnapshotLoaded 防止异常处理中重复调用同一 API
		if (!hasAnyContent) {
			await loadTextSnapshot(id)
			textSnapshotLoaded = true
		}
		
		// 【修复 P1-④ loaded 标记】确保正常路径都标记，catch 中也会标记
		loaded.add(id)
		// 设备端仍在进行中的轮次：接 live 流并补帧（replay 已把可见历史铺好）。
		// 【先接流，再翻更早轮】接流只需要一次轻量探针 + 从游标续拉；更早轮翻页
		// 是纯展示性补全，绝不能挡在 live 订阅前面（旧实现全量倒拉历史阻塞接流，
		// 运行中任务「进去一直卡住不动」的直接原因）。
		await probeRunning(id)
		// 挂起卡兜底：帧窗口可能已翻过 question 帧（见 probePendingQuestion 注释），
		// 放在 probeRunning 之后——运行中不可能是挂起态，两者互斥，顺序无副作用
		await probePendingQuestion(id)
		// 更早轮后台逐页前插（fire-and-forget：失败保留已展示部分，不影响 live）。
		// 【延后启动】probeRunning 的补帧是异步链（catchUpFrames），立即翻页会让
		// 更早轮的 rounds 请求与补帧的 After 分页在同一 WS 链路上排队互抢；
		// 3s 后启动，运行中任务的最新段先补完，历史前插慢一点无感知。
		if (earlierMore.has(id)) {
			setTimeout((): void => {
				if (earlierMore.has(id) && conversationOf(id) != null) loadEarlierRounds(id)
			}, 3000)
		}
	} catch (_) {
		const current: Conversation | null = conversationOf(id)
		if (current == null) {
			loaded.add(id)
			return
		}
		// 【修复 P1-③ 异常处理延迟决策】仅当正常流未调 loadTextSnapshot 时才调，
		// 避免二次消费同一 API；检查是否有内容而不是无条件调用
		if (!textSnapshotLoaded && !hasReplayContent(current)) {
			try {
				await loadTextSnapshot(id)
			} catch (_e) {
				current.messages = []
			}
		}
		// 【修复 P1-④ loaded 标记必须执行】确保 loaded.add 在异常路径也被调用，
		// 防止无限重加载循环。正常路径已在上面执行，这里补异常路径。
		loaded.add(id)
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
		// 【探针必须轻量 · 2026-11-24】旧实现 afterSeq=0&limit=1 走 After 分支：
		// 内核对整个流文件全量扫描 + 逐帧计数（total_after），长流上这一步就秒级；
		// rounds=1 只解析末轮窗口，latestSeq 同样是全文件最大 seq，开销有界。
		const body: ApiBody = await request('GET', '/web/chat/replay', 'sessionId=' + encodeURIComponent(id) + '&rounds=1&maxBytes=' + REPLAY_MAX_BYTES.toString(), '', rootOf(conv))
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
		// 【必须从历史游标续拉，不能从 0 重放】loadMessages 已把持久帧回放进 messages，
		// 这里若 again afterSeq=0，整段历史会被再消费一遍 → 用户行/AI 行成对重复、
		// 顺序错乱（用户报障「消息加载有的时候都是错乱的」的主因之一）。
		// 拉取失败退避重试（桌面 scheduleStreamingRecovery 同款）：接流后不再
		// 依赖链路 resumed 事件，单页超时也能把缺的段补回来。
		catchUpFrames(id).then((ok: boolean): void => {
			if (!ok && running.has(id)) scheduleResumeRetry(id)
		})
		// 【看门狗】旧设备中转不建 gate 订阅 / done 帧丢失时，running 会永久残留、
		// 占位一直「思考中」。周期用轻量 rounds=1 探针对账内核权威 running 态。
		armRunWatchdog(id)
	} catch (_) {
		// 探测失败不打扰：用户发送时会再走 ensureConnected
	}
}

/** 打开会话时探测后端权威挂起态（契约 §3.4 的 pendingQuestion 端点）。
 *
 *  【为什么必须有这一步】挂起卡唯一来源是 question 帧；帧只在挂起那一刻广播一次，
 *  历史 /messages 只给文本快照，replay 的帧窗口也可能已经翻过它。于是三种真实漏卡：
 *  ① 挂起时手机没开这个会话（帧广播给的是在线连接，不是存档订阅）；
 *  ② 手机断线重连后 replay 起点已过 question 帧；
 *  ③ 冷启动进会话，历史文本里根本没有这道题。
 *  桌面端同款兜底（app-history.js:3043-3047 的 probePendingQuestion）：
 *  回放与实时缓冲都排空后，问一次后端「现在到底有没有挂起的提问」，有就补建卡。
 *
 *  只处理 question：HITL 挂起不在该端点范围（内核 mod.rs:3907 明确 return null），
 *  审批卡靠 hitl 帧 + hitl_released 帧配对，没有权威探针可用。 */
async function probePendingQuestion(id: string): Promise<void> {
	const conv: Conversation | null = conversationOf(id)
	if (conv == null) return
	try {
		const body: ApiBody = await request('GET', '/web/chat/pendingQuestion', 'sessionId=' + encodeURIComponent(id), '', rootOf(conv))
		if (!kernelOk(body)) return
		// await 期间会话可能被删/设备切换，放弃回写。
		// 【不要按 running 短路】挂起期间 running 本来就可能为 true（sendMessage 置起、
		// done(suspended) 不清），按它拦会把「发送后挂起」这个最常见场景的兜底整个废掉。
		// 重复建卡由下面「同 actionId 已有卡」守卫兜住（帧链与探针用同一个 notice:<id> 键）。
		const current: Conversation | null = conversationOf(id)
		if (current == null) return
		const data = body.data
		if (data == null || typeof data !== 'object') {
			// 权威 null：本地还挂着未提交的问答卡 = 僵尸卡（他端已答/挂起过期被清）。
			// 桌面端同款收口（app-message.js:4681-4734），否则手机永远显示一张点了必 409 的卡。
			closeZombieQuestions(current)
			return
		}
		const payload = data as ApiBody
		const actionId: string = fieldString(payload, 'actionId')
		const questions: AskQuestion[] = parseAskQuestions({ args: payload })
		if (questions.length === 0) {
			closeZombieQuestions(current)
			return
		}
		const msg: ChatMessage | null = lastAiMessage(current)
		if (msg == null) return
		// 【只查尾条，绝不 blockOf 全量】blockOf 会把历史轮里同 actionId 的【已闭环】卡
		// 也当成命中：要么误判「已有卡」漏建，要么 ensureBlock 复用旧卡把已答记录翻回待答。
		const key: string = 'notice:' + (actionId.length > 0 ? actionId : nextBlockId())
		const inTail: ChatBlock | undefined = msg.blocks.find((item: ChatBlock): boolean => item.id === key)
		if (inTail != null) return
		const block: ChatBlock = ensureBlock(current, key, 'notice', t('chat.interact.askTitle'), 'help')
		block.process = false
		block.actionId = actionId
		block.status = 'warn'
		block.interact = 'question'
		block.questions = questions
		block.answers = emptyAskAnswers(questions.length)
		block.submitting = false
		block.submitError = ''
		block.resolvedText = ''
		const firstHeader: string = questions[0].header
		block.body = firstHeader
		block.preview = previewOf(firstHeader, false)
		msg.meta = t('chat.interact.pendingMeta')
	} catch (_) {
		// 探针失败不打扰用户：下一次进会话会重试
	}
}

/** 权威挂起态为 null 时收掉本地僵尸问答卡（只动 question，HITL 不在探针范围）。
 *  正在提交中的卡不收：请求在途，结果马上回来，收了反而闪断。 */
function closeZombieQuestions(conv: Conversation): void {
	conv.messages.forEach((msg: ChatMessage): void => {
		msg.blocks.forEach((item: ChatBlock): void => {
			if (item.interact !== 'question' || item.status !== 'warn' || item.submitting) return
			item.interact = 'resolved'
			item.status = 'done'
			item.resolvedText = t('chat.interact.resolved')
		})
		if (msg.meta === t('chat.interact.pendingMeta') && pendingInteractBlock(conv, '') == null) msg.meta = ''
	})
}

/* ---------------- 文件变更快照（桌面 app-file-changes.js 契约对齐） ---------------- */

/** changeType → 行首徽标（桌面 KIND_BY_CHANGE_TYPE），未知一律按 M */
function changeKind(raw: string): string {
	const type: string = raw.toUpperCase()
	if (type === 'ADDED') return 'A'
	if (type === 'DELETED') return 'D'
	return 'M'
}

function statNumber(value: any | null): number {
	if (typeof value === 'number') return Math.max(0, Math.round(value as number))
	return 0
}

/** 解析 file_changes 帧的 args.files[] → 展示行。逐字段判型，坏帧降级为空数组不抛异常。
 *  纯函数（不依赖模块状态），verify-mobile-fixes 直接抽取执行。 */
function parseFileChanges(args: ApiBody): ChatFileChange[] {
	const raw = args['files']
	if (!Array.isArray(raw)) return []
	const rows = raw as ApiBody[]
	const out: ChatFileChange[] = []
	for (let i = 0; i < rows.length; i++) {
		const row: ApiBody = rows[i]
		const path: string = fieldString(row, 'path')
		if (path.length === 0) continue
		out.push({
			path: path,
			kind: changeKind(fieldString(row, 'changeType')),
			additions: statNumber(row['additions']),
			deletions: statNumber(row['deletions'])
		} as ChatFileChange)
	}
	return out
}

/** file_changes → 每 run 一张紧凑变更卡（「已编辑 N 个文件 +x -y」+ 文件行）。
 *  产品口径与桌面一致：files 为空的快照不落卡、不展示任何提示（possiblyIncomplete
 *  等警示字段一律不上界面）；同 runId 的后续 revision 整卡替换，绝不逐帧堆行。 */
function applyFileChanges(conv: Conversation, frame: LinkFrame): void {
	const changes: ChatFileChange[] = parseFileChanges(frameArgs(frame))
	const runId: string = fieldString(frame, 'runId')
	const key: string = 'changes:' + (runId.length > 0 ? runId : 'latest')
	const tail: ChatMessage | null = lastAiMessage(conv)
	// 迟到帧：done 之后到达时并回上一条已收口的 AI 消息（不新建空气泡）；
	// 无尾条且无文件（纯警示快照）直接忽略，不为空卡建占位
	if (changes.length === 0) {
		// 空 files 的后续 revision 意味着整轮撤销：已有卡也要移除
		if (tail != null) {
			const idx: number = tail.blocks.findIndex((item: ChatBlock): boolean => item.id === key)
			if (idx >= 0) tail.blocks.splice(idx, 1)
		}
		return
	}
	const msg: ChatMessage | null = ensureStreamingTail(conv)
	if (msg == null) return
	/* 【2026-11 用户报障「思考显示顺序都乱了，也没折叠」】file_changes 是 run 级
	   被动快照（PC onWebChunk 对它短路：不推进相位、不清 thinking、不收批次），
	   旧实现却在这里 msg.thinking=false + closeBatch —— 快照常在思考/工具【之间】
	   到达，每来一次就把运行批次拦腰切断：前半截提前收成「执行工具 N 次」，
	   后半截思考另开新盖子，视觉上就是「顺序乱 + 没折叠」。
	   被动快照不得动批次/正文段/思考相位边界，与 PC 同口径。 */
	let additions: number = 0
	let deletions: number = 0
	changes.forEach((row: ChatFileChange): void => {
		additions += row.additions
		deletions += row.deletions
	})
	const block: ChatBlock = ensureBlock(conv, key, 'notice',
		t('chat.changes.edited', { n: changes.length.toString() }), 'info')
	block.process = false
	block.status = 'done'
	// args 字段被 UI 用作卡片类型标记（fileChanges），不再放参数摘要
	block.args = 'fileChanges'
	/* 【⑳ 层级豁免】ensureBlock 会把新块挂到当前运行批次 batchId 下：卡片若留在
	   批次里，收起批次时被成员过滤连坐隐藏（变更记录整块消失）、展开时被 26px
	   缩进 + 引导线包进成员区（卡片不是过程证据，与 PC KEEP_VISIBLE 白名单同口径）。
	   清空归属 = 常驻行段（head=null 独立成段，不进滚动窗、不缩进）。 */
	block.batchId = ''
	block.batchCollapsed = false
	block.changes = changes
	block.preview = ''
	const parts: string[] = []
	if (additions > 0) parts.push('+' + additions.toString())
	if (deletions > 0) parts.push('-' + deletions.toString())
	block.body = parts.join(' ')
	sinkChangesBlocks(msg)
	/* 【终态兜底 · 2026-11 用户「任务都执行结束了竟然还显示正在执行中」】
	   file_changes 是 run 级收尾快照（真实帧序 trace → done → file_changes），
	   是比 done 更靠后的最后信号。done 之后仍可能有迟到的过程帧（background
	   agent_end / action_batch）经 ensureProcessBatch 重新开一个 loading 盖子，
	   此后没有任何帧再收口 → batchLabel 每秒刷「正在执行中 · Ns」。
	   但【绝不】无条件收批次：上轮已实证被动快照常在思考/工具之间到达，
	   那时切批次正是「顺序乱 + 没折叠」的真因。故只在本条 AI 消息【已终态】
	   且非回放/非运行时收敛残留 loading 盖子，与桌面 settleChangesCard 同口径。 */
	settleTerminalBatchHeads(conv, msg)
	/* 【2026-11-25 与桌面同源自愈】Rust forwarder 在 run 结束后仍推后台帧，
	   done 的 compactTurn 已把 counts/compactOpen 固化；迟到过程帧随后 push
	   进 blocks：折叠态虽会隐藏它们（process=true），摘要 chips 却永远停在
	   收口瞬间的旧计数 = PC「摘要 1 段思考 / 屏幕 4 段思考」的同款错位。
	   终态 + 非回放 + 非运行时，按 blocks 真实计数刷新 counts（幂等、常态零
	   写入），卡片一并钉底；绝不改 compactOpen，用户手动展开态原样保留。 */
	if (msg.status === 'done' || msg.status === 'stopped') {
		let tools: number = 0
		let reasons: number = 0
		let agents: number = 0
		let batches: number = 0
		msg.blocks.forEach((item: ChatBlock): void => {
			if (isChangesBlock(item)) return
			if (item.kind === 'batch') batches += 1
			else if (item.kind === 'tool') tools += 1
			else if (item.kind === 'thinking') reasons += 1
			else if (item.kind === 'agent') agents += 1
		})
		const c = msg.counts
		if (c.tools !== tools || c.reasons !== reasons || c.agents !== agents || c.batches !== batches) {
			msg.counts = { tools, reasons, agents, batches, texts: c.texts }
		}
		sinkChangesBlocks(msg)
	}
}

/** 终态残留批次盖子收敛（PC closeBatchFor + settleChangesCard 同口径）。
 *  只处理 status==='done'/'stopped' 且非回放/非运行的消息：把 status==='loading'
 *  的批次头定格为分类计数摘要、清计时起点、成员连坐收起。运行中/挂起/回放
 *  一律零写入，绝不拦腰切断活批次。 */
function settleTerminalBatchHeads(conv: Conversation, msg: ChatMessage): void {
	if (historyReplay.has(conv.id) || running.has(conv.id)) return
	if (msg.status !== 'done' && msg.status !== 'stopped') return
	msg.blocks.forEach((head: ChatBlock): void => {
		if (head.kind !== 'batch' || head.status !== 'loading') return
		let tools: number = 0
		let reasons: number = 0
		msg.blocks.forEach((item: ChatBlock): void => {
			if (item.batchId !== head.id) return
			if (item.kind === 'tool') tools += 1
			else if (item.kind === 'thinking') reasons += 1
		})
		const parts: string[] = []
		if (tools > 0) parts.push(t('chat.batch_done_count', { count: tools.toString() }))
		if (reasons > 0) parts.push(t('chat.batch_thinking_count', { count: reasons.toString() }))
		head.label = parts.length > 0 ? parts.join(' · ') : t('chat.batch_done')
		head.status = 'done'
		head.startedAt = 0
		head.batchCollapsed = true
		msg.blocks.forEach((item: ChatBlock): void => {
			if (item.id !== head.id && item.batchId === head.id && item.kind !== 'agent') item.batchCollapsed = true
		})
	})
	const st: TurnState = turnStateOf(conv.id)
	if (st.batchOpen) { st.batchOpen = false; st.batchId = ''; st.batchStartedAt = 0 }
}

/** 变更卡判定不能只靠 args 字符串标记：回放/兼容帧里 marker 若缺失，
 *  已有 changes[] 的块仍必须钉底渲染，否则用户看到产物卡整个消失。 */
function isChangesBlock(item: ChatBlock): boolean {
	return item.args === 'fileChanges' || item.changes.length > 0
}

/** 变更卡钉底（过程区数据层，PC insertBeforeActions 越过 fch-host 同口径）：
 *  file_changes 是 run 级被动快照，常在正文/思考帧【之间】到达；若留在到达时序位，
 *  后到的思考/正文全部排在卡片下方——用户报障「文件变更卡怎么跑到这里了，之前不是
 *  在正文最后嘛；思考显示顺序都乱了」。这里把全部变更卡搬到 blocks 末尾，保证
 *  过程区（segments）里不会夹卡污染批次分段/限高窗；【视觉钉底由模板层负责】：
 *  app-chat-bubble.uvue 的 changesBlocks 把卡渲染在最终正文 message.text 之后、
 *  meta 之前（模板里 showProcess 恒在正文前，只靠数组末尾不够 —— 上版改错层级
 *  正是「刚刚修改还是不对」的残留真因）。幂等：已在末尾时零移动；多卡保序。 */
function sinkChangesBlocks(msg: ChatMessage): void {
	const keep: ChatBlock[] = []
	const cards: ChatBlock[] = []
	msg.blocks.forEach((item: ChatBlock): void => {
		if (isChangesBlock(item)) cards.push(item)
		else keep.push(item)
	})
	if (cards.length === 0) return
	// 已全部在末尾且保序：零写入（避免每帧重建响应式数组触发无谓重渲染）
	let tailOk: boolean = true
	for (let i = 0; i < cards.length; i++) {
		if (msg.blocks[msg.blocks.length - cards.length + i] !== cards[i]) { tailOk = false; break }
	}
	if (tailOk) return
	msg.blocks = keep.concat(cards)
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
	const aiMsg: ChatMessage = emptyChatMessage(nextMsgId(), 'ai', '', 'processing', true, false)
	conv.messages.push(aiMsg)
}

/** sessionId = 渲染目标（影子会话前插时为影子 id，游标/轮状态/回放标记按它隔离）；
 *  wireId = 设备端真实会话 id（附件 meta 请求 / steer 登记键等「对外身份」用它，
 *  内核按真实会话目录解析附件，传影子 id 会整批必败）。缺省与渲染目标一致。 */
function consumeFrame(sessionId: string, frame: LinkFrame, wireId?: string): void {
	const realId: string = wireId != null && wireId.length > 0 ? wireId : sessionId
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
	const state: TurnState = turnStateOf(sessionId)
	// 非 text 帧到达先落账在途正文（工具卡插入/收口/用户插话前正文必须完整可见，
	// 否则过程行挤进正文前面时最后 120ms 的 delta 还悬在缓冲里）
	if (kind !== 'text') flushTextBuf(sessionId)

	/* 【变更卡钉底 · 与 PC insertBeforeActions 越过 fch-host 同口径】变更卡已落位后，
	   任何后到的内容帧都可能把新块 push 到卡片之后（blocks 是时序数组）。在帧消费入口
	   统一收敛一次：卡片恒在过程区末尾，后到思考/工具/正文不再被卡片压头。
	   幂等且常态零写入（sinkChangesBlocks 自带已在末尾短路），每帧开销 O(blocks)。 */
	{
		const sinkTail: ChatMessage | null = lastAiMessage(conv)
		if (sinkTail != null) sinkChangesBlocks(sinkTail!)
	}
	
	// 桌面 clearRetryChunk：任何真实内容帧到达都清掉临时 retry 提示（retry 分支自身除外）
	if (kind !== 'retry' && kind !== 'done' && kind !== 'error') {
		const tail: ChatMessage | null = lastAiMessage(conv)
		if (tail != null && tail.status === 'processing') clearRetryBlocks(tail)
	}

	// 手动停止后设备端仍可能吐出少量在途帧：不再复活占位（done/error 只做收口清理）
	if (!running.has(sessionId) && !historyReplay.has(sessionId) && kind !== 'done' && kind !== 'error') {
		const tail: ChatMessage | null = lastAiMessage(conv)
		if (tail != null && tail.status === 'stopped') return
	}

	if (kind === 'user' || kind === 'user_input') {
		const text: string = fieldString(frame, 'text')
		// 【不能先丢空文本】纯附件消息（PC 端发图不带字）内核 user 帧 text 为空串，
		// 附件在 imagePaths/filePaths 里。先 return 会把整帧吞掉：手机上既看不到这条
		// 提问、本端 echo 登记也不销账（残留登记会误吞下一条他端消息）。
		// 空文本时用附件占位文案渲染（与桌面 streaming.describe_images/process_files 同口径）。
		const imgPaths = frame['imagePaths']
		const filePaths = frame['filePaths']
		const imgCount: number = Array.isArray(imgPaths) ? (imgPaths as string[]).length : 0
		const fileCount: number = Array.isArray(filePaths) ? (filePaths as string[]).length : 0
		const displayText: string = text.length > 0 ? text
			: (imgCount > 0 ? t('chat.attachmentImages', { n: imgCount.toString() })
				: (fileCount > 0 ? t('chat.attachmentFiles', { n: fileCount.toString() }) : ''))
		if (displayText.length === 0) return
		// 插画/图片附件还原（PC renderUserAttachmentPaths 同款）：user 帧只带 session 内
		// 相对路径，历史回放必须经 /web/chat/attachment/meta 换回 dataUrl 才能看到图——
		// 旧实现只有「[图片N]」占位文案，纯图片消息（如生成插画）在移动端永远看不到图。
		// 异步升级不阻塞回放时序；成功后 imageUrls 填充触发响应式重渲染。
		const attachImgPaths: string[] = Array.isArray(imgPaths) ? (imgPaths as string[]).filter((p: any): boolean => typeof p === 'string') : []
		// 【身份去重 · 优先于文本去重】内核会把 user 帧广播给该设备的所有客户端
		// （否则从手机发出的提问在 PC 端完全不可见：只看到回答、看不到问题）。
		// 本端发送时带了 clientMessageId，回显帧带回同一个 id 即证明是自己发的，
		// 本地那行已经乐观插好了 → 直接跳过，不再按文本猜。
		// 旧实现只能靠「尾部同文」猜，用户连发两条相同消息时会把第二条真丢。
		const ownMsgId: string | undefined = pendingClientMsgId.get(sessionId)
		const echoMsgId: string = fieldString(frame, 'clientMessageId')
		if (!historyReplay.has(sessionId) && ownMsgId != null && echoMsgId.length > 0 && echoMsgId === ownMsgId) {
			// 内核可能改写了文本（[附件:xxx] 前缀 / Loop 前缀）：把最终文本覆盖回本地那行。
			// 覆盖目标优先按「本端登记的原文」定位：直接取最后一条 user 行会在
			// 「本端发送在途期间他端又插了一条消息」时改错行（他端消息被改成本端文本）。
			// 注意先取登记再销账（旧实现先 delete 再读，永远拿到 undefined）。
			const sentText: string | undefined = pendingUserEcho.get(sessionId)
			pendingClientMsgId.delete(sessionId)
			pendingUserEcho.delete(sessionId)
			for (let i = conv.messages.length - 1; i >= 0; i--) {
				const row: ChatMessage = conv.messages[i]
				if (row.role !== 'user') continue
				if (sentText != null && row.text !== sentText) continue
				row.text = displayText
				break
			}
			return
		}
		// 【去重口径】只对「本端刚发出的那条」去重，且【仅限实时流】，不再对整段历史 some() 匹配。
		// 旧实现按全文匹配 conv.messages：同一会话里用户两次发「继续」、或历史里本就重复的命令，
		// 第二条会被当成重复帧直接丢弃 → 该轮用户行缺失、后续 AI 行前移，
		// 整段历史错位（「消息加载错乱」的第一个真因）。
		// 回放期必须完全跳过它：replay(afterSeq=0) 会重新吐出历史 user 帧，
		// 其中很可能就有和 echo 同文的旧消息，跳过就会丢行。
		// 【文本兜底仅限无 id 帧】帧带 clientMessageId 且 ≠ 本端登记 id 时必是他端消息
		// （桌面/Loop 插话），必须渲染——旧实现只要有登记就把第一条 user 帧当自己的
		// 回显销账，他端消息被吞 + 本地行被改写（P0）。无 id 的旧内核帧才走文本兜底。
		if (!historyReplay.has(sessionId) && echoMsgId.length === 0) {
			const echo: string | undefined = pendingUserEcho.get(sessionId)
			if (echo != null) {
				// 【不能要求全文相等】sendMessage 已把本地 user 行插入列表，内核回显的 text
				// 却可能被改写（附件 [附件:xxx] 前缀 / Loop 的 loopFilePrefix / 插话合成）。
				// 旧实现用 echo === text 精确比对：一旦前缀存在就判为「不是本端 echo」，
				// 走下面分支再插一行 → 同一句话出现两条用户气泡。
				// 本端有待回显登记时，第一条 user 帧必定属于这次发送：把内核最终文本覆盖回
				// 本地那行（保留在列表中的原位置），然后直接返回，绝不插入第二条。
				pendingUserEcho.delete(sessionId)
				for (let i = conv.messages.length - 1; i >= 0; i--) {
					const row: ChatMessage = conv.messages[i]
					if (row.role !== 'user') continue
					if (row.text === echo) {
						row.text = displayText
						// 本端附件在乐观行已内联 dataUrl；无图占位（上传失败/旧内核）按帧路径补拉
						if (row.imageUrls.length === 0 && attachImgPaths.length > 0) {
							upgradeUserAttachments(realId, rootOf(conv), row, attachImgPaths)
						}
					}
					break
				}
				return
			}
		}
		// 【相邻同文去重】只在「紧邻上一条就是同文 user 行」时合并。
		// user 与 user_input 是两条互斥路径（doOnChatInput→ofUser / Loop 准备→ofUserInput），
		// 不会在同一轮各发一条；这里防的是内核把同一次输入重复落到 stream 文件。
		const tailMsg: ChatMessage | undefined = conv.messages.length > 0 ? conv.messages[conv.messages.length - 1] : undefined
		if (tailMsg != null && tailMsg.role === 'user' && tailMsg.text === displayText) return
		// 历史回放：user 帧是一轮边界，先收口上一轮 AI 尾条，再重置轨迹状态
		if (historyReplay.has(sessionId)) {
			// 【顺序修正】回放若从「运行中段的助手帧」开始（流文件被截断、steer/后台续跑），
			// 首个 user 帧之前已建了空 AI 占位；直接 push 会让 user 落在 AI 之后 → 轮次颠倒。
			// 空尾条（无正文无块）在这里丢弃，由下面按需重建到 user 之后。
			const tail: ChatMessage | undefined = conv.messages.length > 0 ? conv.messages[conv.messages.length - 1] : undefined
			if (tail != null && tail.role === 'ai' && tail.text.length === 0 && tail.blocks.length === 0) {
				conv.messages.pop()
			} else {
				// 回放切轮：0 = 历史无真实耗时，不伪造「已完成 1s」
				finishProcessingTail(conv, 0)
			}
			resetTurnState(sessionId)
		}
		const userMsg: ChatMessage = emptyChatMessage(nextMsgId(), 'user', displayText, 'done', false, false)
		// 【顺序修正 · 实时流】sendMessage 已在尾部建了 processing 的 AI 占位。
		// 若这条 user 帧不是本端 echo（他端发起 / Loop 定时任务 / 带附件前缀改写文本），
		// 直接 push 会把用户行放到【本轮 AI 占位之后】→ 同一轮里 AI 在上、用户在下，
		// 整段对话看起来「堆叠错乱」。占位仍为空时把用户行插到它前面，保持 user→AI 顺序。
		if (!historyReplay.has(sessionId)) {
			const tail: ChatMessage | undefined = conv.messages.length > 0 ? conv.messages[conv.messages.length - 1] : undefined
			if (tail != null && tail.role === 'ai' && tail.status === 'processing'
				&& tail.text.length === 0 && tail.blocks.length === 0) {
				conv.messages.splice(conv.messages.length - 1, 0, userMsg)
				conv.updatedAt = Date.now()
				return
			}
		}
		conv.messages.push(userMsg)
		// 附件缩略图升级（回放/他端消息两条路径的公共落点；本端 echo 已在本地行持有）
		if (attachImgPaths.length > 0) {
			upgradeUserAttachments(realId, rootOf(conv), userMsg, attachImgPaths)
		}
		// 实时发送时 sendMessage 已建 AI 占位；只有历史回放需要按 user 帧切轮补占位
		if (historyReplay.has(sessionId)) appendStreamingPlaceholder(conv)
		return
	}

	// 过程块到来前先建运行批次盖子；正文/轮结束是批次边界（桌面 GourdTurnBatch 同款）
	const processKind: boolean = kind === 'reason' || kind === 'action_draft' || kind === 'action_start' || kind === 'action_args' || kind === 'action_batch' || kind === 'action_end' || kind === 'agent_start' || kind === 'agent_progress' || kind === 'agent_end'
	if (processKind) {
		ensureProcessBatch(conv, t('chat.turn.running'))
		// 正文段边界：收口当前正文段，后续 text 另起新段落在过程行之后
		// （桌面「工具卡产出后新开空 .md-content」的正文指针推进同款）
		closeTextSegment(conv)
	}

	if (kind === 'text') {
		// 子代理正文与主正文同为 text 帧，靠 args.agentName/invocationId 区分归属。
		// 归属必须命中已存在的活跃子智能体卡（桌面 resolveAgentState 同款），
		// 否则一律按主正文处理，避免 Java agentDesc 命名差异把正文漏进主气泡。
		const msg: ChatMessage | null = ensureStreamingTail(conv)
		if (msg == null) return
		msg.thinking = false
		const delta: string = fieldString(frame, 'text')
		const agentKey: string = agentOwnerKey(conv, frame)
		if (agentKey.length > 0) {
			const name: string = agentNameOf(frame)
			const desc: string = agentArgDesc(frame)
			const card: ChatBlock | null = blockOf(conv, agentKey)
			if (card != null) {
				card.body += delta
				card.preview = previewOf(card.body, false)
				card.status = 'loading'
				if (desc.length > 0 && card.args.length === 0) card.args = desc
			} else {
				appendOwnedText(conv, 'agent', t('chat.segment.agent', { name: name.length > 0 ? name : t('chat.segment.agentFallback') }), 'user', delta, agentKey)
			}
			// 子代理正文到达同样要收口其所在批次（桌面 appendAgentBodyContent 同款）
			settleThinking(conv)
		state.reasonKey = ''
			return
		}
		closeBatch(conv, false)
		settleThinking(conv)
		state.reasonKey = ''
		appendFinalText(conv, msg, state, delta)
		conv.updatedAt = Date.now()
		return
	}

	if (kind === 'reason_start') {
		// 桌面端不建 DOM：只把相位切到 thinking，后续 reason 帧才建 .thinking-block
		const msg: ChatMessage | null = ensureStreamingTail(conv)
		if (msg != null) msg.thinking = true
		state.reasonKey = nextBlockId()
		state.reasonOwner = ''
		return
	}

	if (kind === 'reason') {
		const msg: ChatMessage | null = ensureStreamingTail(conv)
		if (msg == null) return
		msg.thinking = false
		if (state.reasonKey.length === 0) state.reasonKey = nextBlockId()
		const agentKey: string = agentOwnerKey(conv, frame)
		const owner: string = agentKey.length > 0 ? agentKey + '/reason:' + state.reasonKey : 'reason:' + state.reasonKey
		appendOwnedText(conv, 'thinking', t('chat.segment.thinking'), 'sleep', fieldString(frame, 'text'), owner)
		// 思考行起始时刻：收口时算「已思考 (Ns)」耗时（PC thinking-current-timer 同口径）
		const tb: ChatBlock | null = blockOf(conv, owner)
		if (tb != null && tb.startedAt === 0) tb.startedAt = Date.now()
		return
	}

	if (kind === 'action_batch') {
		// 批次声明帧只报 batchId/batchSize/成员清单，【没有】toolName/actionId。
		// 桌面 applyActionBatchChunk 只把已存在的成员骨架卡收编进容器、绝不建卡；
		// 早期实现按 actionId 兜底建卡 → 每个批次帧多出一张「工具 正在执行…」空卡，
		// 一轮多批次就是整列堆叠（用户报障「有的显示会被堆叠」的真因）。
		const msg: ChatMessage | null = ensureStreamingTail(conv)
		if (msg == null) return
		msg.thinking = false
		settleThinking(conv)
		state.reasonKey = ''
		const within: number = typeof frame['batchSize'] === 'number' ? frame['batchSize'] as number : 0
		if (within > 0) {
			// 只更新运行批次盖子的成员数，不新建任何行
			const head: ChatBlock | undefined = msg.blocks.find((item: ChatBlock): boolean => item.id === state.batchId)
			if (head != null) head.batchCount = within
		}
		return
	}

	if (kind === 'action_draft' || kind === 'action_start' || kind === 'action_args') {
		const msg: ChatMessage | null = ensureStreamingTail(conv)
		if (msg == null) return
		msg.thinking = false
		settleThinking(conv)
		state.reasonKey = ''
		const actionId: string = fieldString(frame, 'actionId')
		const tool: string = fieldString(frame, 'toolTitle').length > 0 ? fieldString(frame, 'toolTitle') : fieldString(frame, 'toolName')
		// 骨架卡归一：优先按 actionId 幂等复用；无 actionId 时沿用本轮「当前骨架卡」，
		// 让 action_draft → action_args*（无 id）→ action_start 全程只占一行。
		let key: string = ''
		if (actionId.length > 0) key = 'tool:' + actionId
		else if (kind === 'action_args' && state.pendingToolKey.length > 0) key = state.pendingToolKey
		else key = 'tool:' + nextBlockId()
		const block: ChatBlock = ensureBlock(conv, key, 'tool', tool.length > 0 ? resolveToolLabel(fieldString(frame, 'toolName'), fieldString(frame, 'toolTitle')) : t('chat.segment.toolFallback'), 'set')
		if (actionId.length > 0) block.actionId = actionId
		block.bareTool = bareToolName(fieldString(frame, 'toolName'), fieldString(frame, 'toolTitle'))
		if (tool.length > 0) block.label = resolveToolLabel(fieldString(frame, 'toolName'), fieldString(frame, 'toolTitle'))
		const fargs: ApiBody = frameArgs(frame)
		block.fileName = fileNameOf(fargs)
		const ds: string[] = diffStatOf(fargs)
		block.diffAdd = ds[0]
		block.diffDel = ds[1]
		const argsText: string = summarizeArgs(frame)
		if (argsText.length > 0) {
			block.args = argsText
			// 有真实参数时清空占位预览：桌面行内只显示 args，不再叠一句「正在执行…」
			block.preview = ''
		} else {
			const bytes: string = fieldString(frame, 'argsBytes')
			// PC 骨架期只有参数进度（B/KB/MB 人类可读），无「正在执行 {name}」占位文案
			if (bytes.length > 0) block.preview = t('chat.segment.argsBytes', { n: formatBytes(parseInt(bytes)) })
			else block.preview = ''
		}
		block.status = 'loading'
		state.pendingToolKey = key
		if (actionId.length > 0 && !state.toolStarts.has(actionId)) state.toolStarts.set(actionId, Date.now())
		msg.meta = ''
		return
	}

	if (kind === 'action_end') {
		const msg: ChatMessage | null = ensureStreamingTail(conv)
		if (msg == null) return
		settleThinking(conv)
		state.reasonKey = ''
		const actionId: string = fieldString(frame, 'actionId')
		const tool: string = fieldString(frame, 'toolTitle').length > 0 ? fieldString(frame, 'toolTitle') : fieldString(frame, 'toolName')
		// 配对顺序与 draft/args 一致：actionId > 本轮当前骨架卡 > 新建
		let key: string = ''
		if (actionId.length > 0) key = 'tool:' + actionId
		else if (state.pendingToolKey.length > 0 && blockOf(conv, state.pendingToolKey) != null) key = state.pendingToolKey
		else key = 'tool:' + nextBlockId()
		const existed: ChatBlock | null = blockOf(conv, key)
		const block: ChatBlock = ensureBlock(conv, key, 'tool', tool.length > 0 ? resolveToolLabel(fieldString(frame, 'toolName'), fieldString(frame, 'toolTitle')) : t('chat.segment.toolFallback'), 'set')
		const result: string = fieldString(frame, 'text')
		if (actionId.length > 0) block.actionId = actionId
		block.bareTool = bareToolName(fieldString(frame, 'toolName'), fieldString(frame, 'toolTitle'))
		if (tool.length > 0) block.label = resolveToolLabel(fieldString(frame, 'toolName'), fieldString(frame, 'toolTitle'))
		const eargs: ApiBody = frameArgs(frame)
		if (fileNameOf(eargs).length > 0) block.fileName = fileNameOf(eargs)
		const eds: string[] = diffStatOf(eargs)
		if (eds[0].length > 0) block.diffAdd = eds[0]
		if (eds[1].length > 0) block.diffDel = eds[1]
		block.body = result.length > 0 ? result : block.body
		block.preview = result.length > 0 ? previewOf(result, false) : block.preview
		block.status = statusOf(frame)
		block.failed = block.status === 'reject'
		const started: number | undefined = actionId.length > 0 ? state.toolStarts.get(actionId) : undefined
		const durationRaw = frame['durationMs']
		const durationMs: number = typeof durationRaw === 'number' ? durationRaw as number : -1
		block.duration = durationMs >= 0
			? (durationMs >= 1000 ? (Math.round(durationMs / 100) / 10).toString() + 's' : Math.round(durationMs).toString() + 'ms')
			: durationLabel(started != null ? started : Date.now(), '')
		// 收口后清空当前骨架指针：同一轮的下一次工具调用必须另起一行
		if (state.pendingToolKey === key) state.pendingToolKey = ''
		msg.meta = ''
		return
	}

	if (kind === 'agent_start' || kind === 'agent_progress' || kind === 'agent_end') {
		const msg: ChatMessage | null = ensureStreamingTail(conv)
		if (msg == null) return
		msg.thinking = false
		settleThinking(conv)
		state.reasonKey = ''
		const agentKey: string = agentKeyOf(frame)
		const name: string = agentNameOf(frame)
		const desc: string = fieldString(frame, 'text').length > 0 ? fieldString(frame, 'text') : agentArgDesc(frame)
		const key: string = agentKey.length > 0 ? agentKey : 'agent:' + nextBlockId()
		if (agentKey.length > 0 && name.length > 0) state.agentKeys.set(agentKey, name)
		const block: ChatBlock = ensureBlock(conv, key, 'agent', t('chat.segment.agent', { name: name.length > 0 ? name : t('chat.segment.agentFallback') }), 'set')
		// 子智能体卡在轮结束后【不随 Compact 隐藏】：桌面 appendAgentBadge 把徽章直接挂到气泡上，
		// 不在 [data-turn-process] 容器里，所以折叠过程轨迹时它仍然常驻。
		// 旧实现沿用 process=true → 一轮结束就整块消失，用户看到的就是「智能体消息没展示」。
		block.process = false
		block.agentName = name.length > 0 ? name : (state.agentKeys.get(key) ?? '')
		block.args = desc.length > 0 ? desc : block.args
		if (kind === 'agent_end') {
			const summary: string = argString(frame, 'resultSummary')
			// 成功且已有流式正文时不再用 resultSummary 覆盖（桌面 app-message.js:3197-3204 同款）
			if (summary.length > 0 && (block.body.length === 0 || block.failed)) block.body = summary
			block.preview = summary.length > 0 ? previewOf(summary, false) : previewOf(block.body, false)
			block.status = statusOf(frame)
			block.failed = block.status === 'reject'
		} else {
			block.status = 'loading'
			const progressTool: string = argString(frame, 'toolName')
			// 心跳工具名本地化（PC resolveToolPresentation 同口径），不再显裸英文名
			const hint: string = progressTool.length > 0 ? resolveToolLabel(progressTool, '') : (desc.length > 0 ? desc : t('chat.turn.running'))
			block.preview = previewOf(hint, false)
		}
		return
	}

	if (kind === 'question' || kind === 'hitl') {
		const msg: ChatMessage | null = ensureStreamingTail(conv)
		if (msg == null) return
		msg.thinking = false
		closeBatch(conv, false)
		const actionId: string = fieldString(frame, 'actionId')
		const key: string = 'notice:' + (actionId.length > 0 ? actionId : nextBlockId())
		const isHitl: boolean = kind === 'hitl'
		// 【重放幂等 · 2026-11-24 用户报障「工具展示成问答」排查加固】同一张卡
		// 已经闭环（resolved/已答）后又收到同 actionId 的 question/hitl 帧
		// （乱序补帧/多端重放）时，绝不允许把已答卡翻回待答态——那会让历史里
		// 凭空多出可点的「问答卡」，点提交必 409。只有仍处 warn 待答态的卡
		// 才允许刷新题面（重连补帧保留已作答内容的既有语义不变）。
		const prior: ChatBlock | null = blockOf(conv, key)
		if (prior != null && prior.interact === 'resolved') return
		// 【交互卡】旧实现把 question/hitl 一律落成「等待在桌面客户端处理」只读提示行：
		// 手机能看见挂起却点不了任何按钮。现在两者都建可作答卡（interact=hitl/question），
		// 题面/命令原文各自解析，UI 层按 interact 渲染审批按钮或选项列表。
		const block: ChatBlock = ensureBlock(conv, key, 'notice',
			t(isHitl ? 'chat.interact.hitlTitle' : 'chat.interact.askTitle'),
			isHitl ? 'remind' : 'help')
		block.process = false
		block.actionId = actionId
		block.status = 'warn'
		if (isHitl) {
			const command: string = fieldString(frame, 'command')
			block.interact = 'hitl'
			block.command = command
			block.questions = []
			block.answers = []
			// PC 标题「需要授权：{工具本地化名}」（chat.need_auth + resolveToolPresentation）
			const hitlTool: string = fieldString(frame, 'toolName')
			block.bareTool = bareToolName(hitlTool, fieldString(frame, 'toolTitle'))
			if (hitlTool.length > 0) {
				block.label = t('chat.interact.needAuthTool', { name: resolveToolLabel(hitlTool, fieldString(frame, 'toolTitle')) })
			}
			// 审批卡正文就是命令原文；缺失时退回参数摘要，至少让用户知道在批什么
			const detail: string = command.length > 0 ? command : summarizeObject(frameArgs(frame))
			block.body = detail
			block.preview = previewOf(detail, false)
		} else {
			const questions: AskQuestion[] = parseAskQuestions(frame)
			block.interact = 'question'
			block.command = ''
			block.questions = questions
			// 同一张卡重复下发（重连补帧）时保留已作答内容，不把用户输入清掉
			if (block.answers.length !== questions.length) block.answers = emptyAskAnswers(questions.length)
			const firstHeader: string = questions.length > 0 ? questions[0].header : ''
			const detail: string = firstHeader.length > 0 ? firstHeader : summarizeObject(frameArgs(frame))
			block.body = detail
			block.preview = previewOf(detail, false)
		}
		block.submitting = false
		block.submitError = ''
		block.resolvedText = ''
		msg.meta = t('chat.interact.pendingMeta')
		return
	}

	if (kind === 'question_answered' || kind === 'hitl_released') {
		// 内核 WebChunk.java:688-691/715-720：actionId 用于精确回到「那一道题/那次审批」。
		// 不带 id 时（旧快照恢复）才降级为释放全部挂起卡。
		const actionId: string = fieldString(frame, 'actionId')
		const answeredText: string = kind === 'question_answered' ? resolvedAnswersText(frame) : ''
		const msg: ChatMessage | null = lastAiMessage(conv)
		if (msg != null) {
			let hit: boolean = false
			msg.blocks.forEach((item: ChatBlock): void => {
				if (item.kind !== 'notice' || item.status !== 'warn') return
				if (actionId.length > 0 && item.actionId !== actionId) return
				item.status = 'done'
				// 闭环回显：问答卡把内核回传的答案原文常驻展示；
				// 审批卡拒绝时 PC 标题变「已拒绝：{工具名}」+ 红点（releaseHitlCards 同口径）
				if (kind === 'hitl_released' && frame['approved'] === false && item.bareTool.length > 0) {
					item.label = t('chat.interact.rejectedTool', { name: resolveToolLabel(item.bareTool, '') })
					item.status = 'reject'
				}
				item.resolvedText = answeredText.length > 0 ? answeredText : t('chat.interact.resolved')
				item.interact = 'resolved'
				item.submitting = false
				item.submitError = ''
				hit = true
			})
			if (hit || actionId.length === 0) msg.meta = ''
		}
		return
	}

	if (kind === 'retry') {
		// Rust stream_retry 带顶层 discardPartial:true：语义是丢弃该次失败尝试已渲染的
		// 半成品 delta（桌面 discardPartialRetryDom 同款），否则乱码正文与重试提示同屏。
		if (frame['discardPartial'] === true) discardPartialAttempt(conv)
		const msg: ChatMessage | null = ensureStreamingTail(conv)
		if (msg == null) return
		msg.thinking = false
		clearRetryBlocks(msg)
		const detail: string = fieldString(frame, 'text')
		const key: string = 'retry:' + nextBlockId()
		const block: ChatBlock = ensureBlock(conv, key, 'retry', t('chat.segment.retry'), 'replay')
		block.process = false
		block.body = detail
		block.preview = previewOf(detail, false)
		block.status = 'warn'
		return
	}

	if (kind === 'done') {
		if (historyReplay.has(sessionId)) {
			// 【回放期 done 不是终态】桌面 app-history.js replaySession 里 done 只走 endTurn，
			// 不 finishStream、不置消息终态。尤其 done(suspended) 之后同一 runId 还会继续
			// 吐帧（真实流 .gwork/sessions/work-mv8wmzvp.stream.ndjson:295-361），若这里把
			// 尾条置成 done，后续帧 ensureStreamingTail 会新建气泡 → 一轮被拆成多条 AI。
			// 只收口批次，尾条保持 processing，由下一个 user 帧 / rebuildHistory 尾部统一收口。
			closeBatch(conv, false)
			return
		}
		const msg: ChatMessage | null = lastAiMessage(conv)
		running.delete(sessionId)
		cancelResumeRetry(sessionId)
		clearPendingEcho(sessionId)
		closeBatch(conv, false)
		if (msg != null && msg.status === 'processing') {
			msg.thinking = false
			msg.status = 'done'
			const elapsed: number = cursor.startedAt > 0 ? Math.max(1, Math.round((Date.now() - cursor.startedAt) / 1000)) : 1
			if (frame.suspended === true) {
				// 桌面 app-streaming.js:1395-1400：挂起态 done 也按 ended:true 折成「已挂起」。
				// 手机现在能直接作答/审批，不能再写「等待在桌面客户端处理」误导用户；
				// 有挂起卡时提示就在本卡处理，无卡（HITL 帧丢失等）才退回中性「已挂起」。
				msg.meta = pendingInteractBlock(conv, '') != null ? t('chat.interact.pendingMeta') : t('chat.turn.suspended')
				compactTurn(msg, state, elapsed, 'suspended')
			} else {
				// PC 页脚：时间戳（HH:mm）+ 时钟耗时徽标，不再「GWork · 已完成 N 秒」自造文案
				msg.meta = formatMsgTime(Date.now()) + ' · ' + formatBatchElapsed(cursor.startedAt > 0 ? cursor.startedAt : Date.now())
				compactTurn(msg, state, elapsed, 'done')
			}
		}
		conv.updatedAt = Date.now()
		return
	}

	if (kind === 'error') {
		const msg: ChatMessage | null = ensureStreamingTail(conv)
		closeBatch(conv, true)
		const desc: string = fieldString(frame, 'text')
		const key: string = 'error:' + nextBlockId()
		// PC .chunk-error：纯错误文本块（红底左红条），无图标无「GWork · 处理出错」标题前缀
		const block: ChatBlock = ensureBlock(conv, key, 'error', '', '')
		block.process = false
		block.body = desc
		block.preview = ''
		block.status = 'reject'
		block.failed = true
		if (!historyReplay.has(sessionId)) {
			// 回放期不置终态（同 done）：错误证据块已常驻，尾条留给 user 帧 / 收尾统一收口，
			// 且 compactTurn 会因 fatal 证据不生成摘要（桌面失败整轮否决口径）。
			running.delete(sessionId)
			cancelResumeRetry(sessionId)
			clearPendingEcho(sessionId)
			if (msg != null) {
				msg.thinking = false
				msg.status = 'stopped'
				// 错误原文已在 chunk-error 块常驻，meta 不再重复一遍（PC 同口径）
				msg.meta = ''
				compactTurn(msg, state, 0, 'stopped')
			}
		}
		conv.updatedAt = Date.now()
		return
	}
	// 文件变更快照（每 run 一张卡，桌面 app-file-changes.js 同口径）：
	// 帧常在 done 之后迟到，且同 run 会随 revision 反复下发——绝不能走通用 notice
	// 分支（summarizeObject 把整份 manifest dump 成 status=OK/files=[{...}] 原文，
	// 用户报障「每条消息最后都有一坨文件变更 JSON」的真因）。
	if (kind === 'file_changes') {
		applyFileChanges(conv, frame)
		return
	}
	// 插话（steer_applied）：PC appendSteerNote 同款——以【用户气泡】形态呈现，不再落
	// notice 工具行。插话本质是用户（手机/PC/他端）在任务运行中补发的一句话，与正常发送、
	// 队列出队同属用户输入族系（右对齐用户气泡 + 附件真实缩略图），仅多一枚「插话」徽标。
	// 【幂等】内核可能重复下发同一 steerId（实时帧 + 断线补帧/replay 重叠回放）：
	// steerResolved 按「会话:steerId」复合键登记（steerKey），已建过气泡的直接跳过
	// （PC data-steer-id DOM 去重同语义）；rebuildHistory 全量重建前 clearSteerResolved(id)
	// 作废本会话的键，否则回放还原出的同一 steerId 被当「已处理」静默丢弃——
	// 插话气泡刷新后消失（桌面在会话淘汰重建时清 steerResolved 同根因防线）。
	// steer_dropped / steer_cancelled 不建用户气泡（那是「没生效」的事件，内核已入队/已取消，
	// PC 端也只 toast 不建行）；但同样要登记 steerId 防止后续迟到的 steer_applied
	// 再补一条气泡（先 dropped 后 applied 的竞态下 PC 也拦在 steerResolved 上）。
	if (kind === 'steer_applied' || kind === 'steer_dropped' || kind === 'steer_cancelled') {
		const items = frameArgs(frame)['items']
		const rows: ApiBody[] = Array.isArray(items) ? (items as ApiBody[]) : []
		rows.forEach((item: ApiBody): void => {
			const steerId: string = fieldString(item, 'steerId')
			const key: string = steerKey(realId, steerId)
			if (steerId.length === 0 || steerResolved.has(key)) return
			steerResolved.add(key)
			if (kind !== 'steer_applied') return
			// 【文本与附件】item.text / item.imagePaths / item.filePaths 与 user 帧同口径：
			// 纯图片插话 text 为空，用附件占位文案兜底；图片路径经 meta 换回 dataUrl 缩略图
			// （upgradeUserAttachments 与 user 帧公共落点，失败降级占位文案不留破图标）。
			// 三者全空时无内容可展示，跳过气泡（键已登记，迟到重发不会再处理）。
			const sText: string = fieldString(item, 'text')
			const sImg = item['imagePaths']
			const sImgPaths: string[] = Array.isArray(sImg) ? (sImg as string[]).filter((p: any): boolean => typeof p === 'string') : []
			const sFiles = item['filePaths']
			const sFileCount: number = Array.isArray(sFiles) ? (sFiles as string[]).length : 0
			const displayText: string = sText.length > 0 ? sText
				: (sImgPaths.length > 0 ? t('chat.attachmentImages', { n: sImgPaths.length.toString() })
					: (sFileCount > 0 ? t('chat.attachmentFiles', { n: sFileCount.toString() }) : ''))
			if (displayText.length === 0) return
			const steerMsg: ChatMessage = emptyChatMessage('steer-' + steerId, 'user', displayText, 'done', false, true)
			conv.messages.push(steerMsg)
			if (sImgPaths.length > 0) {
				upgradeUserAttachments(realId, rootOf(conv), steerMsg, sImgPaths)
			}
			// 【轮次边界收口 · PC settleSteerTurnBoundary 同款】插话气泡必须是新旧正文
			// 的分界：不收口旧 AI 尾条的话，后续正文帧经 lastAiMessage 仍定位到插话
			// 上方的旧气泡（running 时 ensureStreamingTail 复用 processing 尾条、
			// bufferFinalText 也钉住它）→ 插话后的 AI 正文全部写进插话前的气泡，顺序颠倒。
			// 【先 flush 再判定】在途 delta 停在 buf.pending 时尾条 text/blocks 看似为空，
			// 不 flush 就判「空尾条」会把还有在途正文的尾条删掉、丢正文。
			flushTextBuf(conv.id)
			// 【空尾条删除而非收口】插话落在 AI 尚未产出任何内容时（只有空占位），
			// 收口会留一条「无正文无块、已完成」的空气泡；与回放 user 帧切轮的
			// 既有口径一致：空尾条直接移除。steer 行已 push 在其后，按 id 定位删除，
			// 不能用 pop()。
			const tailAi: ChatMessage | null = lastAiMessage(conv)
			if (tailAi != null && tailAi.text.length === 0 && tailAi.blocks.length === 0) {
				const aiIdx: number = conv.messages.indexOf(tailAi)
				if (aiIdx >= 0) conv.messages.splice(aiIdx, 1)
			} else if (tailAi != null) {
				// 收口 done 不写「已挂起/耗时」类 meta：插话后任务仍在跑，PC 旧轮
				// 收口也只做 DOM 终态不写结束语。
				finishProcessingTail(conv, 0)
			}
			// 空尾条删除后 steer 行就是列表尾：无「上一轮 AI」可写，直接清态即可
			resetTurnState(sessionId)
			conv.updatedAt = Date.now()
		})
		return
	}
	// 用户可见的补充帧：桌面端也各自渲染，移动端统一落成常驻的轻量提示行
	// （trace / context_size / tps_progress 是独立徽标与用量指示器，不进过程轨迹）
	const noticeKind: boolean = kind === 'command' || kind === 'rewind'
		|| kind === 'context_compacted'
	if (noticeKind) {
		const msg: ChatMessage | null = ensureStreamingTail(conv)
		if (msg == null) return
		msg.thinking = false
		closeBatch(conv, false)
		const raw: string = fieldString(frame, 'text')
		const detail: string = raw.length > 0 ? raw : summarizeObject(frameArgs(frame))
		const labelKey: string = kind === 'context_compacted' ? 'chat.segment.compacted'
			: (kind === 'rewind' ? 'chat.segment.rewind' : 'chat.segment.notice')
		const block: ChatBlock = ensureBlock(conv, 'notice:' + nextBlockId(), 'notice', t(labelKey), 'info')
		block.process = false
		block.body = detail
		block.preview = previewOf(detail, false)
		block.status = 'done'
		return
	}
	// trace / context_size / tps_progress / context_length 等元数据帧不落轨迹块。
	// 【未知帧护栏 · 2026-11-24 用户报障「工具帧展示成问答」排查】新增帧类型
	// 静默丢弃最难排查：开发态打日志留线索（release 构建 __DEV__ 为 false 零开销）。
	if (__DEV__) {
		const known: string[] = ['user', 'text', 'reason_start', 'reason', 'action_batch',
			'action_draft', 'action_start', 'action_args', 'action_end', 'agent_start',
			'agent_progress', 'agent_end', 'question', 'hitl', 'question_answered',
			'hitl_released', 'retry', 'done', 'error', 'file_changes', 'steer_applied',
			'steer_dropped', 'steer_cancelled', 'command', 'rewind', 'context_compacted',
			'trace', 'context_size', 'tps_progress', 'context_length', 'user_input']
		if (kind.length > 0 && known.indexOf(kind) < 0) {
			console.warn('[gwork] unknown stream frame type dropped:', kind, 'session:', realId)
		}
	}
}

/** 帧到达时保证有可写的尾条。
 *
 *  【不新建空气泡的例外】live 流里 done 之后仍可能来迟到的元数据帧
 *  （background 子代理的 agent_end、file_changes、context_compacted 等）。
 *  旧实现对所有这类帧都 appendStreamingPlaceholder → 界面多出一条只有身份头、
 *  没有任何内容的空白 AI 气泡（看起来就像「智能体消息没展示」/「消息错乱」）。
 *  非运行态（且不在历史回放中）时，把迟到帧并回最后一条已收口的 AI 消息。 */
function ensureStreamingTail(conv: Conversation): ChatMessage | null {
	const last: ChatMessage | null = lastAiMessage(conv)
	if (last != null && last.status === 'processing') return last
	if (last != null && !running.has(conv.id) && !historyReplay.has(conv.id)) {
		// 迟到帧：并回上一轮，避免凭空多一条空白助手气泡
		return last
	}
	appendStreamingPlaceholder(conv)
	// 回读 proxy：push 后必须从响应式数组取，直接持有 push 前对象不触发视图更新
	return conv.messages[conv.messages.length - 1]
}

/** 补帧期间到达的 live 帧先缓冲：若直接消费会把游标推过未取回的中间分页，
 * afterSeq 跳过整段正文（桌面 app-streaming.js recoverStreamingSession 同款策略）。
 * replay 分页拉全后按 eventSeq 升序回放，重叠由 consumeFrame 去重兜底。 */
const replayBuffers: Map<string, LinkFrame[]> = new Map<string, LinkFrame[]>()
/** 补帧在途（单飞）：resumed/列表刷新/看门狗/退避重试可能同时触发补帧，
 *  两条 replayFrom 并发会互相覆盖 replayBuffers、交错消费同一游标（帧丢失/错序）。
 *  已在途时后来者直接共享同一 Promise。 */
const catchingUp: Map<string, Promise<boolean>> = new Map<string, Promise<boolean>>()

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

/** 单飞补帧入口：所有「从游标续拉」的调用方统一走这里。 */
function catchUpFrames(id: string): Promise<boolean> {
	const inflight: Promise<boolean> | undefined = catchingUp.get(id)
	if (inflight != null) return inflight
	const task: Promise<boolean> = replayFrom(id, cursorOf(id).lastSeq)
	catchingUp.set(id, task)
	const release = (): void => {
		if (catchingUp.get(id) === task) catchingUp.delete(id)
	}
	task.then(release, release)
	return task
}

/** 断线重连补帧：afterSeq=lastSeq 起继续；分页只看 hasMore（内核 After 分支的
 * latestSeq=本页末帧 seq，不是全文件最大 seq，不能拿它当续拉判据——桌面先例
 * app-streaming.js recoverStreamingSession 同样只看 hasMore、无页数上限）。
 * 游标只由 replay 页推进；running=false 时收口占位。
 *
 * 【返回是否拉全】true=hasMore=false 的正常收尾；false=中途失败/会话已删/
 * 零进展护栏退出。调用方据此决定降级（历史加载）或安排重试（运行态续流），
 * 绝不把「拉了一半」当「加载完成」——那正是运行中任务「一直思考中、
 * 消息不加载」的真因：旧实现 40 页硬上限静默截断（长任务流轻松超 2 万帧，
 * 内核注释实测单文件 115k 行），截断后 probeRunning 又因 running=true 早退，
 * 中间整段历史永久缺失，只剩尾部 live 帧往「思考中」占位上贴。 */
async function replayFrom(id: string, afterSeq: number): Promise<boolean> {
	let cursorSeq: number = afterSeq
	replayBuffers.set(id, [])
	try {
		// 无页数上限（桌面同款）：护栏只防「零进展死循环」——hasMore=true 但整页
		// 无有效 eventSeq（病态流/坏文件）时游标推不动，再拉也是同一页，必须退出。
		for (;;) {
			const pageConv: Conversation | null = conversationOf(id)
			if (pageConv == null) return false
			const body: ApiBody = await request('GET', '/web/chat/replay', 'sessionId=' + encodeURIComponent(id) + '&afterSeq=' + cursorSeq.toString() + '&limit=500&maxBytes=' + REPLAY_MAX_BYTES.toString(), '', rootOf(pageConv))
			if (!kernelOk(body)) return false
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
			const runId = fieldString(data, 'runId')
			if (runId.length > 0) cursorOf(id).runId = runId
			if (data.hasMore === true) {
				if (pageMax <= cursorSeq) return false
				cursorSeq = pageMax
				continue
			}
			cursorSeq = pageMax
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
			if (data.running !== true && running.has(id) && !historyReplay.has(id)) {
				// 设备端已结束但 done 帧没赶上：按 replay 结果收口（同样走 Compact）
				const current: Conversation | null = conversationOf(id)
				running.delete(id)
				cancelResumeRetry(id)
				if (current != null) {
					const msg: ChatMessage | null = lastAiMessage(current)
					if (msg != null && msg.status === 'processing') {
						closeBatch(current, false)
						msg.thinking = false
						msg.status = 'done'
						msg.meta = t('chat.metaDone', { n: '1' })
						compactTurn(msg, turnStateOf(id), 1, 'done')
					}
				}
			}
			return true
		}
	} catch (_) {
		// 补帧失败保持占位：返回 false 让调用方降级/重试，不再假装加载完成
		return false
	} finally {
		// 任何退出路径（完成/失败/会话已删/零进展护栏）都必须撤缓冲，
		// 否则该会话后续 live 帧会被永远吞掉
		replayBuffers.delete(id)
	}
}

/** 历史回放（rounds 合帧模式，PC app-history.js loadMessages 同款）。
 *
 *  【为什么历史加载绝不能用 afterSeq 逐页回放（用户报障「历史消息要加载十几分钟」真因）】
 *  内核 ReplayMode::After 逐帧返回【原始 token delta 不合帧】（session/mod.rs 注释：
 *  After 契约按帧保序），且每页请求都对整个流文件做两遍全扫描（pass-1 探针逐行）。
 *  Rounds 模式一次扫描即产出合帧投影（同 kind/owner 连续 delta 合并成 1 帧），
 *  几万 delta → 数百帧，一个请求秒回。
 *
 *  【一次只拉一页 · 2026-11-24 重构】本函数只请求 rounds=HISTORY_PAGE_ROUNDS
 *  的最新一页（无 beforeSeq），升序消费后立即返回；hasMore 时把翻页游标
 *  （本页 firstSeq）记入 earlierCursors，更早轮由 loadEarlierRounds 在接流之后
 *  逐页前插。旧实现 for(;;) 全量倒拉阻塞首屏（几十次串行 WS 往返 + 每页全文件
 *  重扫），是「消息加载极度慢 / 运行中任务进去卡住不动」的主因。
 *
 *  【消费顺序】单页内部帧已按 seq 升序（内核 rounds 投影保序），先排序再统一
 *  消费（只进缓冲不消费的路径保留给更早轮前插的整页缓冲，见 loadEarlierRounds）；
 *  游标对齐 latestSeq（rounds 全文件扫描的 latest_seq=全文件最大 seq）在消费之后，
 *  供 probeRunning 续流不重复。 */
const HISTORY_PAGE_ROUNDS: number = 10
/** 单页 replay 响应体字节预算（2026-11-25 移动端「过程与产物暂不可用」真因之二）。
 *  中继协议把整个 replay 响应装进【单个 WS res 帧】，后台设备侧读上限 16MB：
 *  一页 rounds 的合帧投影超限即切断设备连接 → 36s 超时 → 降级纯文本快照丢全过程。
 *  8MB = 硬墙的一半：内核按预算保留窗口尾部、把头部计入 hasMore，本页用现成的
 *  beforeSeq 翻页逐页补回（loadEarlierRounds 同参数），单帧永远碰不到 16MB。 */
const REPLAY_MAX_BYTES: number = 8 * 1024 * 1024
/** 更早轮翻页游标（sessionId → 下一页 beforeSeq）与剩余标记 */
const earlierCursors: Map<string, number> = new Map<string, number>()
const earlierMore: Set<string> = new Set<string>()
/** 更早轮翻页在途（单飞：refresh/resumed 不叠加翻页链） */
const earlierLoading: Set<string> = new Set<string>()
/** rebuildHistory 末页的设备端运行态（true 时尾条保持 processing 交 probeRunning）。
 *  按会话记（Map）：多会话并发加载时全局单值会互相踩（A 的运行态被 B 覆盖）。 */
const lastPageRunning: Map<string, boolean> = new Map<string, boolean>()
/** 本次 rounds 页「空信封但流里有帧」标记（events 空 && latestSeq>0）。
 *  【为什么不能用 messages.length===0 判「加载失败」】内核 Rounds 投影以 user 帧
 *  切轮：无 user 帧的流（续跑段/截断流/纯附件轮）在旧内核回空信封 events:[]，
 *  但 latestSeq>0——这是「内核没给窗口」不是「会话没历史」。旧实现把它当失败
 *  降级 /messages 文本快照 → 过程轨迹全丢（三轮报障「历史只剩最终正文」的
 *  一条真因链）。命中时 rebuildHistory 改用 After 全量分页兜底保住过程。 */
const lastPageEmptyWithFrames: Map<string, boolean> = new Map<string, boolean>()

async function replayRoundsPage(id: string): Promise<boolean> {
	replayBuffers.set(id, [])
	earlierCursors.delete(id)
	earlierMore.delete(id)
	lastPageRunning.delete(id)
	lastPageEmptyWithFrames.delete(id)
	// 【缓冲溢出丢帧不算加载成功】2 万帧护栏 shift 掉的是本页最旧帧，而收尾游标
	// 会上抬到全文件 latestSeq——被丢的历史若照常 return true，probeRunning 从
	// 截断后的游标续拉，缺的那段永久丢失还谎报「加载完成」。溢出即 return false，
	// 交 loadMessagesInner 降级文本快照保住正文。
	let dropped: boolean = false
	try {
		const pageConv: Conversation | null = conversationOf(id)
		if (pageConv == null) return false
		const q: string = 'sessionId=' + encodeURIComponent(id) + '&rounds=' + HISTORY_PAGE_ROUNDS.toString() + '&maxBytes=' + REPLAY_MAX_BYTES.toString()
		const body: ApiBody = await request('GET', '/web/chat/replay', q, '', rootOf(pageConv))
		if (!kernelOk(body)) return false
		const data = body.data != null && typeof body.data === 'object' ? body.data as ApiBody : {}
		if (data.running === true) lastPageRunning.set(id, true)
		const events = data.events
		if (Array.isArray(events)) {
			const frames = events as LinkFrame[]
			// 【只进缓冲不消费】统一升序消费（与更早轮前插同构；live 帧也进
			// 同一缓冲，重叠由 consumeFrame 去重兜底）
			const buffer: LinkFrame[] | undefined = replayBuffers.get(id)
			if (buffer != null) {
				for (let i = 0; i < frames.length; i++) {
					if (buffer.length >= 20000) { buffer.shift(); dropped = true }
					buffer.push(frames[i])
				}
			}
		}
		const runId = fieldString(data, 'runId')
		if (runId.length > 0) cursorOf(id).runId = runId
		// Rounds 分支 latestSeq=pass-1 全文件最大 seq（含未翻到的更早轮与任何新帧）。
		const latestRaw = data.latestSeq
		const latest: number = typeof latestRaw === 'number' ? latestRaw as number : 0
		// 空信封但流里有帧（旧内核无 user 帧的 Rounds 空窗）：标记给 rebuildHistory
		// 走 After 全量兜底，绝不降级成纯文本快照丢过程轨迹。
		if (!Array.isArray(events) || (events as LinkFrame[]).length === 0) {
			if (latest > 0) lastPageEmptyWithFrames.set(id, true)
		}
		// 【先消费再对齐游标】统一升序消费后游标本就停在最大已消费 seq；
		// 上抬 latest 是为了覆盖 live 帧与合帧窗口的重叠（去重兜底）。
		const buffered: LinkFrame[] | undefined = replayBuffers.get(id)
		if (buffered != null && buffered.length > 0) {
			buffered.sort((a: LinkFrame, b: LinkFrame): number => {
				const na: number = typeof a.eventSeq === 'number' ? a.eventSeq as number : 0
				const nb: number = typeof b.eventSeq === 'number' ? b.eventSeq as number : 0
				return na - nb
			})
			for (let i = 0; i < buffered.length; i++) consumeFrame(id, buffered[i])
		}
		const cursor = cursorOf(id)
		if (!dropped && latest > cursor.lastSeq) cursor.lastSeq = latest
		if (data.hasMore === true) {
			// 还有更早的轮：游标=本页最早帧 seq，下页只取 < 它的轮。
			// 零进展护栏：firstSeq 无效（病态流）时不再排翻页，保留已展示部分。
			const firstRaw = data.firstSeq
			const first: number = typeof firstRaw === 'number' ? firstRaw as number : 0
			if (first > 0) {
				earlierCursors.set(id, first)
				earlierMore.add(id)
			}
		}
		return !dropped
	} catch (_) {
		return false
	} finally {
		replayBuffers.delete(id)
	}
}

/** 更早轮逐页前插（PC loadMoreMessages 同构，自动翻完）。
 *
 *  【为什么不能直接 consumeFrame】更早页的帧 seq 全部小于已展示历史的游标，
 *  单调去重游标会整页吞掉（P0 纪律不变）。也不能 unshift 到 conv.messages 后
 *  重放整个会话——运行中任务会闪断。做法：每页在【独立的临时会话】里用同一套
 *  consumeFrame 渲染成消息数组（historyReplay 标记 + 独立游标/轮状态），然后
 *  整段 splice 到真实会话头部。渲染目标与真实会话隔离，去重游标互不干扰。
 *
 *  【运行态防串轮】前插段尾部的 processing 占位收口后才入列（回放拿不到真实
 *  耗时，0 = 不伪造）；前插不触碰真实会话的 TurnState/textBufs/live 缓冲。 */
async function loadEarlierRounds(id: string): Promise<void> {
	if (earlierLoading.has(id)) return
	if (!earlierMore.has(id)) return
	earlierLoading.add(id)
	const epoch: number = earlierEpoch
	try {
		for (;;) {
			if (epoch !== earlierEpoch) return
			const conv: Conversation | null = conversationOf(id)
			if (conv == null) return
			const beforeSeq: number | undefined = earlierCursors.get(id)
			if (beforeSeq == null || beforeSeq <= 0) return
			const q: string = 'sessionId=' + encodeURIComponent(id) + '&rounds=' + HISTORY_PAGE_ROUNDS.toString() + '&beforeSeq=' + beforeSeq.toString() + '&maxBytes=' + REPLAY_MAX_BYTES.toString()
			const body: ApiBody = await request('GET', '/web/chat/replay', q, '', rootOf(conv))
			if (epoch !== earlierEpoch) return
			if (!kernelOk(body)) return
			const data = body.data != null && typeof body.data === 'object' ? body.data as ApiBody : {}
			const events = data.events
			const frames: LinkFrame[] = Array.isArray(events) ? (events as LinkFrame[]) : []
			if (frames.length > 0) prependRoundsPage(id, frames, epoch)
			if (data.hasMore !== true) {
				earlierMore.delete(id)
				earlierCursors.delete(id)
				sealEarlierHead(id, epoch)
				return
			}
			const firstRaw = data.firstSeq
			const first: number = typeof firstRaw === 'number' ? firstRaw as number : 0
			// 零进展护栏：hasMore=true 但 firstSeq 推不动（病态流）时退出，不能死循环。
			// 中途退出也收口头部占位：翻页链不会再续，processing 头会永久转圈。
			if (first <= 0) { sealEarlierHead(id, epoch); return }
			if (first >= beforeSeq) { sealEarlierHead(id, epoch); return }
			earlierCursors.set(id, first)
		}
	} catch (_) {
		// 翻页失败保留已展示部分：更早轮缺失不影响正文与 live 流
		sealEarlierHead(id, epoch)
	} finally {
		earlierLoading.delete(id)
	}
}

/** 更早轮翻页代号：rebuildHistory / 设备切换自增，迟到页/迟到收口立即失效 */
let earlierEpoch: number = 0

/** 一页更早轮直接前插进真实会话（PC loadMoreMessages prepend 同构）。
 *
 *  【为什么不走真实会话的 consumeFrame】更早页帧 seq 全部小于已展示历史的
 *  单调去重游标，直接消费整页被吞（P0 纪律）。这里用影子会话（独立 id/游标/
 *  轮状态 + historyReplay 标记）借 consumeFrame 渲染出消息段，前插到真实会话
 *  头部——真实会话的 TurnState/textBufs/live 缓冲/游标全程不触碰，运行中任务
 *  无闪断。
 *
 *  【页界无同轮分裂】内核 rounds 以 user 帧为轮起点：每页头部必是 user 行
 *  （首帧无 user 的病态流除外），页尾 AI 轮与更早页之间隔着 user 边界。
 *  影子段渲染完把全部 processing AI 行就地收口（历史无真实耗时，meta 留空
 *  不伪造「已完成 Ns」），绝不把转圈占位前插进历史。 */
function prependRoundsPage(id: string, frames: LinkFrame[], epoch: number): void {
	const realConv: Conversation | null = conversationOf(id)
	if (realConv == null) return
	const shadowId: string = id + '#earlier'
	const shadow: Conversation = {
		id: shadowId,
		title: '',
		workspace: realConv.workspace,
		pinned: false,
		updatedAt: 0,
		messages: []
	}
	conversations.value.push(shadow)
	historyReplay.add(shadowId)
	resetTurnState(shadowId)
	let segment: ChatMessage[] = []
	try {
		const sorted: LinkFrame[] = frames.slice(0)
		sorted.sort((a: LinkFrame, b: LinkFrame): number => {
			const na: number = typeof a.eventSeq === 'number' ? a.eventSeq as number : 0
			const nb: number = typeof b.eventSeq === 'number' ? b.eventSeq as number : 0
			return na - nb
		})
		// 【影子渲染用真实 id · review 修复】consumeFrame 内附件升级/steer 登记
		// 都以 sessionId 为键发 /web/chat/attachment/meta 请求（内核按会话目录解析）：
		// 传 shadowId 会让整段历史的附件请求全部打向不存在的「id#earlier」会话——
		// 长会话自动翻页 = 每页一批必败请求风暴（挤占 WS 链路，正是要修的慢），
		// 且缓存键/steer 键全带影子后缀永不复用。渲染目标仍由 conversationOf(shadowId)
		// 定位到影子数组，游标/轮状态按 shadowId 隔离；仅「对外身份」用真实 id。
		for (let i = 0; i < sorted.length; i++) consumeFrame(shadowId, sorted[i], id)
		const shadowConv: Conversation | null = conversationOf(shadowId)
		if (shadowConv != null) segment = shadowConv.messages.slice(0)
	} finally {
		historyReplay.delete(shadowId)
		cursors.delete(shadowId)
		turnStates.delete(shadowId)
		dropTextBuf(shadowId)
		clearSteerResolved(shadowId)
		conversations.value = conversations.value.filter((item: Conversation): boolean => item.id !== shadowId)
	}
	if (segment.length === 0) return
	// 段内 processing 占位统一收口：done(suspended) 等回放期不收口的尾条
	// 若原样前插，历史头部会挂一条永久「思考中」。
	segment.forEach((msg: ChatMessage): void => {
		if (msg.role === 'ai' && msg.status === 'processing') {
			if (msg.text.length === 0 && msg.blocks.length === 0) return
			msg.thinking = false
			msg.status = 'done'
			msg.meta = ''
		}
	})
	// 空占位（无正文无块）不前插：历史里夹空白气泡即「消息错乱」观感
	segment = segment.filter((msg: ChatMessage): boolean =>
		!(msg.role === 'ai' && msg.status === 'processing' && msg.text.length === 0 && msg.blocks.length === 0))
	if (segment.length === 0) return
	const current: Conversation | null = conversationOf(id)
	if (current == null || epoch !== earlierEpoch) return
	current.messages = segment.concat(current.messages)
}

/** 更早轮翻尽/中止的兜底收口：头部若仍是 processing AI 占位（病态流首帧无
 *  user），就地收口，不留永久转圈。只认最新翻页代。 */
function sealEarlierHead(id: string, epoch: number): void {
	if (epoch !== earlierEpoch) return
	const conv: Conversation | null = conversationOf(id)
	if (conv == null || conv.messages.length === 0) return
	const head: ChatMessage = conv.messages[0]
	if (head.role === 'ai' && head.status === 'processing') {
		head.thinking = false
		head.status = 'done'
		head.meta = ''
	}
}

/** 运行态续流的退避重试（桌面 scheduleStreamingRecovery 同款：1s×2 封顶 30s）。
 *  旧实现 replayFrom 失败后什么都不做——「补帧失败保持占位」注释成立的前提是
 *  有人会再补，而 resumeRunning 只挂在链路 resumed 事件上：链路一直活着、
 *  只是某一页请求超时/502 时，缺的那段永远没人拉，占位「思考中」挂到任务结束。 */
const resumeRetryTimers: Map<string, number> = new Map<string, number>()
const resumeRetryCounts: Map<string, number> = new Map<string, number>()

function cancelResumeRetry(id: string): void {
	// 看门狗与重试同生命周期：所有终态/删除/设备切换都经本函数撤单
	cancelRunWatchdog(id)
	const timer: number | undefined = resumeRetryTimers.get(id)
	if (timer != null) {
		clearTimeout(timer)
		resumeRetryTimers.delete(id)
	}
	resumeRetryCounts.delete(id)
}

function scheduleResumeRetry(id: string): void {
	if (resumeRetryTimers.has(id)) return
	const count: number = resumeRetryCounts.get(id) ?? 0
	const exp: number = count < 5 ? count : 5
	let delay: number = 1000
	for (let i = 0; i < exp; i++) delay *= 2
	if (delay > 30000) delay = 30000
	resumeRetryCounts.set(id, count + 1)
	resumeRetryTimers.set(id, setTimeout((): void => {
		resumeRetryTimers.delete(id)
		// 会话已结束/已删/设备已切换：不再补
		if (!running.has(id) || conversationOf(id) == null) {
			resumeRetryCounts.delete(id)
			return
		}
		catchUpFrames(id).then((ok: boolean): void => {
			if (ok) {
				resumeRetryCounts.delete(id)
				return
			}
			if (running.has(id)) scheduleResumeRetry(id)
		})
	}, delay))
}

/** 对进行中的会话补帧（链路恢复 / 列表刷新后调用）；失败退避重试直到拉全。 */
function resumeRunning(): void {
	running.forEach((id: string): void => {
		catchUpFrames(id).then((ok: boolean): void => {
			if (!ok && running.has(id)) scheduleResumeRetry(id)
			if (ok) cancelResumeRetry(id)
		})
	})
}

/* ---------------- 运行态看门狗 ---------------- */

/** 【为什么必须有看门狗 · 2026-11-24 用户报障「运行中任务进去一直卡住不动」】
 *  live 帧依赖桌面中转的 gate 订阅：旧版桌面端只对 POST body 里的 sessionId 建
 *  订阅，移动端打开会话的 GET replay 不建——done/error 帧永远到不了手机，
 *  running 残留、占位永久「思考中」。桌面端已同步修复（GET query 也 ensure），
 *  但线上旧版本桌面不会升级：移动端必须自己对账内核权威 running 态。
 *  周期 15s 一次 rounds=1 轻量探针（只在 running 集合非空时有定时器）。 */
const RUN_WATCHDOG_MS: number = 15000
const runWatchdogs: Map<string, number> = new Map<string, number>()

function armRunWatchdog(id: string): void {
	if (runWatchdogs.has(id)) return
	runWatchdogs.set(id, setTimeout((): void => {
		runWatchdogs.delete(id)
		if (!running.has(id) || conversationOf(id) == null) return
		const conv: Conversation | null = conversationOf(id)
		if (conv == null) return
		request('GET', '/web/chat/replay', 'sessionId=' + encodeURIComponent(id) + '&rounds=1&maxBytes=' + REPLAY_MAX_BYTES.toString(), '', rootOf(conv)).then((body: ApiBody): void => {
			if (!running.has(id)) return
			if (kernelOk(body)) {
				const data = body.data != null && typeof body.data === 'object' ? body.data as ApiBody : {}
				if (data.running === true) {
					// 【仍在跑也必须拉增量 · 2026-11-24 三轮报障「运行中任务一直思考中」真因】
					// 旧版桌面中转只对 POST body 建 gate 订阅：手机 GET replay 不建 →
					// live 帧（正文/工具/done）一帧都到不了。此前看门狗只在「已结束」
					// 分支补帧，running 期间只是空转对账 → 手机上看电脑上发起的运行中
					// 任务永远「思考中」。这里周期把内核已落盘的新帧拉回来（After 分页
					// 单飞，游标续拉不重复），旧桌面组合下最多 15s 一批可见进度。
					catchUpFrames(id).then((ok: boolean): void => {
						if (!ok && running.has(id)) scheduleResumeRetry(id)
					})
				}
				if (data.running !== true) {
					// 设备端已结束但 done 帧没到：补最后一帧段并按 replay 收口。
					// 【失败必须续命 · review 修复】catchUpFrames 失败（某一页超时/502）
					// 时若就此返回，running 残留且再无人对账——「看门狗兜底」恰在
					// 最需要它的弱网场景失效。失败走退避重试；重试也不可靠（定时器
					// 可能被终态撤销后 running 又被置起），下一轮看门狗兜底再对账。
					catchUpFrames(id).then((ok: boolean): void => {
						if (!ok && running.has(id)) {
							scheduleResumeRetry(id)
							// 【先撤再武装】scheduleResumeRetry 的定时器可能先于本回调
							// 触发并成功收口（cancelResumeRetry 已清看门狗），此时再 arm
							// 会给已终态的会话留一个 15s 后的空转探针。重新对账前统一
							// 撤单，保证「终态 ⇒ 无看门狗」不变式。
							cancelRunWatchdog(id)
							armRunWatchdog(id)
						}
					})
					return
				}
			}
			// 仍在跑（或探针失败）：继续下一轮对账
			armRunWatchdog(id)
		}, (): void => {
			if (running.has(id)) armRunWatchdog(id)
		})
	}, RUN_WATCHDOG_MS))
}

function cancelRunWatchdog(id: string): void {
	const timer: number | undefined = runWatchdogs.get(id)
	if (timer != null) {
		clearTimeout(timer)
		runWatchdogs.delete(id)
	}
}

/* ---------------- 发送 / 停止 ---------------- */

function sendMessage(id: string, text: string, ready?: Promise<void>, attachments?: PendingAttachment[], onFail?: (text: string, atts: PendingAttachment[]) => void): boolean {
	const conv: Conversation | null = conversationOf(id)
	if (conv == null) return false
	if (!gworkSignedIn().value) {
		toast('chat.loginRequired')
		return false
	}
	const devices = useDevices()
	if (devices.activeDeviceId.value.length === 0) {
		toast('chat.deviceRequired')
		return false
	}
	if (!devices.deviceOnline.value) {
		toast('chat.deviceOffline')
		return false
	}
	// 数据层兜底：processing 期间拒绝再发（UI 层已把发送按钮换成停止按钮）
	if (isProcessing(id)) {
		toast('chat.busySend')
		return false
	}
	const rawContent: string = text.trim()
	const atts: PendingAttachment[] = attachments != null ? attachments : []
	if (rawContent.length === 0 && atts.length === 0) return false
	// 信封体积预检：附件 base64 + 正文超 15MiB 会越 admin 16MiB 帧限直接关 WS，
	// 必须在进入乐观状态之前明确拒绝（草稿/附件由调用方保留）
	if (!inputWithinBudget(rawContent, atts)) return false
	// 技能 slash 前缀（桌面同构："/<id> " + 正文，展示名不上 wire）。
	// 【消费时机】只有正文非空才注入前缀（纯附件消息发 "/id " 空命令是误消费）；
	// 选择清除推迟到内核受理成功之后——失败/busy 时技能选择必须还在（P1）。
	const env = useRunEnv()
	const selectedSkillAtSend: string = env.selectedSkill.value
	const prefix: string = rawContent.length > 0 ? skillPrefix() : ''
	const content: string = prefix + rawContent
	// 乐观气泡展示用户原文（不含 slash 前缀）；纯附件消息用占位文案（与 user 帧同口径）
	const displayContent: string = rawContent.length > 0 ? rawContent : attachPlaceholder(atts)
	const userMsg: ChatMessage = emptyChatMessage(nextMsgId(), 'user', displayContent, 'done', false, false)
	// 本端图片附件直接内联 dataUrl（发送时已在手）：即时可见，无需回放升级
	atts.forEach((a: PendingAttachment): void => {
		if (a.type === 'image' && a.dataBase64.length > 0) {
			userMsg.imageUrls.push('data:image/' + (a.mime.length > 0 ? a.mime : 'jpeg') + ';base64,' + a.dataBase64)
		}
	})
	conv.messages.push(userMsg)
	conv.updatedAt = Date.now()
	// 登记本端发出的文本：live 流的 user 回显按这条精确去重（不再全文匹配历史）。
	// 内核 user 帧 text 是带前缀的 wire 文本，登记 wire 口径才能对上。
	pendingUserEcho.set(id, content.length > 0 ? content : displayContent)
	// 本端这次发送的身份标识：内核会把 user 帧广播给该设备的所有客户端
	//（PC 端才能看到手机发的话），回显帧带回这个 id → 按身份跳过自己的气泡。
	// 与 pendingUserEcho 并存：旧设备端不回传 id 时仍走文本兜底。
	const clientMsgId: string = 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
	pendingClientMsgId.set(id, clientMsgId)
	// 乐观 user 行与本次发送身份绑定：busy/失败回滚按 id 精确定位，
	// 不再拿 wire 文本（含 slash 前缀）与展示文本比对——那必然失配（P1）
	optimisticUserId.set(clientMsgId, userMsg.id)
	const aiMsg: ChatMessage = emptyChatMessage(nextMsgId(), 'ai', '', 'processing', true, false)
	conv.messages.push(aiMsg)
	resetTurnState(id)
	const state: TurnState = turnStateOf(id)
	state.startedAt = Date.now()
	// 先占 running：连接期间 UI 立即出停止按钮，且防重复发送
	running.add(id)
	// 看门狗从发送起就 armed：done 帧丢失（旧桌面中转/链路抖动）时对账收口
	armRunWatchdog(id)
	const cursor = cursorOf(id)
	cursor.startedAt = Date.now()
	// 【不要清零 lastSeq】旧实现每轮发送都把游标打回 0，断线重连 / probeRunning 走
	// replayFrom(lastSeq) 时会把整个 stream 文件重放一遍 → 历史成对重复、顺序错乱。
	// 新会话游标本就是 0，已有历史时必须保留（上一轮帧已全部消费到）。
	cursor.runId = ''
	onFrame(id, (sessionId: string, frame: LinkFrame): void => {
		handleStreamFrame(sessionId, frame)
	})
	const root: string = rootOf(conv)
	const payload: ApiBody = { sessionId: id, input: content, accessMode: accessModeNow(), clientMessageId: clientMsgId }
	// v1.1 内联附件：base64 随 JSON body 上桥，内核走与桌面 multipart 相同的落盘+注入
	if (atts.length > 0) {
		const rows: ApiBody[] = []
		atts.forEach((a: PendingAttachment): void => {
			rows.push({ name: a.name, type: a.type, dataBase64: a.dataBase64 })
		})
		payload['attachments'] = rows
	}
	const setup: Promise<unknown> = ready != null
		? ensureConnected(devices.activeDeviceId.value).then((): Promise<unknown> => ready as Promise<unknown>)
		: ensureConnected(devices.activeDeviceId.value)
	// 失败回填闭包：把「当时实际发送的正文与附件」交还调用方（页面回填草稿/附件列），
	// 技能选择一并恢复——链路抖一下不能让用户拍的照/选的文件/选的技能全白选。
	const restore = (): void => {
		if (prefix.length > 0) {
			env.selectedSkill.value = selectedSkillAtSend
			const found: SkillOption | undefined = env.skills.value.find((s: SkillOption): boolean => s.id === selectedSkillAtSend)
			env.attachTag.value = t('home.skillTag', { name: found != null ? found.name : selectedSkillAtSend })
		}
		if (onFail != null) onFail(rawContent, atts)
	}
	setup.then((): Promise<ApiBody> => {
		return request('POST', '/web/chat/input', '', JSON.stringify(payload), root)
	}).then((body: ApiBody): void => {
		if (!kernelOk(body)) {
			failSend(id, fieldString(body, 'description'), clientMsgId)
			restore()
			return
		}
		// 忙时 data:"busy"（他端同会话在跑）：本轮 input 未受理（消息不落设备端），
		// 但设备端正有进行中的轮次——接上它的 live 流并 replay 补帧（继续任务场景），
		// 而不是只弹提示后留一个空白会话。
		if (typeof body.data === 'string' && body.data === 'busy') {
			toast('chat.busySend')
			// 【先清 running】sendMessage 早在连接前就 running.add(id)；probeRunning 开头
			// `if (running.has(id)) return`，不清就会立刻空转返回：既不补帧、也不撤销本轮
			// 乐观插入的 user 行与 AI 占位，running 永久残留（后续连发送都发不出去）。
			running.delete(id)
			cancelRunWatchdog(id)
			pendingUserEcho.delete(id)
			pendingClientMsgId.delete(id)
			const busyConv: Conversation | null = conversationOf(id)
			if (busyConv != null) rollbackOptimisticSend(busyConv, clientMsgId)
			restore()
			probeRunning(id)
			return
		}
		loaded.add(id)
		// 受理成功才消费技能选择（一次一消费，后续轮次不重复注入）
		if (prefix.length > 0 && env.selectedSkill.value === selectedSkillAtSend) {
			env.selectedSkill.value = ''
			env.attachTag.value = ''
		}
		optimisticUserId.delete(clientMsgId)
	}, (err: any): void => {
		failSend(id, err instanceof Error ? err.message : '', clientMsgId)
		restore()
	})
	return true
}



/** 撤销 sendMessage 本地乐观插入的 user 行与 AI 占位（busy/未受理时用）。
 *  设备端没有落这条 input，留着会出现「界面有提问、历史里没有」的错位。
 *  【按行 id 定位，不按文本】wire 文本含 slash 前缀/附件占位改写，与乐观行的
 *  展示文本必然不等——旧实现文本精确比对在技能/纯附件消息上必失配，残留假气泡。 */
function rollbackOptimisticSend(conv: Conversation, clientMsgId: string): void {
	const rowId: string | undefined = optimisticUserId.get(clientMsgId)
	optimisticUserId.delete(clientMsgId)
	if (rowId == null) return
	const msgs: ChatMessage[] = conv.messages
	for (let i = msgs.length - 1; i >= 0; i--) {
		if (msgs[i].id !== rowId || msgs[i].role !== 'user') continue
		// 紧随其后的空 AI 占位一并撤掉（本轮未受理，占位没有对应的流）
		if (i + 1 < msgs.length) {
			const ai: ChatMessage = msgs[i + 1]
			if (ai.role === 'ai' && ai.status === 'processing' && ai.text.length === 0 && ai.blocks.length === 0) {
				msgs.splice(i, 2)
				return
			}
		}
		msgs.splice(i, 1)
		return
	}
}

function failSend(id: string, detail: string, clientMsgId?: string): void {
	running.delete(id)
	cancelResumeRetry(id)
	// 发送失败：撤销 echo 登记，否则用户下次重发同文时回显会被误吞
	pendingUserEcho.delete(id)
	pendingClientMsgId.delete(id)
	const conv: Conversation | null = conversationOf(id)
	if (conv != null) {
		// 本轮未受理：乐观 user 行 + 空 AI 占位整体撤销（正文/附件由 restore 回填输入区），
		// 不再留一条「设备端没见过」的提问在界面上。
		if (clientMsgId != null) {
			rollbackOptimisticSend(conv, clientMsgId)
		} else {
			const last: ChatMessage | null = lastAiMessage(conv)
			if (last != null && last.status === 'processing') {
				last.thinking = false
				last.status = 'stopped'
				last.meta = detail.length > 0 ? detail : t('chat.metaError')
			}
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
	cancelResumeRetry(id)
	clearPendingEcho(id)
	const conv: Conversation | null = conversationOf(id)
	if (conv == null) return
	closeBatch(conv, true)
	const last: ChatMessage | null = lastAiMessage(conv)
	if (last != null && last.status === 'processing') {
		last.status = 'stopped'
		last.thinking = false
		last.meta = t('chat.metaStopped')
		const elapsed: number = cursorOf(id).startedAt > 0 ? Math.max(1, Math.round((Date.now() - cursorOf(id).startedAt) / 1000)) : 1
		compactTurn(last, turnStateOf(id), elapsed, 'stopped')
	}
	conv.updatedAt = Date.now()
}

/* ---------------- 交互卡作答（ask / 审批） ---------------- */

/** 找到挂起中的交互卡（按 actionId 精确定位，缺 id 时取本会话最后一张未闭环卡）。
 *  跨轮扫描是必要的：审批卡可能落在上一轮的尾气泡上（挂起结束本轮），
 *  桌面端按 DOM 全局查 .hitl-pending 同口径。 */
function pendingInteractBlock(conv: Conversation, actionId: string): ChatBlock | null {
	let hit: ChatBlock | null = null
	for (let i = conv.messages.length - 1; i >= 0; i--) {
		const msg: ChatMessage = conv.messages[i]
		for (let j = msg.blocks.length - 1; j >= 0; j--) {
			const item: ChatBlock = msg.blocks[j]
			if (item.kind !== 'notice' || item.status !== 'warn') continue
			if (item.interact !== 'hitl' && item.interact !== 'question') continue
			if (actionId.length > 0) {
				if (item.actionId === actionId) return item
				continue
			}
			if (hit == null) hit = item
		}
	}
	return hit
}

/** 把作答态组装成内核要的 answers 数组（契约 §3.4 / 桌面 buildQuestionAnswersPayload）：
 *  未作答的题按 skipped=true 提交，保证数组长度恒等于题数，不错位。 */
function buildAskAnswersPayload(block: ChatBlock): string {
	const rows: ApiBody[] = []
	for (let i = 0; i < block.questions.length; i++) {
		const q: AskQuestion = block.questions[i]
		const a: AskAnswer | null = i < block.answers.length ? block.answers[i] : null
		const answered: boolean = a != null && askAnswered(a)
		const item: ApiBody = {
			index: i,
			text: answered ? (a as AskAnswer).text : '',
			skipped: !answered,
			custom: answered && (a as AskAnswer).custom
		}
		// texts 只在多选题且确有内容时入表：单选协议零改动，旧内核只读 text 也拿得到完整语义
		if (answered && q.multiSelect) {
			const texts: string[] = []
			const labels: string[] = (a as AskAnswer).selectedLabels
			for (let k = 0; k < labels.length; k++) {
				if (labels[k].length > 0) texts.push(labels[k])
			}
			const sup: string = (a as AskAnswer).supplement.trim()
			if (sup.length > 0) texts.push(sup)
			if (texts.length > 0) item['texts'] = texts
		}
		rows.push(item)
	}
	return JSON.stringify({ answers: rows })
}

/** 交互卡提交的统一入口（问答与审批共用）：
 *  - 会话级流式态先就位（内核恢复轮会立刻吐帧，晚订阅会漏开头）；
 *  - 不带 input 键：内核靠它的存在性区分「新一轮」与「续轮」（chat_input is_resume）；
 *  - 失败回退：解除 submitting 并保留用户已填内容，否则卡片永久禁用而任务永不恢复。
 *  payload 只放本次要提交的字段（questionAnswer 或 hitlAction + actionId）；
 *  onOk 是成功回调——审批侧靠它做本地闭环（内核不广播 hitl_released）。 */
function submitInteract(id: string, block: ChatBlock, payload: ApiBody, onOk?: () => void): void {
	const conv: Conversation | null = conversationOf(id)
	if (conv == null || block.submitting) return
	const devices = useDevices()
	if (devices.activeDeviceId.value.length === 0) {
		toast('chat.deviceRequired')
		return
	}
	if (!devices.deviceOnline.value) {
		toast('chat.deviceOffline')
		return
	}
	block.submitting = true
	block.submitError = ''
	// 恢复轮立刻进入流式态：resume 一开始就吐 reason/text 帧，等响应回来再置态会漏开头
	running.add(id)
	armRunWatchdog(id)
	const cursor = cursorOf(id)
	cursor.startedAt = Date.now()
	// 【不清 runId】内核 spawn_resume 沿用原 runId（mod.rs:2807-2814 注释钉死），
	// 清掉它会让「提交后立刻点停止」带着空 runId 去 interrupt，停不掉续跑。
	// 帧链到达时 consumeFrame 会用帧上的 runId 覆写，无需预清。
	onFrame(id, (sessionId: string, frame: LinkFrame): void => {
		handleStreamFrame(sessionId, frame)
	})
	const root: string = rootOf(conv)
	const body: ApiBody = { sessionId: id }
	Object.keys(payload).forEach((key: string): void => {
		body[key] = payload[key]
	})
	ensureConnected(devices.activeDeviceId.value).then((): Promise<ApiBody> => {
		return request('POST', '/web/chat/input', '', JSON.stringify(body), root)
	}).then((res: ApiBody): void => {
		if (kernelOk(res)) {
			if (onOk != null) onOk()
			return
		}
		failInteract(id, block, fieldString(res, 'description'))
	}, (err: any): void => {
		failInteract(id, block, err instanceof Error ? err.message : '')
	})
}

/** 提交失败回退：卡片回到可编辑态（按钮/选项可再点），答案原样保留，
 *  并在卡内显示失败原因（410/409 迟到点击与网络错误同走此路）。 */
function failInteract(id: string, block: ChatBlock, detail: string): void {
	block.submitting = false
	block.submitError = detail.length > 0 ? detail : t('chat.interact.submitFailed')
	// 409/网络失败：内核没有消费挂起、也没有续跑，撤销 submitInteract 预置的运行态。
	// 但若在途期间已有续跑帧到达（尾条 processing 且有内容），说明设备端其实在跑
	//（例如另一台客户端先批了），此时保留 running 让 done 帧正常收口。
	const conv: Conversation | null = conversationOf(id)
	if (conv != null) {
		const msg: ChatMessage | null = lastAiMessage(conv)
		if (msg != null && msg.status === 'processing' && msg.blocks.length === 0 && msg.text.length === 0) {
			msg.status = 'done'
			msg.thinking = false
			running.delete(id)
			cancelRunWatchdog(id)
		} else if (msg == null) {
			running.delete(id)
			cancelRunWatchdog(id)
		}
	} else {
		running.delete(id)
		cancelRunWatchdog(id)
	}
}

/** 提交成功后的本地闭环。
 *
 *  【为什么审批必须乐观闭环】内核 `handle_hitl_action`（mod.rs:2521-2577）只
 *  auto_approve_and_resume / spawn_resume，**不广播 hitl_released**——整个 core
 *  里 hitl_released 只有一处发送点（mod.rs:1568，切到 full access 那条路径）。
 *  桌面端因此不走帧，而是提交成功即本地移除卡片（app-message.js:3700-3736 注释
 *  「按钮已随提交移除、状态已转终态」）。手机若等帧，卡片会永远停在「提交中」。
 *
 *  问答侧 question_answered 内核确实会广播（mod.rs:2497-2502），但仍先本地闭环：
 *  提交已 200 代表挂起态被消费，等帧只会让用户多等一个网络往返才看到反应；
 *  帧到达时 consumeFrame 会幂等地把同一张卡再置一次 resolved。 */
function resolveInteract(id: string, block: ChatBlock, resolvedText: string): void {
	block.submitting = false
	block.submitError = ''
	block.interact = 'resolved'
	block.status = 'done'
	block.resolvedText = resolvedText.length > 0 ? resolvedText : t('chat.interact.resolved')
	// 【绝不能清 running】内核收到作答/审批后立即 spawn_resume 续跑（同一 runId），
	// submitInteract 已把会话置回 running 接流。这里若 running.delete：
	// ① 恢复段开头几帧命中「非运行态 + 尾条 stopped」守卫被整段丢弃；
	// ② ensureStreamingTail 把恢复段并进已折叠的上一轮 → Compact 摘要不更新、
	//    过程行被藏进旧批次，用户看到「答完了但回答不见了」。
	// 运行态由续跑自己的 done/error 帧收口（consumeFrame），与桌面端同口径。
	const conv: Conversation | null = conversationOf(id)
	if (conv != null) {
		const msg: ChatMessage | null = lastAiMessage(conv)
		if (msg != null) {
			msg.meta = ''
			// 尾条若已被挂起 done 收成终态，恢复段要重新开一条流式尾条
			if (msg.status !== 'processing') appendStreamingPlaceholder(conv)
		}
	}
}

/** 审批：approve / reject。actionId 为空不入表——内核据此区分「严格校验」与
 *  「旧前端降级」两种模式，补空串会让无 id 的旧快照任务永远批不动。 */
function approveHitl(id: string, actionId: string, approved: boolean): void {
	const conv: Conversation | null = conversationOf(id)
	if (conv == null) return
	const block: ChatBlock | null = pendingInteractBlock(conv, actionId)
	if (block == null || block.interact !== 'hitl') return
	const payload: ApiBody = { hitlAction: approved ? 'approve' : 'reject' }
	if (actionId.length > 0) payload['actionId'] = actionId
	// 审批不走 hitl_released（见 resolveInteract 注释），成功后由 submitInteract 回调闭环
	submitInteract(id, block, payload, (): void => {
		resolveInteract(id, block, t(approved ? 'chat.interact.approved' : 'chat.interact.rejected'))
	})
}

/** 问答：把整卡的作答态一次提交（逐题答完或跳过都走这一条）。
 *  没有任何内容时直接拒绝：内核会 409（No pending question），界面上却是「点了没反应」。 */
function answerQuestion(id: string, actionId: string): void {
	const conv: Conversation | null = conversationOf(id)
	if (conv == null) return
	const block: ChatBlock | null = pendingInteractBlock(conv, actionId)
	if (block == null || block.interact !== 'question') return
	let filled: boolean = false
	for (let i = 0; i < block.answers.length; i++) {
		if (askAnswered(block.answers[i])) filled = true
	}
	if (!filled) {
		toast('chat.interact.answerRequired')
		return
	}
	const payload: ApiBody = { questionAnswer: buildAskAnswersPayload(block) }
	if (actionId.length > 0) payload['actionId'] = actionId
	// 回显文案取本地作答态（内核 question_answered 帧也会带 answers，到达时会覆写成权威值）
	let echo: string = ''
	for (let i = 0; i < block.answers.length; i++) {
		const text: string = block.answers[i].text.trim()
		if (text.length === 0) continue
		echo = echo.length > 0 ? echo + ' / ' + text : text
	}
	submitInteract(id, block, payload, (): void => {
		resolveInteract(id, block, echo)
	})
}

/** 更新某题的作答态（UI 层选项点击 / 自由输入 / 跳过都走它）。
 *  单选：点已选中的项=取消；有补充时取消选项降级为纯自定义答案（不丢用户写的字）。
 *  多选：accumulate 语义，再点已选项移出，每点一次不推进光标。 */
function setQuestionAnswer(id: string, actionId: string, index: number, patch: AskAnswer): void {
	const conv: Conversation | null = conversationOf(id)
	if (conv == null) return
	const block: ChatBlock | null = pendingInteractBlock(conv, actionId)
	if (block == null || block.interact !== 'question') return
	if (index < 0 || index >= block.answers.length) return
	const next: AskAnswer = {
		index: index,
		text: patch.text,
		selectedLabel: patch.selectedLabel,
		selectedLabels: patch.selectedLabels,
		supplement: patch.supplement,
		skipped: patch.skipped,
		custom: patch.custom,
		answered: patch.text.trim().length > 0
	}
	block.answers[index] = next
	block.submitError = ''
}

/* ---------------- 会话管理 ---------------- */

function setActive(id: string): void {
	activeConvId.value = id
	const env = useRunEnv()
	const conv: Conversation | null = conversationOf(id)
	env.bindSession(id, conv != null ? rootOf(conv) : '')
	loadMessages(id)
}

function createConversation(workspace: string, firstText?: string): { id: string; ready: Promise<void> } {
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
	// 对齐桌面端 inheritSelectionToSession：先保留首页选择，再在首次 input 前绑定到新会话。
	// currentConfig() 返回内核原始码（模型 name / 思考码 / 上下文 token 数），不再传 i18n 展示名。
	const env = useRunEnv()
	const inherited: ModelConfig = env.currentConfig()
	const root: string = workspace === DEFAULT_WORKSPACE ? '' : workspace
	env.bindSession(conv.id, root)
	const ready: Promise<void> = inheritSelectionToSession(conv.id, inherited, root)
	return { id: conv.id, ready }
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
	cancelResumeRetry(id)
	earlierEpoch += 1
	earlierCursors.delete(id)
	earlierMore.delete(id)
	catchingUp.delete(id)
	cursors.delete(id)
	loaded.delete(id)
	loadingMessages.delete(id)
	replayBuffers.delete(id)
	dropTextBuf(id)
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
	// 续流重试定时器随设备切换作废：留着会往新设备的会话列表里补旧设备的帧
	resumeRetryTimers.forEach((timer: number, _id: string): void => { clearTimeout(timer) })
	resumeRetryTimers.clear()
	resumeRetryCounts.clear()
	// 看门狗/翻页链同样作废：旧设备的对账探针与更早轮前插不得写新设备会话
	runWatchdogs.forEach((timer: number, _id: string): void => { clearTimeout(timer) })
	runWatchdogs.clear()
	earlierEpoch += 1
	earlierCursors.clear()
	earlierMore.clear()
	earlierLoading.clear()
	catchingUp.clear()
	cursors.clear()
	loaded.clear()
	// 在途的历史加载必须丢弃：旧任务的 await 收尾会写回已清空/已切换设备的会话
	loadingMessages.clear()
	replayBuffers.clear()
	// 合帧定时器逐会话清掉：留着会在设备切换后往新会话列表里找不到目标空转
	textBufs.forEach((_buf: TextBuf, id: string): void => { dropTextBuf(id) })
	// 回显登记同样作废：留着会在新设备上误吞一条同文/同 id 的 user 帧
	pendingUserEcho.clear()
	pendingClientMsgId.clear()
	optimisticUserId.clear()
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
		// 链路已断（后台 4001）：进行中的会话保持占位，重连成功后 resumeRunning 续流
		listError.value = t('chat.deviceOffline')
	})
	onLinkResumed((): void => {
		// 链路已自愈：清掉离线提示，并对断线期间仍在跑的会话补帧。
		// 旧实现只在 offline 时置了 listError，却从没写过 resumed 一侧：
		// 断线提示永久留在界面上，进行中的任务也再收不到后续帧（用户看到的
		// 就是「一直显示设备连接已断开」且回答停住不动）。
		listError.value = ''
		resumeRunning()
		// 断线期间若正好挂起（question 帧在那段时间广播，本端没收到），重连后 replay
		// 只补 afterSeq 之后的帧，挂起卡不会自己冒出来——对当前会话重探一次权威挂起态。
		const active: string = activeConvId.value
		if (active.length > 0) probePendingQuestion(active)
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
		approveHitl,
		answerQuestion,
		setQuestionAnswer,
		refresh: refreshConversations,
		retryHistory,
		listLoading,
		listError
	}
}
