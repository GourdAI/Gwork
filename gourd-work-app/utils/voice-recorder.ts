/**
 * 录音能力封装：uni.getRecorderManager 仅 APP 端可用（app-android HBuilderX 4.13+），
 * 其余端在 isVoiceRecordSupported() 拦截，由调用方提示不支持。
 * Android 的 RECORD_AUDIO 运行时权限由框架在 start 时拉起系统授权弹窗；
 * 拒绝授权走 onError 路径，stopVoiceRecord 以 null 落地。
 */

import { i18n } from '@/locale/i18n.ts'

export type VoiceRecordResult = {
	tempFilePath: string
	/** 录音时长（毫秒），取自本地计时，兜底 onStop 未回传时长的端差异 */
	duration: number
}

type RecordFinishHandler = (result: VoiceRecordResult | null) => void

// RecorderManager 是全局单例；composer 在首页与聊天态各挂一份，底层实例与回调只保留一份
let manager: RecorderManager | null = null
let finishHandler: RecordFinishHandler | null = null
let startedAt = 0
// 录音是否真正进行中：start 到 onStop/onError 之间才为 true。
// 没有它，录音未启动（首次授权弹窗、快速点放）时调 stop 会等一个永不到来的 onStop，Promise 永挂
let recording = false

/** stop 后等待 onStop 的超时：超时按失败落地，绝不悬挂调用方 */
const STOP_TIMEOUT_MS = 3000

function ensureManager(): RecorderManager | null {
	// #ifdef APP
	if (manager == null) {
		manager = uni.getRecorderManager()
		manager.onStop((res) => {
			const duration: number = startedAt > 0 ? Date.now() - startedAt : 0
			startedAt = 0
			recording = false
			// 个别端 onStop 可能不回传 tempFilePath，兜底空串交由识别层报错
			const path: string = res.tempFilePath != null ? res.tempFilePath : ''
			const handler = finishHandler
			finishHandler = null
			if (handler != null) handler({ tempFilePath: path, duration: duration })
		})
		manager.onError((_err) => {
			startedAt = 0
			recording = false
			const handler = finishHandler
			finishHandler = null
			if (handler != null) handler(null)
		})
	}
	return manager
	// #endif
	// #ifndef APP
	return null
	// #endif
}

/** 当前端是否支持录音（Web / 小程序端不支持） */
export function isVoiceRecordSupported(): boolean {
	// #ifdef APP
	return true
	// #endif
	// #ifndef APP
	return false
	// #endif
}

/**
 * 开始录音。最长 maxDurationMs 毫秒后自动停止（走 onStop 正常落地）。
 * 返回 false 表示当前端不支持。
 */
export function startVoiceRecord(maxDurationMs: number): boolean {
	const m = ensureManager()
	if (m == null) return false
	startedAt = Date.now()
	recording = true
	m.start({ duration: maxDurationMs })
	return true
}

/** 停止录音并等待结果；取消场景由调用方按手势状态丢弃结果 */
export function stopVoiceRecord(): Promise<VoiceRecordResult | null> {
	const m = ensureManager()
	// 未在录（含 start 尚未生效）：直接按失败落地，不调 stop、不挂起
	if (m == null || !recording) return Promise.resolve<VoiceRecordResult | null>(null)
	return new Promise<VoiceRecordResult | null>((resolve: (res: VoiceRecordResult | null) => void) => {
		let stopTimer: number = 0
		finishHandler = (result: VoiceRecordResult | null): void => {
			if (stopTimer != 0) {
				clearTimeout(stopTimer)
				stopTimer = 0
			}
			resolve(result)
		}
		stopTimer = setTimeout((): void => {
			finishHandler = null
			resolve(null)
		}, STOP_TIMEOUT_MS)
		m.stop()
	})
}

/** 拿不到录音结果时的统一文案（含用户拒绝麦克风授权） */
export function voiceRecordErrorText(): string {
	return i18n.global.t('home.voice.recordError')
}
