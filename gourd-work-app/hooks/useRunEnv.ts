/**
 * 运行环境与模型配置的跨页面共享状态。
 *
 * 首页、对话列表、对话详情共用同一份；模块级单例 ref，
 * 与 useTheme 同一模式，无需 provide / inject。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import { CONNECTORS, DEVICES, MODELS, PERMISSIONS, THINK_LEVELS, CONTEXT_WINDOWS, WORKSPACES } from '@/data/app-data'
import type { ConnectorOption } from '@/data/app-data'

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
	setDevice: (name: string, online: boolean) => void
	setWorkspace: (name: string) => void
	setPermission: (name: string) => void
	setModelConfig: (model: string, think: string, context: string) => void
	toggleConnector: (name: string) => boolean
}

const device: Ref<string> = ref<string>(DEVICES[0].name)
const deviceOnline: Ref<boolean> = ref<boolean>(DEVICES[0].online)
const workspace: Ref<string> = ref<string>(WORKSPACES[0].name)
const permission: Ref<string> = ref<string>(PERMISSIONS[1].name)
const model: Ref<string> = ref<string>(MODELS[0].name)
const think: Ref<string> = ref<string>(THINK_LEVELS[2].name)
const context: Ref<string> = ref<string>(CONTEXT_WINDOWS[2].name)
const selectedSkill: Ref<string> = ref<string>('')
const attachTag: Ref<string> = ref<string>('')
const connectorStates: Ref<Record<string, boolean>> = ref<Record<string, boolean>>(buildConnectorStates())

function buildConnectorStates(): Record<string, boolean> {
	const states: Record<string, boolean> = {}
	CONNECTORS.forEach((item: ConnectorOption): void => {
		states[item.name] = item.enabled
	})
	return states
}

function setDevice(name: string, online: boolean): void {
	device.value = name
	deviceOnline.value = online
}

function setWorkspace(name: string): void {
	workspace.value = name
}

function setPermission(name: string): void {
	permission.value = name
}

function setModelConfig(nextModel: string, nextThink: string, nextContext: string): void {
	model.value = nextModel
	think.value = nextThink
	context.value = nextContext
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

export function useRunEnv(): RunEnv {
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
		setDevice,
		setWorkspace,
		setPermission,
		setModelConfig,
		toggleConnector
	}
}
