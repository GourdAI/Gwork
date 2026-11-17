/**
 * 语音识别（ASR）预留接口：录音文件 → 转写文本。
 * 后端识别服务就绪后，只在此文件接入（上传 filePath，走 utils 下的 request 实例），
 * app-composer 等业务层不需要再改动。
 */

import { i18n } from '@/locale/i18n.ts'

/**
 * 识别一段录音。resolve 转写文本（可能为空串），reject 表示识别失败。
 * 当前为演示占位：返回固定演示文本，保证「按住说话 → 松开发送」链路可跑通。
 */
export function recognizeSpeech(filePath: string, durationMs: number): Promise<string> {
	// TODO: 接入后端 ASR 接口后替换本实现；filePath 与 durationMs 即上传所需全部信息
	return new Promise<string>((resolve: (text: string) => void) => {
		resolve(i18n.global.t('home.voice.mockText'))
	})
}
