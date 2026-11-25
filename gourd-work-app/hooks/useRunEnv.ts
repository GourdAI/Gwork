/**
 * 运行环境与模型配置的跨页面共享状态。
 *
 * 模型选择对齐桌面 app-history.js / model-dropdown-ui.js：
 * - 清单按 provider/providerId 严格保序分组，搜索按服务商/模型/描述 AND 匹配；
 * - 思考档位与上下文 chips 关联在当前选中模型下，按 thinkingLevels 即时重建；
 * - 选中即提交 models/select + thinking/select + context/select，无「确认」按钮；
 * - 三个 select 与 /web/chat/input 使用同一 sessionId + X-Session-Cwd（这里经 cwd 信封透传）。
 *
 * 首页欢迎态没有真实 sessionId：模型写全局默认，思考/上下文保留为「新会话继承值」，
 * 创建会话后由 inheritSelectionToSession 在首次 input 前落到真实会话，绝不写回旧会话。
 *
 * 对外 modelValue/thinkValue/contextValue 一律是提交给内核的原始码，不再用 i18n 展示名
 * 反查（上一轮 findLevelValue(name) 失配会静默跳过 select，表现为「选了没生效」）。
 * 本轮修复：离线态保留旧档位；会话级选中值缓存优先于 GET 回读；欢迎态不发空 sid 的 POST；minimal 原始码不归一。
 */
import { computed, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { i18n } from '@/locale/i18n.ts'
import { fieldString } from '@/utils/tools.ts'
import { gworkSignedIn } from '@/utils/gwork-auth.ts'
import { ensureConnected, request, kernelOk } from '@/utils/gwork-link.ts'
import { useDevices } from '@/hooks/useDevices'
import { useWorkspaces, workspaceLabel } from '@/hooks/useWorkspaces'
import { DEFAULT_WORKSPACE, PERMISSIONS } from '@/data/app-data'
import type { ApiBody } from '@/utils/request.ts'
import type { ConnectorOption, DeviceOption, LevelOption, ModelOption, PermissionOption, SkillOption, WorkspaceOption } from '@/data/app-data'

export type ModelConfig = {
	model: string
	think: string
	context: string
	/** 权限协议码（'default'|'full'）：per-session 缓存必须携带，
	 *  否则切会话/切设备时上一会话的「允许完全访问」会静默扩散到新会话（P0） */
	permission: string
}

export type RunEnv = {
	// 展示值一律只读 ComputedRef：真源在 useDevices / useWorkspaces / 内部选中值，
	// 业务侧只可经 setDevice/setWorkspace/setModelConfig 等入口改写（误写 .value 会被 tsc 拦截）
	device: ComputedRef<string>
	deviceOnline: ComputedRef<boolean>
	workspace: ComputedRef<string>
	permission: Ref<string>
	model: ComputedRef<string>
	think: ComputedRef<string>
	context: ComputedRef<string>
	/** 原始码：内核 models/select 的 modelName、thinking/select 的 depth、context/select 的 token 数 */
	modelValue: Ref<string>
	thinkValue: Ref<string>
	contextValue: Ref<string>
	selectedSkill: Ref<string>
	attachTag: Ref<string>
	connectorStates: Ref<Record<string, boolean>>
	/** 设备真实技能清单（/web/settings/skills/installed，enabled!==false） */
	skills: Ref<SkillOption[]>
	/** 设备真实连接器清单（/web/settings/mcp/servers，仅已启用） */
	connectors: Ref<ConnectorOption[]>
	/** Java 内核无 /web/chat/mcp/select：列表只读展示，不伪造成功 */
	connectorSelectable: Ref<boolean>
	/** 打开选择器时拉取真实清单（设备离线/未登录时为空态） */
	refreshSkills: () => Promise<void>
	refreshConnectors: () => Promise<void>
	models: Ref<ModelOption[]>
	thinkLevels: Ref<LevelOption[]>
	contextWindows: Ref<LevelOption[]>
	/** 是否渲染思考档位行；仅有 auto（内核下发空档位）时隐藏整行 */
	thinkSelectable: Ref<boolean>
	setDevice: (name: string, online: boolean) => void
	setWorkspace: (name: string) => void
	/** 切档（name 为协议码 'default'|'full'）。返回是否受理：离线/未登录返回 false，调用方不得提示成功 */
	setPermission: (name: string) => boolean
	/** 按指定模型重建思考档位；弹层打开 / 当前值变化时调用 */
	syncOptionsForModel: (model: string) => void
	/** 选中即生效；参数均为原始码 */
	setModelConfig: (model: string, think: string, context: string) => void
	currentConfig: () => ModelConfig
	/** 切换会话：按真实 sessionId 回读；root 用于 X-Session-Cwd 归属，避免两份 context.json */
	bindSession: (sessionId: string, root?: string) => void
	/** 进入首页欢迎态：保留当前选择作为新会话继承值，后续设置不写回旧会话；
	 *  resetWorkspace=true 时工作空间复位回全局「对话」区（新建对话默认未选择） */
	beginNewSession: (resetWorkspace?: boolean) => void
	toggleConnector: (name: string, onDone?: (on: boolean) => void) => boolean
	refreshModels: (force?: boolean) => Promise<void>
}

/** 权限展示名：协议码 → i18n 现取（UI 一律经此，不得直接展示协议码） */
export function permissionLabel(code: string): string {
	const found: PermissionOption | undefined = PERMISSIONS.find((p: PermissionOption): boolean => p.name === code)
	return i18n.global.t(found != null ? found.labelKey : 'home.run.permDefault')
}

export function permissionDesc(code: string): string {
	const found: PermissionOption | undefined = PERMISSIONS.find((p: PermissionOption): boolean => p.name === code)
	return i18n.global.t(found != null ? found.descKey : 'home.run.permDefaultDesc')
}

/** 内核 reasoning.rs 词表：low/medium/high/xhigh/max；minimal 是旧码，桌面 normalizeThinkingCode 折叠到 low */
const THINK_LABEL_KEYS: Record<string, string> = {
	auto: 'model.think.auto',
	minimal: 'model.think.minimal',
	low: 'model.think.low',
	medium: 'model.think.medium',
	high: 'model.think.high',
	xhigh: 'model.think.xhigh',
	max: 'model.think.max'
}
const FALLBACK_CONTEXT_OPTIONS: number[] = [128000, 256000, 512000, 1000000]
const DEFAULT_CONTEXT_TOKENS: string = '256000'

/** 权限协议码（'default'|'full'）：per-session 真源。绑定/新建会话时从缓存恢复，
 *  缓存未命中先复位 default 再等服务端回读——绝不把上一会话的档位带过来（P0）。 */
const permission: Ref<string> = ref<string>(PERMISSIONS[0].name)
/** 权限写入在途代次：独立于模型 writeGeneration，异步 GET 回读不得覆盖用户刚切的档位；
 *  提交失败按代次回滚（晚到的旧失败不能回滚新选择） */
let permissionWriteGen: number = 0
const selectedSkill: Ref<string> = ref<string>('')
const attachTag: Ref<string> = ref<string>('')
/** 键 = 连接器目录名 id（mcp/select 提交口径），值 = 本会话是否勾选 */
const connectorStates: Ref<Record<string, boolean>> = ref<Record<string, boolean>>({})
const skills: Ref<SkillOption[]> = ref<SkillOption[]>([])
const connectors: Ref<ConnectorOption[]> = ref<ConnectorOption[]>([])
/** Java 内核没有 mcp/select 路由：探测到 404 后置 false，选择器只读展示 */
const connectorSelectable: Ref<boolean> = ref<boolean>(true)
/** 欢迎态连接器勾选在会话绑定前不被回显冲掉（与 welcomeHasLocalSelection 同思想） */
let welcomeConnectorPick: boolean = false

const models: Ref<ModelOption[]> = ref<ModelOption[]>([])
const thinkLevels: Ref<LevelOption[]> = ref<LevelOption[]>([autoThinkOption()])
const contextWindows: Ref<LevelOption[]> = ref<LevelOption[]>(fallbackContextWindows())
/** 仅有 auto 时隐藏整行思考档位；由 syncOptionsForModel 按当前模型档位数更新 */
const thinkSelectable: Ref<boolean> = ref<boolean>(true)
/** 会话级选中值缓存：本地点选/新会话继承优先于内核 GET 回读，避免弹层反复打开时旧值覆盖 */
const sessionSelectionCache: Map<string, ModelConfig> = new Map<string, ModelConfig>()
/** 欢迎态缓存键：空 sessionId 不能作为会话键，本地选择由 welcomeHasLocalSelection 闸门保护 */
const WELCOME_CACHE_KEY: string = '__welcome__'

/** 当前生效值；selectedModelId 存内核可识别的 name（settings.models 的 key/name），不是裸 model 字段 */
const selectedModelId: Ref<string> = ref<string>('')
const thinkValue: Ref<string> = ref<string>('auto')
const contextValue: Ref<string> = ref<string>(DEFAULT_CONTEXT_TOKENS)
const modelsLoading: Ref<boolean> = ref<boolean>(false)
/** 空串 = 首页欢迎页（全局态）；切换会话后按 sessionId 回读并持久化 */
const boundSession: Ref<string> = ref<string>('')
/** 会话归属根；three selects / input 必须带同一 cwd，设备侧转 X-Session-Cwd */
const boundRoot: Ref<string> = ref<string>('')
/** 欢迎态已有本地选择（冷启动读全局默认也算 false，用户选过或从会话返回为 true）：
 *  GET 回读只刷新清单/选项，不覆盖这些继承值。 */
let welcomeHasLocalSelection: boolean = false
/** 每次会话绑定递增；异步 GET 回来时校验代次，防止旧会话响应覆盖新会话回显 */
let sessionGeneration: number = 0
/** 新建会话需要继承的当前选择（模型 name / 思考码 / 上下文 token 数） */
let inheritedModel: string = ''
let inheritedThink: string = 'auto'
let inheritedContext: string = DEFAULT_CONTEXT_TOKENS
let lastModelFetch: number = 0
let watching: boolean = false
/** 写入在途代次：GET 回读只可覆盖「发起时不晚于最后一次本地选择」的响应，
 *  防止打开弹层后异步回来的旧 selected 把用户刚点选的模型/档位冲掉。 */
let writeGeneration: number = 0

function t(key: string): string {
	return i18n.global.t(key)
}

/** 展示名首字作徽标（真实清单没有配色/图标元数据时的稳定兜底） */
function badgeOf(name: string): string {
	return name.length > 0 ? name.substring(0, 1).toUpperCase() : '?'
}

/** 技能 slash 前缀（桌面 app-streaming.js 同构：多技能多段 "/<id> "，展示名不上 wire）。
 *  selectedSkill 存内核目录名 id；空选择返回空串。发送文本 = 前缀 + 用户正文。 */
export function skillPrefix(): string {
	if (selectedSkill.value.length === 0) return ''
	return '/' + selectedSkill.value + ' '
}

async function refreshSkills(): Promise<void> {
	const devices = useDevices()
	if (!gworkSignedIn().value || devices.activeDeviceId.value.length === 0) return
	const deviceKey: string = devices.activeDeviceId.value
	try {
		await ensureConnected(deviceKey)
		const body: ApiBody = await request('GET', '/web/settings/skills/installed', '', '', '', 'application/json')
		if (devices.activeDeviceId.value !== deviceKey) return
		if (!kernelOk(body)) return
		const raw: any = body['data']
		if (!(raw instanceof Array)) return
		const list: SkillOption[] = []
		for (let i = 0; i < raw.length; i++) {
			const item: ApiBody = raw[i] as ApiBody
			const id: string = fieldString(item, 'name')
			if (id.length === 0) continue
			// enabled 缺省视为启用；显式 false 的禁用技能不进选择器
			if (item['enabled'] === false) continue
			const display: string = fieldString(item, 'displayName').length > 0
				? fieldString(item, 'displayName')
				: (fieldString(item, 'title').length > 0 ? fieldString(item, 'title') : id)
			list.push({ id: id, name: display, desc: fieldString(item, 'description'), badge: badgeOf(display), color: '#6b5bd2' })
		}
		skills.value = list
		// 已选技能被卸载/禁用：清掉悬空选择，避免发送 "/不存在" 前缀
		if (selectedSkill.value.length > 0 && !list.some((s: SkillOption): boolean => s.id === selectedSkill.value)) {
			selectedSkill.value = ''
		}
	} catch (_) {
		// 离线/超时：保留旧清单（可能是短暂抖动），选择器空态由 UI 兜底
	}
}

async function refreshConnectors(): Promise<void> {
	const devices = useDevices()
	if (!gworkSignedIn().value || devices.activeDeviceId.value.length === 0) return
	const deviceKey: string = devices.activeDeviceId.value
	try {
		await ensureConnected(deviceKey)
		const body: ApiBody = await request('GET', '/web/settings/mcp/servers', '', '', '', 'application/json')
		if (devices.activeDeviceId.value !== deviceKey) return
		if (!kernelOk(body)) return
		const raw: any = body['data']
		if (!(raw instanceof Array)) return
		const list: ConnectorOption[] = []
		for (let i = 0; i < raw.length; i++) {
			const item: ApiBody = raw[i] as ApiBody
			const id: string = fieldString(item, 'name')
			if (id.length === 0) continue
			if (item['enabled'] === false) continue
			const display: string = fieldString(item, 'displayName').length > 0 ? fieldString(item, 'displayName') : id
			list.push({ id: id, name: display, desc: fieldString(item, 'description'), enabled: true, color: '#2f7df6', icon: 'link' })
		}
		connectors.value = list
		connectorSelectable.value = true
		// 会话态回显：/web/chat/models 的 mcpServers（null=从未选过=全不选，桌面同口径）
		await syncConnectorEcho()
	} catch (_) {
		// 离线保留旧清单
	}
}

/** 会话连接器勾选回显（桌面 app-connector-picker.js 同构：mcpServers null=全不选）。
 *  Java 内核不下发 mcpServers 字段：保留本地态（其 mcp/select 也不存在，见 toggleConnector）。 */
async function syncConnectorEcho(): Promise<void> {
	const sid: string = boundSession.value
	if (sid.length === 0 || welcomeConnectorPick) return
	const devices = useDevices()
	if (devices.activeDeviceId.value.length === 0) return
	try {
		const body: ApiBody = await request('GET', '/web/chat/models', 'sessionId=' + encodeURIComponent(sid), '', boundRoot.value, 'application/json')
		if (boundSession.value !== sid || !kernelOk(body)) return
		const data: ApiBody = body['data'] as ApiBody
		const raw: any = data['mcpServers']
		if (raw == null) {
			// Rust null=从未选过→全不选；Java 无此字段→保持现状不动
			const next: Record<string, boolean> = {}
			connectors.value.forEach((c: ConnectorOption): void => { next[c.id] = false })
			connectorStates.value = next
			return
		}
		if (raw instanceof Array) {
			const picked: string[] = []
			for (let i = 0; i < raw.length; i++) picked.push(String(raw[i]))
			const next: Record<string, boolean> = {}
			connectors.value.forEach((c: ConnectorOption): void => { next[c.id] = picked.indexOf(c.id) >= 0 })
			connectorStates.value = next
		}
	} catch (_) {
		// 回显失败不阻塞选择器
	}
}

/** 勾选集提交（form：sessionId + servers JSON 数组，桌面 pickConnector 同口径）。
 *  显式 [] 合法（全不选=本会话无连接器工具）。Java 404 → 只读降级。
 *  【代次守卫】快速连点两个开关会以旧全量快照覆盖新快照：只认最后一次提交的成败，
 *  失败按「最后一次本地快照之前」的状态回滚；onDone 仅在成功时回调（成功 toast 不得先于结果）。 */
let connectorSubmitGen: number = 0
function submitConnectorSelection(onDone?: (on: boolean) => void, doneId?: string): void {
	const sid: string = boundSession.value
	const devices = useDevices()
	if (!gworkSignedIn().value || devices.activeDeviceId.value.length === 0) return
	const gen: number = ++connectorSubmitGen
	const snapshot: Record<string, boolean> = {}
	Object.keys(connectorStates.value).forEach((key: string): void => {
		snapshot[key] = connectorStates.value[key]
	})
	const picked: string[] = []
	connectors.value.forEach((c: ConnectorOption): void => {
		if (connectorStates.value[c.id] === true) picked.push(c.id)
	})
	const settle = (ok: boolean): void => {
		if (connectorSubmitGen !== gen) return
		connectorSubmitGen = 0
		if (ok) {
			if (onDone != null && doneId != null) onDone(snapshot[doneId] === true)
			return
		}
		// 失败回滚到提交前状态（toggleConnector 已把 prev 存进 lastConnectorPrev）
		connectorStates.value = lastConnectorPrev
		uni.showToast({ title: t('request.operationFailed'), icon: 'none' })
	}
	if (sid.length === 0) {
		// 欢迎态本地暂存；createConversation 后经 inheritSelectionToSession 落盘
		welcomeConnectorPick = true
		settle(true)
		return
	}
	request('POST', '/web/chat/mcp/select', '',
		'sessionId=' + encodeURIComponent(sid) + '&servers=' + encodeURIComponent(JSON.stringify(picked)),
		boundRoot.value, 'application/x-www-form-urlencoded').then((body: ApiBody): void => {
		const code: any = body['code']
		if (code === 404) {
			// Java 内核没有会话级选择路由：只读展示 + 明确提示，不伪造成功
			connectorSelectable.value = false
			if (connectorSubmitGen === gen) {
				connectorSubmitGen = 0
				connectorStates.value = lastConnectorPrev
			}
			uni.showToast({ title: t('home.connectors.readonly'), icon: 'none' })
			return
		}
		settle(kernelOk(body))
	}, (): void => {
		settle(false)
	})
}
/** 最近一次 toggle 之前的勾选快照：提交失败时回滚用（代次守卫保证只回滚最新一次） */
let lastConnectorPrev: Record<string, boolean> = {}

function normalizeThinking(value: string): string {
	if (value.length === 0 || value === 'off') return 'auto'
	if (value === 'minimal') return 'low'
	return value
}

function thinkLabel(value: string): string {
	const key: string | undefined = THINK_LABEL_KEYS[value]
	return key != null ? t(key) : value
}

function thinkDesc(value: string): string {
	const key: string | undefined = THINK_LABEL_KEYS[value]
	return key != null ? t(key + 'Desc') : ''
}

function autoThinkOption(): LevelOption {
	return { name: thinkLabel('auto'), value: 'auto', desc: thinkDesc('auto') }
}

function contextLabel(tokens: number): string {
	if (tokens >= 1000000 && tokens % 1000000 === 0) return (tokens / 1000000).toString() + 'M'
	if (tokens >= 1000 && tokens % 1000 === 0) return (tokens / 1000).toString() + 'K'
	return tokens.toString()
}

function fallbackContextWindows(): LevelOption[] {
	const list: LevelOption[] = []
	FALLBACK_CONTEXT_OPTIONS.forEach((tokens: number): void => {
		list.push({ name: contextLabel(tokens), value: tokens.toString(), desc: t('model.context.desc') })
	})
	return list
}

function canonicalModelName(raw: string): string {
	if (raw.length === 0) return ''
	const found: ModelOption | undefined = models.value.find((item: ModelOption): boolean => item.name === raw || item.model === raw)
	return found != null ? found.name : raw
}

function modelOptionOf(raw: string): ModelOption | undefined {
	return models.value.find((item: ModelOption): boolean => item.name === raw || item.model === raw)
}

/** 构建某模型可选思考档位：auto 置顶；明确下发空数组=不可调，仅 auto；字段缺失按 standard 兜底。
 *
 *  【关键】兜底必须无条件生效（对齐桌面 model-selector.js:161-163
 *  `if (levels == null) levels = fallbackThinkingLevels(row.standard)`）：
 *  早期实现要求 `standard.length > 0` 才兜底，而多数服务商并未下发 standard，
 *  结果 codes 只剩 ['auto'] → thinkSelectable=false → 整行档位被隐藏，
 *  用户看到的就是「思考等级没法选」。 */
function buildThinkLevels(modelName: string): LevelOption[] {
	const model: ModelOption | undefined = modelOptionOf(modelName)
	const codes: string[] = ['auto']
	// 【三态语义，抄 model-selector.js:120 / 163】
	//   字段缺失（hasThinkingLevels=false）→ 后端未下发 → 按 standard 兜底；
	//   下发空数组（hasThinkingLevels=true 且 length=0）→ 明确不可调 → 只留 auto，绝不兜底；
	//   下发非空数组 → 用内核给的真实档位。
	// 旧实现无条件兜底，把「明确不可调」的模型也编出 low/medium/high，
	// 用户选了这些内核不认的档位，发出去等于没选（表现为「思考等级选了没用」）。
	let levels: string[] = model != null ? model.thinkingLevels : []
	const hasLevelsField: boolean = model != null && model.hasThinkingLevels
	if (!hasLevelsField) {
		const std: string = model != null ? model.standard.toLowerCase() : ''
		levels = std.indexOf('anthropic') >= 0 || std.indexOf('claude') >= 0
			? ['low', 'medium', 'high', 'xhigh', 'max']
			: ['low', 'medium', 'high']
	}
	levels.forEach((code: string): void => {
		// 桌面 thinkingOptionsForModel 不归一：Rust 会下发 minimal，归一会把两档合并少渲染一档
		if (code === 'auto') return
		if (codes.indexOf(code) < 0) codes.push(code)
	})
	return codes.map((code: string): LevelOption => {
		return { name: thinkLabel(code), value: code, desc: thinkDesc(code) }
	})
}

function validThinkCode(code: string, modelName: string): string {
	const levels: LevelOption[] = buildThinkLevels(modelName)
	const found: LevelOption | undefined = levels.find((item: LevelOption): boolean => item.value === code)
	return found != null ? code : 'auto'
}

function validContextTokens(raw: string): string {
	const found: LevelOption | undefined = contextWindows.value.find((item: LevelOption): boolean => item.value === raw)
	if (found != null) return found.value
	const parsed: number = parseInt(raw)
	if (!isNaN(parsed)) {
		const byNumber: LevelOption | undefined = contextWindows.value.find((item: LevelOption): boolean => item.value === parsed.toString())
		if (byNumber != null) return byNumber.value
	}
	return DEFAULT_CONTEXT_TOKENS
}

function parseModelRows(data: ApiBody): ModelOption[] {
	const list: ModelOption[] = []
	if (!Array.isArray(data.list)) return list
	const rows = data.list as ApiBody[]
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]
		const id: string = fieldString(row, 'model')
		const name: string = fieldString(row, 'name')
		if (id.length === 0 && name.length === 0) continue
		const levels: string[] = []
		const hasLevels: boolean = Array.isArray(row.thinkingLevels)
		if (hasLevels) {
			const raw = row.thinkingLevels as string[]
			for (let j = 0; j < raw.length; j++) {
				if (typeof raw[j] === 'string') levels.push(raw[j])
			}
		}
		list.push({
			model: id.length > 0 ? id : name,
			name: name.length > 0 ? name : id,
			desc: fieldString(row, 'description'),
			provider: fieldString(row, 'provider'),
			providerId: fieldString(row, 'providerId'),
			standard: fieldString(row, 'standard'),
			thinkingLevels: levels,
			hasThinkingLevels: hasLevels
		})
	}
	return list
}

function applyContextOptions(data: ApiBody): void {
	const windows: LevelOption[] = []
	if (Array.isArray(data.contextOptions)) {
		const opts = data.contextOptions as number[]
		for (let i = 0; i < opts.length; i++) {
			const tokens = opts[i]
			if (typeof tokens !== 'number') continue
			windows.push({ name: contextLabel(tokens), value: tokens.toString(), desc: t('model.context.desc') })
		}
	}
	if (windows.length > 0) contextWindows.value = windows
}

/** 回读 selected/thinkingDepth/contextLength；欢迎态已有本地继承值时只刷选项，不冲掉它。
 *  会话级缓存命中时一律用缓存值刷新回显，内核旧值不再覆盖用户点选/新会话继承。 */
function applySelection(data: ApiBody, writeGen: number): void {
	const cacheKey: string = boundSession.value.length > 0 ? boundSession.value : WELCOME_CACHE_KEY
	// 【权限回读不受模型闸门/缓存短路保护】accessMode 是会话真值：欢迎态本地选择
	// 或缓存命中时若跳过回读，上一会话的 full 档会静默扩散（P0）。仅本地切档在途
	// （permissionWriteGen 已推进）时让位，防止旧 GET 冲掉用户刚点的档位。
	const accessRaw: string = fieldString(data, 'accessMode')
	if ((accessRaw === 'full' || accessRaw === 'default') && permissionWriteGen === 0) {
		permission.value = accessRaw
		const prev: ModelConfig | undefined = sessionSelectionCache.get(cacheKey)
		if (prev != null) {
			sessionSelectionCache.set(cacheKey, { model: prev.model, think: prev.think, context: prev.context, permission: accessRaw })
		}
	}
	if (writeGen !== writeGeneration || welcomeHasLocalSelection) return
	const cached: ModelConfig | undefined = sessionSelectionCache.get(cacheKey)
	if (cached != null) {
		// 缓存命中：不读 data 的 selected/thinkingDepth/contextLength；上下文选项与档位仍由调用方刷新
		selectedModelId.value = cached.model
		thinkValue.value = cached.think
		contextValue.value = cached.context
		return
	}
	selectedModelId.value = canonicalModelName(fieldString(data, 'selected'))
	// 仅回显归一：minimal 是内核原始档位，选项构造与提交都不归一
	thinkValue.value = normalizeThinking(fieldString(data, 'thinkingDepth'))
	const ctxRaw = data.contextLength
	const ctx: string = typeof ctxRaw === 'number' ? (ctxRaw as number).toString() : fieldString(data, 'contextLength')
	contextValue.value = ctx.length > 0 ? validContextTokens(ctx) : DEFAULT_CONTEXT_TOKENS
	// 回读结果同样入缓存：同一会话再次打开弹层直接短路，不再向内核重拉旧选中值
	sessionSelectionCache.set(cacheKey, {
		model: selectedModelId.value, think: thinkValue.value, context: contextValue.value, permission: permission.value
	})
}

function syncOptionsForModel(modelName: string): void {
	const name: string = canonicalModelName(modelName)
	thinkLevels.value = buildThinkLevels(name)
	const code: string = validThinkCode(thinkValue.value, name)
	if (code !== thinkValue.value) {
		thinkValue.value = code
		if (boundSession.value.length === 0) {
			// 欢迎态收敛档位时三项继承值全量同步，会话态不动继承值
			inheritedModel = name
			inheritedThink = code
			inheritedContext = contextValue.value
		}
	}
	if (contextWindows.value.length === 0) contextWindows.value = fallbackContextWindows()
	// 内核 WebController / 桌面 model-selector：仅有 auto 时隐藏整行思考档位
	thinkSelectable.value = thinkLevels.value.length > 1
}

function currentConfig(): ModelConfig {
	return { model: selectedModelId.value, think: thinkValue.value, context: contextValue.value, permission: permission.value }
}

/** 拉取真实模型清单；会话态用当前 sessionId 回读，首页欢迎页用 sessionId='' 读全局默认。
 *  cwd 与 input 同源，避免项目会话读写到全局那份 context.json。 */
export async function refreshModels(force: boolean = false): Promise<void> {
	const devices = useDevices()
	if (!gworkSignedIn().value || devices.activeDeviceId.value.length === 0 || !devices.deviceOnline.value) {
		// 设备离线/未登录时保留旧清单与档位：清空会让弹层一打开就「思考/上下文都没法选」
		return
	}
	if (modelsLoading.value) return
	if (!force && models.value.length > 0 && Date.now() - lastModelFetch < 60000) {
		await refreshSessionSelection()
		return
	}
	modelsLoading.value = true
	try {
		// 代次必须在第一个 await 之前捕获：ensureConnected 期间用户可能已点选模型，
		// 若届时再读 writeGeneration，旧 GET 会误认自己是最新请求并覆盖乐观回显。
		const generation: number = sessionGeneration
		const writeGen: number = writeGeneration
		await ensureConnected(devices.activeDeviceId.value)
		const query: string = 'sessionId=' + encodeURIComponent(boundSession.value) + '&root=' + encodeURIComponent(boundRoot.value)
		const body: ApiBody = await request('GET', '/web/chat/models', query, '', boundRoot.value)
		if (!kernelOk(body) || generation !== sessionGeneration || writeGen !== writeGeneration) return
		const data = body.data != null && typeof body.data === 'object' ? body.data as ApiBody : {}
		models.value = parseModelRows(data)
		lastModelFetch = Date.now()
		applyContextOptions(data)
		applySelection(data, writeGen)
		syncOptionsForModel(selectedModelId.value)
		if (boundSession.value.length === 0 && !welcomeHasLocalSelection) {
			inheritedModel = selectedModelId.value
			inheritedThink = thinkValue.value
			inheritedContext = contextValue.value
		}
	} catch (_) {
		// 拉取失败保持旧清单与选项；选择是低频操作，发送链路会另行报错
	} finally {
		modelsLoading.value = false
	}
}

/** 会话切换 / 弹层反复打开时只回读选中值，不重拉几百行模型表。
 *  桌面 app-history.js:5132-5133：models 已加载且命中 per-session 缓存时不再发 GET。 */
async function refreshSessionSelection(): Promise<void> {
	if (models.value.length === 0) {
		await refreshModels(true)
		return
	}
	const cacheKey: string = boundSession.value.length > 0 ? boundSession.value : WELCOME_CACHE_KEY
	const cached: ModelConfig | undefined = sessionSelectionCache.get(cacheKey)
	if (cached != null) {
		// 缓存命中：不再发 GET；先按缓存恢复本会话回显（桌面 renderModelUI 同等语义），再本地重建档位
		selectedModelId.value = cached.model
		thinkValue.value = cached.think
		contextValue.value = cached.context
		if (permissionWriteGen === 0) permission.value = cached.permission
		syncOptionsForModel(selectedModelId.value)
		return
	}
	if (welcomeHasLocalSelection) {
		// 欢迎态已有本地选择但尚无缓存：同样只重建档位，不发 GET
		syncOptionsForModel(selectedModelId.value)
		return
	}
	const devices = useDevices()
	if (!gworkSignedIn().value || devices.activeDeviceId.value.length === 0 || !devices.deviceOnline.value) return
	try {
		// 同上：代次在 await 前捕获，避免回读与「选中即生效」写入交错。
		const generation: number = sessionGeneration
		const writeGen: number = writeGeneration
		await ensureConnected(devices.activeDeviceId.value)
		const query: string = 'sessionId=' + encodeURIComponent(boundSession.value) + '&root=' + encodeURIComponent(boundRoot.value)
		const body: ApiBody = await request('GET', '/web/chat/models', query, '', boundRoot.value)
		if (!kernelOk(body) || generation !== sessionGeneration || writeGen !== writeGeneration) return
		const data = body.data != null && typeof body.data === 'object' ? body.data as ApiBody : {}
		applyContextOptions(data)
		applySelection(data, writeGen)
		syncOptionsForModel(selectedModelId.value)
	} catch (_) {
		// 回读失败保持当前回显
	}
}

/** 选中即生效：会话态三个 select 全部按同一 sessionId + cwd 提交；
 *  欢迎态只做本地乐观赋值与继承值缓存，绝不向空 sessionId 发 POST（Java 内核会物化幽灵会话），
 *  三个 select 统一由 inheritSelectionToSession 在真实 sid 上提交。 */
async function applyModelConfig(nextModel: string, nextThink: string, nextContext: string): Promise<void> {
	const target: ModelOption | undefined = modelOptionOf(nextModel)
	const modelName: string = target != null ? target.name : (nextModel.length > 0 ? nextModel : selectedModelId.value)
	const sid: string = boundSession.value
	const cwd: string = boundRoot.value
	const thinkCode: string = validThinkCode(nextThink, modelName)
	const contextTokens: string = validContextTokens(nextContext)
	// 任何本地选择都让此前发起的 GET 回读失效；否则「打开弹层 → 点模型 → 旧 GET 回来」会回退回显
	writeGeneration += 1

	selectedModelId.value = modelName
	thinkValue.value = thinkCode
	contextValue.value = contextTokens
	syncOptionsForModel(modelName)
	inheritedModel = modelName
	inheritedThink = thinkCode
	inheritedContext = contextTokens
	// 缓存必须在任何 await 之前写：POST 失败也会保留本地选择，不再被下次 GET 冲掉
	sessionSelectionCache.set(sid.length > 0 ? sid : WELCOME_CACHE_KEY, {
		model: modelName, think: thinkCode, context: contextTokens, permission: permission.value
	})
	if (sid.length === 0) {
		// Java 内核对空 sessionId 会物化幽灵会话，Rust 才写全局默认；
		// 桌面从不用空 sid。欢迎态只做本地乐观值，统一由 inheritSelectionToSession 落盘。
		welcomeHasLocalSelection = true
		return
	}

	const devices = useDevices()
	if (!gworkSignedIn().value || devices.activeDeviceId.value.length === 0) return
	try {
		await ensureConnected(devices.activeDeviceId.value)
		// 三个 select 各自独立收敛：绝不能用一条 try 串三个 await ——
		// 中间任何一个抛错（超时/断线一次抖动）都会让后面两个 select 永不发出，
		// 而本地三项回显已更新，于是「界面显示改好了、内核还是旧值」。
		// 每次 POST 单独兜住，坏一项不影响另外两项。
		const posts: Promise<ApiBody>[] = [
			// 内核 settings.models 的 key/name 是带前缀全名；桌面 selectModel 传 m.name，不能传裸 m.model
			request('POST', '/web/chat/models/select', '',
				'modelName=' + encodeURIComponent(modelName) + '&sessionId=' + encodeURIComponent(sid),
				cwd, 'application/x-www-form-urlencoded'),
			request('POST', '/web/chat/thinking/select', '',
				'sessionId=' + encodeURIComponent(sid) + '&depth=' + encodeURIComponent(thinkCode),
				cwd, 'application/x-www-form-urlencoded'),
			request('POST', '/web/chat/context/select', '',
				'sessionId=' + encodeURIComponent(sid) + '&contextLength=' + encodeURIComponent(contextTokens),
				cwd, 'application/x-www-form-urlencoded')
		]
		for (let i = 0; i < posts.length; i++) {
			try {
				await posts[i]
			} catch (_) {
				// 单项失败：继续发后面两项
			}
		}
	} catch (_) {
		// 本地已乐观回显；失败不阻塞交互，下一次打开弹层会重新回读
	}
}

/** 新会话继承当前选择：必须在生成 sessionId 后、首次 input 前调用。
 *  cwd 传新会话归属根，与 /web/chat/input 的 X-Session-Cwd 完全一致。 */
export async function inheritSelectionToSession(sessionId: string, inherit?: ModelConfig, cwd?: string): Promise<void> {
	if (sessionId.length === 0) return
	if (inherit != null) {
		const target: ModelOption | undefined = modelOptionOf(inherit.model)
		inheritedModel = target != null ? target.name : inherit.model
		inheritedThink = validThinkCode(inherit.think, inheritedModel)
		inheritedContext = validContextTokens(inherit.context)
		writeGeneration += 1
	} else {
		inheritedModel = selectedModelId.value
		inheritedThink = thinkValue.value
		inheritedContext = contextValue.value
	}
	// 同步写缓存：createConversation 的 bindSession→refreshModels 会异步 GET，
	// 若不先占位，旧会话/全局默认值会抢在三个 select 之前覆盖新会话回显。
	sessionSelectionCache.set(sessionId, {
		model: inheritedModel, think: inheritedThink, context: inheritedContext, permission: permission.value
	})
	const root: string = cwd != null ? cwd : boundRoot.value
	const devices = useDevices()
	if (!gworkSignedIn().value || devices.activeDeviceId.value.length === 0 || !devices.deviceOnline.value) return
	try {
		await ensureConnected(devices.activeDeviceId.value)
		// 三个 select 并发提交、各自兜住异常：串行 await 在网络抖动时最坏会累计
		// 3×timeout（约百秒），而 ready Promise 卡住 /web/chat/input，用户看到「发了没反应」。
		// 三项互不依赖（同一 sessionId + cwd），与 applyModelConfig 的 posts 口径一致。
		const jobs: Promise<void>[] = []
		if (inheritedModel.length > 0) {
			jobs.push(request('POST', '/web/chat/models/select', '',
				'modelName=' + encodeURIComponent(inheritedModel) + '&sessionId=' + encodeURIComponent(sessionId),
				root, 'application/x-www-form-urlencoded').then((): void => {}, (): void => {}))
		}
		// 桌面 app-history.js:4918：auto 不必提交 thinking/select
		if (inheritedThink !== 'auto') {
			jobs.push(request('POST', '/web/chat/thinking/select', '',
				'sessionId=' + encodeURIComponent(sessionId) + '&depth=' + encodeURIComponent(inheritedThink),
				root, 'application/x-www-form-urlencoded').then((): void => {}, (): void => {}))
		}
		jobs.push(request('POST', '/web/chat/context/select', '',
			'sessionId=' + encodeURIComponent(sessionId) + '&contextLength=' + encodeURIComponent(inheritedContext),
			root, 'application/x-www-form-urlencoded').then((): void => {}, (): void => {}))
		// 权限档位随新会话继承（桌面 app-access-mode.js 同构）：欢迎态选过「允许完全访问」
		// 若不落 select，内核会话上下文停在 default，桌面端看这个会话就是默认权限。
		jobs.push(request('POST', '/web/chat/access/select', '',
			'sessionId=' + encodeURIComponent(sessionId) + '&accessMode=' + permission.value,
			root, 'application/x-www-form-urlencoded').then((): void => {}, (): void => {}))
		// 欢迎态勾过连接器：随新会话继承（桌面新会话默认不选，但用户显式勾过的必须带上）。
		// Java 无此路由：404 静默降级为只读（与 toggleConnector 同口径）。
		if (connectorSelectable.value && connectors.value.length > 0) {
			const picked: string[] = []
			connectors.value.forEach((c: ConnectorOption): void => {
				if (connectorStates.value[c.id] === true) picked.push(c.id)
			})
			if (picked.length > 0) {
				jobs.push(request('POST', '/web/chat/mcp/select', '',
					'sessionId=' + encodeURIComponent(sessionId) + '&servers=' + encodeURIComponent(JSON.stringify(picked)),
					root, 'application/x-www-form-urlencoded').then((body: ApiBody): void => {
					if (body['code'] === 404) connectorSelectable.value = false
				}, (): void => {}))
			}
		}
		await Promise.all(jobs)
	} catch (_) {
		// 继承失败不阻塞发起会话；发送链路会回落到内核默认
	}
}

function ensureWatchers(): void {
	if (watching) return
	watching = true
	const devices = useDevices()
	watch(devices.activeDeviceId, (): void => {
		models.value = []
		thinkLevels.value = [autoThinkOption()]
		contextWindows.value = fallbackContextWindows()
		selectedModelId.value = ''
		lastModelFetch = 0
		sessionSelectionCache.clear()
		// 技能/连接器是设备本地资产：换设备必须清空重拉，勾选态也随之复位
		skills.value = []
		connectors.value = []
		connectorStates.value = {}
		connectorSelectable.value = true
		selectedSkill.value = ''
		welcomeConnectorPick = false
		// 权限是会话级安全档位：换设备必须复位 default，等真实回读，绝不带旧设备的 full 档（P0）
		permission.value = PERMISSIONS[0].name
		permissionWriteGen = 0
		refreshModels(true)
	})
	watch(gworkSignedIn(), (signedIn: boolean): void => {
		if (signedIn) {
			refreshModels(true)
		} else {
			models.value = []
			thinkLevels.value = [autoThinkOption()]
			contextWindows.value = fallbackContextWindows()
			selectedModelId.value = ''
			lastModelFetch = 0
			sessionSelectionCache.clear()
			permission.value = PERMISSIONS[0].name
			permissionWriteGen = 0
		}
	})
	if (gworkSignedIn().value && devices.activeDeviceId.value.length > 0 && models.value.length === 0) {
		refreshModels(true)
	}
}

export function useRunEnv(): RunEnv {
	ensureWatchers()
	const devices = useDevices()
	const spaces = useWorkspaces()

	const device: ComputedRef<string> = devices.deviceName
	const deviceOnline: ComputedRef<boolean> = devices.deviceOnline
	const workspace: ComputedRef<string> = computed<string>((): string => workspaceLabel(spaces.current.value))

	const model: ComputedRef<string> = computed<string>((): string => {
		const found: ModelOption | undefined = modelOptionOf(selectedModelId.value)
		return found != null ? found.name : selectedModelId.value
	})
	const think: ComputedRef<string> = computed<string>((): string => thinkLabel(thinkValue.value))
	const context: ComputedRef<string> = computed<string>((): string => {
		const tokens: number = parseInt(contextValue.value)
		return isNaN(tokens) ? '' : contextLabel(tokens)
	})

	function setDevice(name: string, _online: boolean): void {
		const found: DeviceOption | undefined = devices.devices.value.find((item: DeviceOption): boolean => item.name === name)
		if (found != null) devices.selectDevice(found.deviceId)
	}

	function setWorkspace(name: string): void {
		applyWorkspace(name)
		// 欢迎态换 root 后模型清单/上下文选项按新 root 重拉：
		// 不刷新的话弹层里仍是上一个 root 的缓存，要到发送建会话 bindSession 才校正。
		// 会话态（boundSession 非空）不动——会话归属已锁定，选择器只在欢迎态出现。
		if (boundSession.value.length === 0) {
			sessionGeneration += 1
			refreshModels(true).catch((_err): void => {})
		}
	}

	/** 只落选择不触发刷新：beginNewSession 复位工作区时复用（其自身已管理代次与继承值） */
	function applyWorkspace(name: string): void {
		if (name === DEFAULT_WORKSPACE) {
			spaces.setCurrent(DEFAULT_WORKSPACE)
			boundRoot.value = ''
			return
		}
		const byKey: WorkspaceOption | undefined = spaces.workspaces.value.find((item: WorkspaceOption): boolean => item.root === name)
		if (byKey != null) {
			spaces.setCurrent(byKey.root)
			boundRoot.value = byKey.root
			return
		}
		const byName: WorkspaceOption | undefined = spaces.workspaces.value.find((item: WorkspaceOption): boolean => item.name === name || item.root === name || workspaceLabel(item.root) === name)
		if (byName != null) {
			spaces.setCurrent(byName.root)
			boundRoot.value = byName.root
			return
		}
		// 【不能静默打回全局区】清单尚未加载 / 项目被桌面端移除时，用户点选的工作区
		// 暂时不在 spaces.workspaces 里。旧实现直接 setCurrent(DEFAULT_WORKSPACE)，
		// 表现为「点了工作区没反应，还被切回对话区」。入参本身就是绝对路径 root
		// （run-sheet / 新对话工作区弹层都传 root），信任它并保持选中；
		// 后续清单刷新若确实不存在再由 setProjectRoots 统一回落全局区。
		if (name.length > 0) {
			spaces.setCurrent(name)
			boundRoot.value = name
			return
		}
		spaces.setCurrent(DEFAULT_WORKSPACE)
		boundRoot.value = ''
	}

	/** 切档（协议码）。会话态乐观回显 + 立即 access/select 持久化；提交失败按代次回滚
	 *  本地档位并明确报错——「界面显示 full、内核还是 default」是权限谎报，绝不允许。
	 *  返回 false = 未受理（离线/未登录），调用方不得提示成功。 */
	function setPermission(name: string): boolean {
		const devices = useDevices()
		if (!gworkSignedIn().value || devices.activeDeviceId.value.length === 0) return false
		const prev: string = permission.value
		if (prev === name) return true
		const gen: number = ++permissionWriteGen
		permission.value = name
		writeGeneration += 1
		const cacheKey: string = boundSession.value.length > 0 ? boundSession.value : WELCOME_CACHE_KEY
		const cached: ModelConfig | undefined = sessionSelectionCache.get(cacheKey)
		if (cached != null) {
			sessionSelectionCache.set(cacheKey, { model: cached.model, think: cached.think, context: cached.context, permission: name })
		}
		const rollback = (): void => {
			// 仅当仍是最新一次切档时回滚：晚到的旧失败不能把用户的新选择打回去
			if (permissionWriteGen !== gen) return
			permission.value = prev
			permissionWriteGen = 0
			const cur: ModelConfig | undefined = sessionSelectionCache.get(cacheKey)
			if (cur != null) {
				sessionSelectionCache.set(cacheKey, { model: cur.model, think: cur.think, context: cur.context, permission: prev })
			}
			uni.showToast({ title: t('request.operationFailed'), icon: 'none' })
		}
		const sid: string = boundSession.value
		const cwd: string = boundRoot.value
		if (sid.length === 0) {
			// 欢迎态只做本地乐观值（Java 内核对空 sid 会物化幽灵会话）；
			// 发送建会话时 inheritSelectionToSession 统一落 access/select，
			// 且每条 input 都带 accessMode 字段，权限不会丢。
			welcomeHasLocalSelection = true
			return true
		}
		if (!devices.deviceOnline.value) {
			rollback()
			return false
		}
		// 会话态选中即提交（与三个 select 同口径：同一 sessionId + cwd）。
		// 桌面 app-access-mode.js 同语义：切档立即持久化，下一轮即生效。
		ensureConnected(devices.activeDeviceId.value).then((): Promise<ApiBody> => {
			return request('POST', '/web/chat/access/select', '',
				'sessionId=' + encodeURIComponent(sid) + '&accessMode=' + encodeURIComponent(name),
				cwd, 'application/x-www-form-urlencoded')
		}).then((body: ApiBody): void => {
			if (!kernelOk(body)) {
				rollback()
				return
			}
			if (permissionWriteGen === gen) permissionWriteGen = 0
		}, (): void => {
			rollback()
		})
		return true
	}

	function bindSession(sessionId: string, root?: string): void {
		if (boundSession.value === sessionId && boundRoot.value === (root ?? '')) return
		boundSession.value = sessionId
		boundRoot.value = root ?? ''
		welcomeHasLocalSelection = false
		welcomeConnectorPick = false
		sessionGeneration += 1
		// 【权限 per-session】切会话先恢复该会话缓存档位；无缓存复位 default 等服务端回读。
		// 旧实现全局 permission 不动：A 会话的 full 档会带进 B 会话并随 input 静默升权（P0）。
		const cached: ModelConfig | undefined = sessionSelectionCache.get(sessionId)
		permission.value = cached != null ? cached.permission : PERMISSIONS[0].name
		permissionWriteGen = 0
		refreshModels()
	}

	/** resetWorkspace=true（新建对话）：工作空间复位回全局「对话」区——未选择就是对话，
	 *  选择入口在新对话输入区；侧栏工作区＋的调用方在本函数之后 setWorkspace(root) 覆盖。
	 *  权限档位同步复位 default：新对话绝不继承上一会话的「允许完全访问」（安全档位不扩散）。
	 *  resetWorkspace=false（发送后进入聊天态等）：保留当前选择。 */
	function beginNewSession(resetWorkspace: boolean = false): void {
		inheritedModel = selectedModelId.value
		inheritedThink = thinkValue.value
		inheritedContext = contextValue.value
		if (resetWorkspace) {
			permission.value = PERMISSIONS[0].name
			permissionWriteGen = 0
		}
		// 欢迎态缓存必须跟随当前回显：从会话返回时若仍留着冷启动的全局默认值，
		// 弹层重开的缓存短路会把「保留下来的选择」冲掉。
		sessionSelectionCache.set(WELCOME_CACHE_KEY, {
			model: inheritedModel, think: inheritedThink, context: inheritedContext, permission: permission.value
		})
		if (resetWorkspace) spaces.setCurrent(DEFAULT_WORKSPACE)
		const current: string = spaces.current.value
		boundRoot.value = current === DEFAULT_WORKSPACE ? '' : current
		boundSession.value = ''
		welcomeHasLocalSelection = true
		welcomeConnectorPick = false
		sessionGeneration += 1
	}

	function setModelConfig(nextModel: string, nextThink: string, nextContext: string): void {
		applyModelConfig(nextModel, nextThink, nextContext).catch((_err): void => {
			uni.showToast({ title: t('chat.loadFailed'), icon: 'none' })
		})
	}

	function toggleConnector(id: string, onDone?: (on: boolean) => void): boolean {
		if (!connectorSelectable.value) {
			uni.showToast({ title: t('home.connectors.readonly'), icon: 'none' })
			return false
		}
		// 离线不落乐观态：提交必失败，先禁掉（UI 开关同步 disabled），避免「开了又弹回」
		const devices = useDevices()
		if (!devices.deviceOnline.value || !gworkSignedIn().value) {
			uni.showToast({ title: t('chat.deviceOffline'), icon: 'none' })
			return connectorStates.value[id] ?? false
		}
		const prev: Record<string, boolean> = {}
		Object.keys(connectorStates.value).forEach((key: string): void => {
			prev[key] = connectorStates.value[key]
		})
		lastConnectorPrev = prev
		const next: Record<string, boolean> = {}
		Object.keys(connectorStates.value).forEach((key: string): void => {
			next[key] = connectorStates.value[key]
		})
		next[id] = !(connectorStates.value[id] ?? false)
		connectorStates.value = next
		submitConnectorSelection(onDone, id)
		return next[id]
	}

	return {
		device,
		deviceOnline,
		workspace,
		permission,
		model,
		think,
		context,
		modelValue: selectedModelId,
		thinkValue,
		contextValue,
		selectedSkill,
		attachTag,
		connectorStates,
		skills,
		connectors,
		connectorSelectable,
		refreshSkills,
		refreshConnectors,
		models,
		thinkLevels,
		thinkSelectable,
		contextWindows,
		setDevice,
		setWorkspace,
		setPermission,
		syncOptionsForModel,
		setModelConfig,
		currentConfig,
		bindSession,
		beginNewSession,
		toggleConnector,
		refreshModels
	}
}
