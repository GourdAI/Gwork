/**
 * 运行环境与模型配置的跨页面共享状态。
 *
 * 首页、对话列表、对话详情共用同一份；模块级单例 ref，与 useTheme 同一模式。
 * 设备/工作区已接真实链路：device/deviceOnline 桥接 useDevices、workspace 桥接
 * useWorkspaces（对外签名不变，消费方零改）；模型/思考深度/上下文来自内核
 * GET /web/chat/models（经设备中转），选择经 models/select、thinking/select、
 * context/select 持久化（后两者内核要求非空 sessionId，全局态用哨兵会话承载）。
 */
import { computed, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { i18n } from '@/locale/i18n.ts'
import { fieldString } from '@/utils/tools.ts'
import { gworkSignedIn } from '@/utils/gwork-auth.ts'
import { ensureConnected, request, kernelOk } from '@/utils/gwork-link.ts'
import { useDevices } from '@/hooks/useDevices'
import { useWorkspaces, workspaceLabel } from '@/hooks/useWorkspaces'
import { CONNECTORS, DEFAULT_WORKSPACE, PERMISSIONS } from '@/data/app-data'
import type { ApiBody } from '@/utils/request.ts'
import type { ConnectorOption, DeviceOption, LevelOption, ModelOption, WorkspaceOption } from '@/data/app-data'

export type RunEnv = {
	device: Ref<string>
	deviceOnline: Ref<boolean>
	workspace: Ref<string>
	permission: Ref<string>
	model: Ref<string>
	think: Ref<string>
	context: Ref<string>
	selectedSkill: Ref<string>
	/** composer 顶部的附件 / 技能胶囊文案 */
	attachTag: Ref<string>
	connectorStates: Ref<Record<string, boolean>>
	/** 真实模型清单（app-model-sheet 消费；空=未登录/无设备/未加载） */
	models: Ref<ModelOption[]>
	thinkLevels: Ref<LevelOption[]>
	contextWindows: Ref<LevelOption[]>
	setDevice: (name: string, online: boolean) => void
	setWorkspace: (name: string) => void
	setPermission: (name: string) => void
	setModelConfig: (model: string, think: string, context: string) => void
	toggleConnector: (name: string) => boolean
	refreshModels: () => Promise<void>
}

/** 思考深度/上下文的全局选择载体：内核 select 端点要求非空 sessionId，
 * 用固定哨兵会话承载「全局默认」（models/select 的 sessionId='' 才是真全局，
 * 但 thinking/context 无全局分支，哨兵是内核语义下的最小可行方案） */
const GLOBAL_PREF_SESSION: string = 'work-mobilepref'

/** 思考深度码 → i18n 词条（内核 reasoning.rs 词表：auto/minimal/low/medium/high/xhigh/max） */
const THINK_LABEL_KEYS: Record<string, string> = {
	auto: 'model.think.auto',
	minimal: 'model.think.minimal',
	low: 'model.think.low',
	medium: 'model.think.medium',
	high: 'model.think.high',
	xhigh: 'model.think.xhigh',
	max: 'model.think.max'
}

const permission: Ref<string> = ref<string>(PERMISSIONS[0].name)
const selectedSkill: Ref<string> = ref<string>('')
const attachTag: Ref<string> = ref<string>('')
const connectorStates: Ref<Record<string, boolean>> = ref<Record<string, boolean>>(buildConnectorStates())

const models: Ref<ModelOption[]> = ref<ModelOption[]>([])
const thinkLevels: Ref<LevelOption[]> = ref<LevelOption[]>([])
const contextWindows: Ref<LevelOption[]> = ref<LevelOption[]>([])
/** 内核回显的原始值（selected 是 model 标识；展示用 name） */
const selectedModelId: Ref<string> = ref<string>('')
const thinkValue: Ref<string> = ref<string>('auto')
const contextValue: Ref<string> = ref<string>('')
const modelsLoading: Ref<boolean> = ref<boolean>(false)

let watching: boolean = false

function t(key: string): string {
	return i18n.global.t(key)
}

function buildConnectorStates(): Record<string, boolean> {
	const states: Record<string, boolean> = {}
	CONNECTORS.forEach((item: ConnectorOption): void => {
		states[item.name] = item.enabled
	})
	return states
}

function thinkLabel(value: string): string {
	const key: string | undefined = THINK_LABEL_KEYS[value]
	return key != null ? t(key) : value
}

/** token 数 → 可读窗口（128000→128K、1000000→1M）；内核 contextOptions 为唯一来源 */
function contextLabel(tokens: number): string {
	if (tokens >= 1000000 && tokens % 1000000 === 0) return (tokens / 1000000).toString() + 'M'
	if (tokens >= 1000 && tokens % 1000 === 0) return (tokens / 1000).toString() + 'K'
	return tokens.toString()
}

/** 描述词条与展示词条同前缀成对维护（locale/model.think.*Desc），缺词条时留空不硬编码 */
function thinkDesc(value: string): string {
	const key: string | undefined = THINK_LABEL_KEYS[value]
	return key != null ? t(key + 'Desc') : ''
}

/** 拉取真实模型清单与当前选择（全局态：sessionId='' 由内核回默认模型） */
export async function refreshModels(): Promise<void> {
	const devices = useDevices()
	if (!gworkSignedIn().value || devices.activeDeviceId.value.length === 0 || !devices.deviceOnline.value) {
		models.value = []
		thinkLevels.value = []
		contextWindows.value = []
		return
	}
	if (modelsLoading.value) return
	modelsLoading.value = true
	try {
		await ensureConnected(devices.activeDeviceId.value)
		const body: ApiBody = await request('GET', '/web/chat/models', 'sessionId=&root=')
		if (!kernelOk(body)) return
		const data = body.data != null && typeof body.data === 'object' ? body.data as ApiBody : {}
		const list: ModelOption[] = []
		if (Array.isArray(data.list)) {
			const rows = data.list as ApiBody[]
			for (let i = 0; i < rows.length; i++) {
				const row = rows[i]
				const id = fieldString(row, 'model')
				if (id.length === 0) continue
				const levels: string[] = []
				if (Array.isArray(row.thinkingLevels)) {
					const raw = row.thinkingLevels as string[]
					for (let j = 0; j < raw.length; j++) {
						if (typeof raw[j] === 'string') levels.push(raw[j])
					}
				}
				const name = fieldString(row, 'name')
				list.push({
					model: id,
					name: name.length > 0 ? name : id,
					desc: fieldString(row, 'description'),
					thinkingLevels: levels
				})
			}
		}
		models.value = list
		selectedModelId.value = fieldString(data, 'selected')
		thinkValue.value = fieldString(data, 'thinkingDepth').length > 0 ? fieldString(data, 'thinkingDepth') : 'auto'
		const ctxRaw = data.contextLength
		contextValue.value = typeof ctxRaw === 'number' ? (ctxRaw as number).toString() : fieldString(data, 'contextLength')
		// thinking/context 持久化在哨兵会话（内核 select 端点无全局分支），
		// 全局 GET 只回默认值；再查一次哨兵会话把用户上次的选择读回来。
		// 哨兵不存在时内核回默认值，与首查一致，无副作用。
		try {
			const prefBody: ApiBody = await request('GET', '/web/chat/models', 'sessionId=' + GLOBAL_PREF_SESSION)
			if (kernelOk(prefBody)) {
				const pref = prefBody.data != null && typeof prefBody.data === 'object' ? prefBody.data as ApiBody : {}
				const prefThink = fieldString(pref, 'thinkingDepth')
				if (prefThink.length > 0) thinkValue.value = prefThink
				const prefCtx = pref.contextLength
				if (typeof prefCtx === 'number') contextValue.value = (prefCtx as number).toString()
			}
		} catch (_) {
			// 读哨兵失败不阻塞清单展示，保持全局默认
		}
		// 思考深度选项 = 当前模型的可选码（thinkingLevels），auto 固定置顶
		const selected: ModelOption | undefined = list.find((item: ModelOption): boolean => item.model === selectedModelId.value)
		const codes: string[] = ['auto']
		if (selected != null) {
			selected.thinkingLevels.forEach((code: string): void => {
				if (codes.indexOf(code) < 0) codes.push(code)
			})
		}
		thinkLevels.value = codes.map((code: string): LevelOption => {
			return { name: thinkLabel(code), value: code, desc: thinkDesc(code) }
		})
		// 上下文选项由内核 contextOptions 下发（[128000,256000,512000,1000000]）
		const windows: LevelOption[] = []
		if (Array.isArray(data.contextOptions)) {
			const opts = data.contextOptions as number[]
			for (let i = 0; i < opts.length; i++) {
				const tokens = opts[i]
				if (typeof tokens !== 'number') continue
				windows.push({ name: contextLabel(tokens), value: tokens.toString(), desc: t('model.context.desc') })
			}
		}
		contextWindows.value = windows
	} catch (_) {
		// 拉取失败保持旧清单：模型选择是低频操作，发送链路会另行报错
	} finally {
		modelsLoading.value = false
	}
}

/** 确认选择：models/select 全局（sessionId=''），thinking/context 用哨兵会话持久化。
 * v1 已知限制：哨兵只承载「移动端选择器回显」，真实会话的运行仍取各自 context
 * （内核 input 无 thinking/context 字段），全局生效需内核补全局 select 分支 */
async function applyModelConfig(nextModel: string, nextThink: string, nextContext: string): Promise<void> {
	const devices = useDevices()
	if (!gworkSignedIn().value || devices.activeDeviceId.value.length === 0) return
	await ensureConnected(devices.activeDeviceId.value)
	const target: ModelOption | undefined = models.value.find((item: ModelOption): boolean => item.name === nextModel)
	const modelId: string = target != null ? target.model : nextModel
	const thinkCode: string = findLevelValue(thinkLevels.value, nextThink)
	const contextTokens: string = findLevelValue(contextWindows.value, nextContext)
	if (modelId !== selectedModelId.value) {
		const form: string = 'modelName=' + encodeURIComponent(modelId) + '&sessionId='
		const body: ApiBody = await request('POST', '/web/chat/models/select', '', form, '', 'application/x-www-form-urlencoded')
		if (kernelOk(body)) selectedModelId.value = modelId
	}
	if (thinkCode.length > 0 && thinkCode !== thinkValue.value) {
		const form: string = 'sessionId=' + GLOBAL_PREF_SESSION + '&depth=' + encodeURIComponent(thinkCode)
		const body: ApiBody = await request('POST', '/web/chat/thinking/select', '', form, '', 'application/x-www-form-urlencoded')
		if (kernelOk(body)) thinkValue.value = thinkCode
	}
	if (contextTokens.length > 0 && contextTokens !== contextValue.value) {
		// 内核 ContextForm 绑定字段是 contextLength（length 仅兼容别名）
		const form: string = 'sessionId=' + GLOBAL_PREF_SESSION + '&contextLength=' + encodeURIComponent(contextTokens)
		const body: ApiBody = await request('POST', '/web/chat/context/select', '', form, '', 'application/x-www-form-urlencoded')
		if (kernelOk(body)) contextValue.value = contextTokens
	}
}

function findLevelValue(levels: LevelOption[], name: string): string {
	const found: LevelOption | undefined = levels.find((item: LevelOption): boolean => item.name === name)
	return found != null ? found.value : ''
}

function ensureWatchers(): void {
	if (watching) return
	watching = true
	const devices = useDevices()
	watch(devices.activeDeviceId, (): void => {
		models.value = []
		thinkLevels.value = []
		contextWindows.value = []
		selectedModelId.value = ''
		refreshModels()
	})
	watch(gworkSignedIn(), (signedIn: boolean): void => {
		if (signedIn) {
			refreshModels()
		} else {
			models.value = []
			thinkLevels.value = []
			contextWindows.value = []
			selectedModelId.value = ''
		}
	})
	// 冷启动：登录态/设备 id 在首个 hook 调用前已恢复（watch 追不上），补一次拉取
	if (gworkSignedIn().value && devices.activeDeviceId.value.length > 0 && models.value.length === 0) {
		refreshModels()
	}
}

export function useRunEnv(): RunEnv {
	ensureWatchers()
	const devices = useDevices()
	const spaces = useWorkspaces()

	// 设备名/在线态单一来源 useDevices；对外仍是 Ref 形状（computed 只读，
	// 消费方只展示不写；写入统一走 setDevice → selectDevice）
	const device: Ref<string> = devices.deviceName as Ref<string>
	const deviceOnline: Ref<boolean> = devices.deviceOnline as Ref<boolean>
	// workspace 对外展示名（i18n/basename），键值转换收在 setWorkspace
	const workspace: Ref<string> = computed<string>((): string => workspaceLabel(spaces.current.value)) as Ref<string>

	const model: Ref<string> = computed<string>((): string => {
		const found: ModelOption | undefined = models.value.find((item: ModelOption): boolean => item.model === selectedModelId.value)
		return found != null ? found.name : ''
	}) as Ref<string>
	const think: Ref<string> = computed<string>((): string => thinkLabel(thinkValue.value)) as Ref<string>
	const context: Ref<string> = computed<string>((): string => {
		const tokens: number = parseInt(contextValue.value)
		return isNaN(tokens) ? '' : contextLabel(tokens)
	}) as Ref<string>

	function setDevice(name: string, _online: boolean): void {
		const found: DeviceOption | undefined = devices.devices.value.find((item: DeviceOption): boolean => item.name === name)
		if (found != null) devices.selectDevice(found.deviceId)
	}

	function setWorkspace(name: string): void {
		// 消费方传的是展示名；先按键匹配（drawer 传 root 键），再按展示名回落
		if (name === DEFAULT_WORKSPACE) {
			spaces.setCurrent(DEFAULT_WORKSPACE)
			return
		}
		const byKey: WorkspaceOption | undefined = spaces.workspaces.value.find((item: WorkspaceOption): boolean => item.root === name)
		if (byKey != null) {
			spaces.setCurrent(byKey.root)
			return
		}
		const byName: WorkspaceOption | undefined = spaces.workspaces.value.find((item: WorkspaceOption): boolean => item.name === name || workspaceLabel(item.root.length === 0 ? DEFAULT_WORKSPACE : item.root) === name)
		spaces.setCurrent(byName != null ? (byName.root.length === 0 ? DEFAULT_WORKSPACE : byName.root) : DEFAULT_WORKSPACE)
	}

	function setPermission(name: string): void {
		permission.value = name
	}

	function setModelConfig(nextModel: string, nextThink: string, nextContext: string): void {
		applyModelConfig(nextModel, nextThink, nextContext).catch((_err): void => {
			uni.showToast({ title: t('chat.loadFailed'), icon: 'none' })
		})
	}

	/** 返回切换后的状态，供页面弹 toast */
	function toggleConnector(name: string): boolean {
		const next: Record<string, boolean> = {}
		Object.keys(connectorStates.value).forEach((key: string): void => {
			next[key] = connectorStates.value[key]
		})
		next[name] = !(connectorStates.value[name] ?? false)
		connectorStates.value = next
		return next[name]
	}

	return {
		device,
		deviceOnline,
		workspace,
		permission,
		model,
		think,
		context,
		selectedSkill,
		attachTag,
		connectorStates,
		models,
		thinkLevels,
		contextWindows,
		setDevice,
		setWorkspace,
		setPermission,
		setModelConfig,
		toggleConnector,
		refreshModels
	}
}
