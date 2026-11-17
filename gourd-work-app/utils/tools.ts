import { i18n } from '@/locale/i18n.ts'
import type { ApiBody, ApiError } from '@/utils/request.ts'

/** 统一的 toast 入口：图标固定为 none，原生 error 图标会截断长文案 */
export function showToast(title: string): void {
	uni.showToast({ title, icon: 'none' })
}

/** 把任意 catch 到的错误转成可展示的一句话，页面弹窗或显示都用它 */
export function errorToMessage(err: ApiError | Error | null): string {
	if (err instanceof Error) return err.message
	return i18n.global.t('request.operationFailed')
}

/** 安全取字段为字符串：字符串、数字、布尔都能转；字段不存在返回空串，避免后端字段类型不稳导致报错 */
export function fieldString(row: ApiBody, key: string): string {
	const v = row[key]
	if (typeof v === 'string') return v
	if (typeof v === 'number' || typeof v === 'boolean') return v.toString()
	return ''
}

/** 会话列表的相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 */
export function formatRelativeTime(ts: number): string {
	const diff: number = Date.now() - ts
	const minutes: number = Math.floor(diff / 60000)
	if (minutes < 1) return i18n.global.t('conv.time.now')
	if (minutes < 60) return i18n.global.t('conv.time.minutesAgo', { n: minutes.toString() })
	const hours: number = Math.floor(minutes / 60)
	if (hours < 24) return i18n.global.t('conv.time.hoursAgo', { n: hours.toString() })
	const days: number = Math.floor(hours / 24)
	return i18n.global.t('conv.time.daysAgo', { n: days.toString() })
}
