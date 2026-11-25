/**
 * 助手身份（名称 + 头像）的跨页面共享状态。
 *
 * 对齐桌面端 app-message.js:600-660：
 * - 名称默认 GWork，可在桌面「设置 → 通用 → 助手名称」自定义（general.assistantName）；
 * - 桌面把名称缓存在 localStorage，渲染时只读缓存；启动期从 /web/settings/general
 *   拉一次回填。移动端同样只读缓存 + 启动期拉取一次，避免每条消息各打一次接口；
 * - 头像固定为产品 logo（亮色 /static/logo.png、暗色 /static/logo-inverse.png），
 *   与首页 hero 同源，不随后端设置变化。
 *
 * 移动端不提供改名入口（设置页在桌面端），但必须能读到桌面改过的名字，
 * 否则同一账号在两端显示不同助手名。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import { ensureConnected, request, kernelOk } from '@/utils/gwork-link.ts'
import { useDevices } from '@/hooks/useDevices'
import { fieldString } from '@/utils/tools.ts'
import type { ApiBody } from '@/utils/request.ts'

/** 与桌面 ASSISTANT_NAME_DEFAULT 同口径 */
const DEFAULT_ASSISTANT_NAME: string = 'GWork'
/** 与桌面 ASSISTANT_NAME_KEY 同口径（本地缓存键，仅本端读取） */
const STORAGE_KEY: string = 'gwork_assistant_name'

const assistantName: Ref<string> = ref<string>(readCachedName())
let fetching: boolean = false

function readCachedName(): string {
	try {
		const raw = uni.getStorageSync(STORAGE_KEY) as string
		if (raw != null && raw.length > 0) return raw
	} catch (_) {
		// 隐私模式 / 存储异常：回落默认名
	}
	return DEFAULT_ASSISTANT_NAME
}

function writeCachedName(name: string): void {
	try {
		if (name.length === 0) uni.removeStorageSync(STORAGE_KEY)
		else uni.setStorageSync(STORAGE_KEY, name)
	} catch (_) {
		// 写入失败不阻塞展示，下次拉取会再试
	}
}

/**
 * 从内核拉一次助手名称（/web/settings/general → data.assistantName）。
 * 失败/未连接/设备离线都静默保持当前值：身份头不能因为一次设置读取失败而消失。
 */
export async function refreshAssistantIdentity(): Promise<void> {
	if (fetching) return
	const devices = useDevices()
	if (devices.activeDeviceId.value.length === 0) return
	fetching = true
	try {
		await ensureConnected(devices.activeDeviceId.value)
		const body: ApiBody = await request('GET', '/web/settings/general', '', '', '')
		if (!kernelOk(body)) return
		const data = body.data != null && typeof body.data === 'object' ? body.data as ApiBody : {}
		const name: string = fieldString(data, 'assistantName').trim()
		const next: string = name.length > 0 ? name : DEFAULT_ASSISTANT_NAME
		writeCachedName(name)
		if (assistantName.value !== next) assistantName.value = next
	} catch (_) {
		// 静默：保持缓存值
	} finally {
		fetching = false
	}
}

export function useAssistantIdentity(): { assistantName: Ref<string> } {
	return { assistantName }
}
