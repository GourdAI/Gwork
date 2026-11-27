/**
 * 首页与对话页共享的数据类型与剩余静态占位数据。
 *
 * 设备 / 工作区 / 模型 / 会话 / 权限 / 技能 / 连接器已接真实链路
 * （hooks/useDevices、useRunEnv、useConversations）。技能 / 连接器的标识色属于内容色（与头像同理），
 * 不参与亮暗主题切换，因此保留在后端数据位置而不是 $theme-palette。
 */

export type DeviceOption = {
	/** 后台设备 id（dev-xxxxxxxx）；未登录/无设备时为空串 */
	deviceId: string
	name: string
	online: boolean
	note: string
	/** 毫秒时间戳，最后在线时刻（契约 §1.1 lastSeen）；0=未知 */
	lastSeen: number
}

export type WorkspaceOption = {
	/** 展示名：项目工作区为路径 basename，全局「对话」区为 i18n 文案 */
	name: string
	/** 工作区绝对路径；空串=全局「对话」区（sessions?root= 空） */
	root: string
}

export type PermissionOption = {
	/** 协议码：内核 access/select 与 input.accessMode 的 wire 值（'default' | 'full'）。
	 *  【不能用展示文案当键】切语言后所有比对会静默失配（二次确认弹窗失效） */
	name: string
	/** i18n 键：展示名与描述经 permissionLabel/permissionDesc 现取，随语言切换 */
	labelKey: string
	descKey: string
	danger: boolean
}

export type ModelOption = {
	/** 带前缀的可选模型 name（settings.models 的 key/name；POST models/select 必须传它），
	 *  裸 model 字段只是配置内的短 id，内核 contains_key 不认。 */
	model: string
	name: string
	desc: string
	/** 服务商展示名；内核 /web/chat/models 下发，空串归入「其他」 */
	provider: string
	/** 服务商唯一 id；兼容 Java 内核，空串时按 provider 分组 */
	providerId: string
	/** 接口标准；旧内核未下发 thinkingLevels 时用于兜底档位 */
	standard: string
	/** 该模型可选的思考深度码（内核 thinkingLevels；hasThinkingLevels=false 时按 standard 兜底） */
	thinkingLevels: string[]
	/** 内核是否明确下发 thinkingLevels；空数组=明确不可调，仅保留 auto */
	hasThinkingLevels: boolean
}

export type LevelOption = {
	/** 展示名（i18n 文案或格式化窗口大小） */
	name: string
	/** 提交给内核的原始值：思考深度码（low/medium/...）或上下文 token 数串 */
	value: string
	desc: string
}

/** 技能选择项。id = 内核 slash id（技能目录名，发送时前置 "/<id> "）；name = 展示名（不上 wire）。 */
export type SkillOption = {
	id: string
	name: string
	desc: string
	badge: string
	color: string
}

/** 连接器选择项。id = 内核服务器目录名（mcp/select 提交口径）；name = 展示名。 */
export type ConnectorOption = {
	id: string
	name: string
	desc: string
	enabled: boolean
	color: string
	icon: string
}

/** 待发送附件（mobile-link v1.1：input 内联 base64）。bytes 为原始字节数，供限额校验与展示。 */
export type PendingAttachment = {
	name: string
	type: string // 'image' | 'file'
	dataBase64: string
	bytes: number
	/** 图片 MIME 子类型（不含 'image/' 前缀，如 'jpeg'/'png'）；选图器回填 */
	mime: string
}

/** AI 消息生命周期（对齐 uni-ai-x 会话状态机）：流式输出中 / 正常完成 / 用户手动停止 */
export type ChatMsgStatus = 'processing' | 'done' | 'stopped'

/** 桌面端过程行的类型；气泡内按帧时序平铺，不与最终正文混成一个文本框。
 *  text 是过程中的 Markdown/正文增量块，最终态只保留最后一个 text 块常驻。 */
export type ChatBlockKind = 'text' | 'thinking' | 'tool' | 'agent' | 'batch' | 'error' | 'retry' | 'notice' | 'qa' | 'compacted'

/** 状态点口径（桌面端 .tool-status-icon）：loading/done/warn/reject 四态 */
export type ChatBlockStatus = 'loading' | 'done' | 'warn' | 'reject'

/** 交互卡中的一个选项（question 帧 args.questions[i].options[j]，契约 §5.1）。
 *  description 是可选新字段，detail 是模型自发用过的别名，解析时统一收进 description。 */
export type AskOption = {
	/** 原始 label：出站答案与选中判定一律用它，绝不用展示用短标题 */
	label: string
	description: string
	recommended: boolean
}

/** 交互卡中的一道题（question 帧 args.questions[i]） */
export type AskQuestion = {
	header: string
	detail: string
	options: AskOption[]
	/** 契约 §5.1 可选字段：仅当选项可同时成立时为真 */
	multiSelect: boolean
}

/** 一道题的作答态。与 questions 等长同序，未作答的项 answered=false。
 *  单独存 selectedLabel(s)/supplement 而不是只存 text：换选项要保留已写的补充，
 *  多选要高亮命中项，两者都需要结构化字段（桌面 app-message.js:4025-4320 同构）。 */
export type AskAnswer = {
	index: number
	/** 出站 text：单选=label 或「label（补充：…）」；多选=「a、b、补充」 */
	text: string
	selectedLabel: string
	selectedLabels: string[]
	supplement: string
	skipped: boolean
	custom: boolean
	answered: boolean
}

/** 交互卡在气泡里的角色：
 *  - hitl     待审批（同意/拒绝）
 *  - question 待作答（选项 + 自由输入）
 *  - resolved 已闭环（只读回显：审批已放行 / 已答内容） */
export type ChatBlockInteract = '' | 'hitl' | 'question' | 'resolved'

/** 一条「扁平语义轨迹」：对齐桌面端 .thinking-block / .tool-card / .agent-card /
 *  .turn-batch-header / .chunk-error / .chunk-retry 的单行头 + 可折叠体。
 *  刻意不带圆角灰底卡片：桌面端 process-flat-contract 已钉死「无竖条、无圆角、透明底」。 */
export type ChatBlock = {
	id: string
	kind: ChatBlockKind
	/** 单行头主标签（13px 正体） */
	label: string
	/** rice-icon 名，统一 14px 线性图标 */
	icon: string
	/** 参数 / 文件名 / 描述摘要，单行省略 */
	args: string
	/** 折叠态仍可读的首行/末行摘要 */
	preview: string
	/** 展开体（思考全文 / 工具结果 / 子智能体摘要 / 正文增量） */
	body: string
	status: ChatBlockStatus
	/** 耗时文案（1.2s / 340ms） */
	duration: string
	/** 运行批次开盖时间戳（仅 kind=batch 且 status=loading 使用）：
	 *  UI 层每秒 tick 据此推算「正在执行中 · Ns」，与收口后的整批耗时同口径 */
	startedAt: number
	failed: boolean
	/** 交互卡（HITL / question）与错误/重试/问答凭据常驻，不进整轮折叠 */
	process: boolean
	/** 运行批次盖子 id；成员靠它跟随盖子折叠 */
	batchId: string
	/** 批次成员数（仅 kind=batch 使用） */
	batchCount: number
	/** 批次折叠标记（仅 kind=batch 使用）：创建即 true（默认折叠，点击才展开），收口保持 true */
	batchCollapsed: boolean
	/** 过程行展开态（思考全文/工具结果 body）：默认 false 只露行头，点击行头才展开。
	 *  2026-11 用户拍板：思考/工具内容默认关闭；交互卡/错误/文件变更卡不受此开关影响（常驻） */
	rowOpen: boolean
	/** 子智能体归属名，供同卡复用与标题展示 */
	agentName: string
	/** 工具/子智能体动作 id，帧配对用 */
	actionId: string
	/** 交互卡角色：'' = 普通过程行；hitl/question = 可作答；resolved = 已闭环只读回显 */
	interact: ChatBlockInteract
	/** 交互卡题面（question 帧解析结果；hitl 卡为空数组） */
	questions: AskQuestion[]
	/** 交互卡作答态（与 questions 等长同序） */
	answers: AskAnswer[]
	/** 提交在途：UI 置灰防重复点击（桌面 state.submitted 同款） */
	submitting: boolean
	/** 已提交失败的原因；非空时 UI 显示重试入口并保留答案 */
	submitError: string
	/** hitl 卡的命令原文（审批卡正文；question 卡为空串） */
	command: string
	/** 已闭环回显文案（resolved 卡的正文；审批「已同意」/ 作答「a、b」） */
	resolvedText: string
	/** 文件变更卡（args='fileChanges' 的 notice 块）的文件行；其余块恒为空数组。
	 *  同 run 的 file_changes 帧按 revision 整卡替换（桌面 onFileChangesChunk 同口径） */
	changes: ChatFileChange[]
	/** 文件变更卡「再显示 N 个文件」展开态：默认折叠只露 3 行（桌面 COLLAPSED_ROWS 同款） */
	changesOpen: boolean
	/** 裸工具名（去 source/ 前缀）：图标/本地化映射用，PC data-tool-name 同口径。
	 *  非工具块为空串。label 已是本地化显示名，此字段保留原始注册名供查表。 */
	bareTool: string
	/** 工具行文件名 chip（args.file_path 的 basename，PC .tool-file 同口径）；无则空串 */
	fileName: string
	/** edit 工具头部增删统计（PC .tool-diff-stat）：+N -M 拆两段着色；无则空串 */
	diffAdd: string
	diffDel: string
	/** 思考行收口耗时（PC「已思考 (Ns)」的 Ns）；运行中为空串 */
	thoughtTime: string
	/** 压缩分隔线的消息数明细（'120 → 32'，PC .context-compacted-divider data-detail 同口径）：
	 *  仅 kind=compacted 使用，来自 context_compacted 帧 args.beforeMessages/afterMessages；无则空串。
	 *  【不上屏】PC 只把它写进 data-detail/title 悬停提示，可见文案恒为词条本身；
	 *  原生端无 title 能力，明细仅留数据字段（2026-11-27 第二轮报障：明细被当可见文本渲染） */
	compactDetail: string
	/** 工具展开明细的原始入参（PC args 同源，2026-11-27 第三轮报障「编辑展开内容
	 *  和 PC 全都不一样」根因之一：明细渲染缺完整参数——args 是预览截断 160 不能用）：
	 *  edit 需要完整 old_str/new_str/diff 合成 diff；bash 需要完整 command；
	 *  todowrite/todoread 取 todos 原文（PC renderTodoMarkdown 同口径）。
	 *  单字段上限 4000 防消息膨胀；空串=无此参数。非工具块恒为空串。 */
	diffRaw: string
	oldRaw: string
	newRaw: string
	commandRaw: string
	todosRaw: string
}

/** 文件变更卡的一行（summary.files[i] 的展示投影，只取 UI 需要的字段） */
export type ChatFileChange = {
	path: string
	/** ADDED / MODIFIED / DELETED → A / M / D 徽标 */
	kind: string
	additions: number
	deletions: number
}

/** 会话内单条消息；meta 为 AI 气泡底部的状态行。
 *  blocks 是气泡直接子级、按帧时序平铺（桌面端 insertBeforeActions 同款），
 *  text 仍是最终正文快照：历史 /messages 只给文本、滚动锚点也依赖它。 */
export type ChatMessage = {
	id: string
	role: 'user' | 'ai'
	text: string
	meta: string
	status: ChatMsgStatus
	thinking: boolean
	blocks: ChatBlock[]
	/** 用户消息的图片附件（imagePaths 经 /web/chat/attachment/meta 换回的 dataUrl 缩略图）：
	 *  纯附件消息 text 只有「[图片N]」占位，图片本体全在这里（PC .user-attach-imgs 同款）。
	 *  AI 消息恒为空数组。meta 拉取失败/降级时保持空数组——占位文案兜底，不留破图标。 */
	imageUrls: string[]
	/** 运行中插话（steer_applied）标记：PC appendSteerNote 同款——它是用户在任务
	 *  执行中途补发的一句话，按【用户气泡】形态展示，仅多一枚「插话」身份徽标。
	 *  旧的 notice 工具行形态（挂在 AI 轨迹里）已废弃：视觉像内核事件、不像用户说的话。
	 *  普通用户消息恒为 false。 */
	steer: boolean
	/** 整轮 Compact 摘要头（done/stopped 后生成，只含状态词+耗时，如「已完成 12s」）；
	 *  空=运行态。分类计数不再拼进长文本（窄屏折行遮挡真因），由 counts 驱动图标 chips。 */
	summary: string
	/** 摘要展开态，默认收起：只留最终正文 */
	compactOpen: boolean
	counts: { tools: number; reasons: number; agents: number; batches: number; texts: number }
	/** 历史回放失败后仅展示 /messages 文本快照：过程与产物卡片不可用。
	 *  非空时气泡展示提示并提供重试入口，绝不把降级态伪装成完整消息。 */
	degradedNotice: string
}

export type Conversation = {
	id: string
	title: string
	workspace: string
	pinned: boolean
	updatedAt: number
	messages: ChatMessage[]
}

/** 会话产出文件（数据源 = 内核 GET /web/chat/changes/session，与桌面任务监控「产出」区同源）。
 *  只做 UI 投影：内核返回的原始行见 hooks/useArtifacts.parseArtifacts。 */
export type ArtifactFile = {
	/** 会话工作区内的相对路径（原样透传给 filer/read 预览） */
	path: string
	/** 文件名（path 的 basename，卡片主文案） */
	name: string
	/** 扩展名（大写，无扩展名为空串）：卡片副标题的「MD 文件」用 */
	ext: string
	/** ADDED / MODIFIED / DELETED → A / M / D（与消息内文件变更卡同口径） */
	kind: string
	additions: number
	deletions: number
	/** 内核 binary 标记：true 时不做内联预览（仅元信息 + 提示到桌面端查看）。
	 *  注意这是**账本历史**值，可能与当前内容不符，详情以内核当次返回为准。 */
	binary: boolean
	/** 扩展名判定为图片：只影响卡片图标（图片同样不做内联预览） */
	image: boolean
}

/** 全局「对话」区的内部键：不落 UI（展示名走 i18n conv.title），也是 root='' 的映射键。
 * 不能用展示文案当键：切换语言后所有比对会失配 */
export const DEFAULT_WORKSPACE: string = '__chat__'

export const PERMISSIONS: PermissionOption[] = [
	{ name: 'default', labelKey: 'home.run.permDefault', descKey: 'home.run.permDefaultDesc', danger: false },
	{ name: 'full', labelKey: 'home.run.permFull', descKey: 'home.run.permFullDesc', danger: true }
]

// 技能/连接器不再放演示数据：清单必须来自设备内核真实接口
// （/web/settings/skills/installed、/web/settings/mcp/servers，见 hooks/useRunEnv.ts）。
// 设备离线/未装任何技能时显示空态文案，绝不编造假条目。

// 产物清单不再放演示数据：必须来自设备内核真实账本
// （GET /web/chat/changes/session，见 hooks/useArtifacts.ts）。
// 设备离线 / 该会话尚无产出时显示空态文案，绝不编造假文件名。
