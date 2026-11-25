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

/** 耗时文案（1.2s / 340ms）：收口后的整批耗时与运行批次的每秒 tick 共用同一口径。
 *  放 utils 层以避开 hooks ↔ components 的循环依赖；now 由 UI 层传响应式 tick，
 *  既建立重渲染依赖，又保证同一帧内多处耗时一致。 */
export function formatElapsed(startedAt: number, now?: number): string {
	const end: number = now ?? Date.now()
	const ms: number = Math.max(0, end - startedAt)
	return ms >= 1000 ? (Math.round(ms / 100) / 10).toString() + 's' : Math.round(ms).toString() + 'ms'
}

/** 批次/整轮耗时（PC app-turn-display.js formatBatchElapsed 同口径）：
 *  <1s / Ns / Nmin Ns / Nh Nmin。与 formatElapsed（1.2s/340ms，单工具行用）区分：
 *  批次盖子与 Compact 摘要走整秒进位，不显示亚秒小数。 */
export function formatBatchElapsed(startedAt: number, now?: number): string {
	const end: number = now ?? Date.now()
	const sec: number = Math.max(0, Math.floor((end - startedAt) / 1000))
	if (sec < 1) return '<1s'
	if (sec < 60) return sec.toString() + 's'
	const min: number = Math.floor(sec / 60)
	const rs: number = sec % 60
	if (min < 60) return rs > 0 ? min.toString() + 'min ' + rs.toString() + 's' : min.toString() + 'min'
	const h: number = Math.floor(min / 60)
	const rm: number = min % 60
	return rm > 0 ? h.toString() + 'h ' + rm.toString() + 'min' : h.toString() + 'h'
}

/** 消息时间戳（PC app-base.js formatMsgTime 同口径）：当天 HH:mm，跨天 yyyy-MM-dd HH:mm */
export function formatMsgTime(ts: number): string {
	const d = new Date(ts)
	const now = new Date()
	const pad = (n: number): string => n < 10 ? '0' + n.toString() : n.toString()
	const hm: string = pad(d.getHours()) + ':' + pad(d.getMinutes())
	const sameDay: boolean = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
	if (sameDay) return hm
	return d.getFullYear().toString() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm
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
