/**
 * 附件选择 → 内联 base64（mobile-link v1.1，PROTOCOL.md §4）。
 *
 * 链路信封 body 是字符串，multipart 上不了桥：拍照/照片/文件一律读成
 * base64 内联进 /web/chat/input 的 attachments 字段，由内核走与桌面
 * multipart 完全相同的 save_attachment 落盘 + 注入链路。
 *
 * 限额与双内核 decode_inline_attachments / JsonInputBody 完全一致：
 * ≤10 条、单条解码后 ≤4MB、合计 ≤9MB；超限在发送前明确拒绝，绝不静默丢。
 * 图片先 compressImage（质量 80，产物是 JPEG：文件名同步改 .jpg，名实相符）；
 * HEIC/HEIF 压缩失败直接拒绝（Android compressImage 不支持，原图直传模型解不了）。
 *
 * 【并发互斥】选择→压缩→读 base64 是长异步窗口：期间再开面板选第二批，
 * 两批各自按旧快照过限额后无条件 concat 会绕过 ≤10条/≤9MB，最大 18MB 解码
 * 超 admin 16MiB 帧限直接踢断 WS。picking 标志互斥 + 回填时按当前值重校验。
 */
import { i18n } from '@/locale/i18n.ts'
import type { PendingAttachment } from '@/data/app-data'

export const ATTACH_MAX_COUNT: number = 10
export const ATTACH_MAX_ITEM_BYTES: number = 4 * 1024 * 1024
export const ATTACH_MAX_TOTAL_BYTES: number = 9 * 1024 * 1024

/** 选择器在途互斥：一次只允许一个选择/压缩/读取流程 */
let picking: boolean = false

function t(key: string): string {
	return i18n.global.t(key)
}

function toast(title: string): void {
	uni.showToast({ title: title, icon: 'none' })
}

/** base64 解码后字节数（去 padding 精确折算） */
function base64Bytes(b64: string): number {
	let pad = 0
	if (b64.endsWith('==')) pad = 2
	else if (b64.endsWith('=')) pad = 1
	return Math.floor(b64.length * 3 / 4) - pad
}

/** 路径尾段作文件名；无名兜底 attachment-<ts> */
function nameOf(path: string, fallbackExt: string): string {
	const norm: string = path.replace(/\\/g, '/')
	const idx: number = norm.lastIndexOf('/')
	const tail: string = idx >= 0 ? norm.substring(idx + 1) : norm
	if (tail.length > 0 && tail.indexOf('.') > 0) return tail
	return 'attachment-' + Date.now().toString() + fallbackExt
}

/** 压缩产物是 JPEG：无论原扩展名是什么，文件名一律收敛 .jpg（名实相符，
 *  否则 photo.png 里装 JPEG 字节，内核/模型按扩展名判型会出错） */
function jpegName(path: string): string {
	const raw: string = nameOf(path, '.jpg')
	const dot: number = raw.lastIndexOf('.')
	return (dot > 0 ? raw.substring(0, dot) : raw) + '.jpg'
}

const IMAGE_EXT: string[] = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif']

function isImagePath(path: string): boolean {
	const lower: string = path.toLowerCase()
	for (let i = 0; i < IMAGE_EXT.length; i++) {
		if (lower.endsWith(IMAGE_EXT[i])) return true
	}
	return false
}

function isHeicPath(path: string): boolean {
	const lower: string = path.toLowerCase()
	return lower.endsWith('.heic') || lower.endsWith('.heif')
}

/** 读文件为 base64（uni-app x 全端 FileSystemManager 口径） */
function readBase64(path: string): Promise<string> {
	return new Promise<string>((resolve, reject): void => {
		try {
			const fs = uni.getFileSystemManager()
			fs.readFile({
				filePath: path,
				encoding: 'base64',
				success: (res): void => {
					const data: any = res.data
					resolve(typeof data === 'string' ? data : '')
				},
				fail: (err): void => { reject(new Error(err.errMsg)) }
			})
		} catch (e) {
			reject(e instanceof Error ? e : new Error('readFile unavailable'))
		}
	})
}

/** 图片压缩。返回 null = 压缩失败：普通格式回退原图（压缩只是优化）；
 *  HEIC/HEIF 由调用方拒绝（原图直传内核与模型都解不了，不能静默放行）。 */
function compress(path: string): Promise<string | null> {
	return new Promise<string | null>((resolve): void => {
		try {
			uni.compressImage({
				src: path,
				quality: 80,
				success: (res): void => { resolve(res.tempFilePath.length > 0 ? res.tempFilePath : null) },
				fail: (): void => { resolve(null) }
			})
		} catch (_) {
			resolve(null)
		}
	})
}

/** 校验并收编一条附件；超限 toast + 返回 null（调用方跳过该条）。
 *  existing 必须传「回填时刻的当前已选」而不是选择开始时的快照。 */
async function collect(path: string, declared: string, existing: PendingAttachment[]): Promise<PendingAttachment | null> {
	if (existing.length >= ATTACH_MAX_COUNT) {
		toast(t('home.plus.tooMany'))
		return null
	}
	const isImage: boolean = declared === 'image' || isImagePath(path)
	let finalPath: string = path
	let compressed: boolean = false
	if (isImage) {
		const out: string | null = await compress(path)
		if (out != null) {
			finalPath = out
			compressed = true
		} else if (isHeicPath(path)) {
			// HEIC 压缩失败 = 设备不支持转码：原图直传模型解不了，明确拒绝
			toast(t('home.plus.heicUnsupported'))
			return null
		}
	}
	const b64: string = await readBase64(finalPath)
	if (b64.length === 0) {
		toast(t('home.plus.readFailed'))
		return null
	}
	const bytes: number = base64Bytes(b64)
	if (bytes > ATTACH_MAX_ITEM_BYTES) {
		toast(t('home.plus.tooBig'))
		return null
	}
	let total: number = bytes
	existing.forEach((a: PendingAttachment): void => { total += a.bytes })
	if (total > ATTACH_MAX_TOTAL_BYTES) {
		toast(t('home.plus.totalTooBig'))
		return null
	}
	return {
		name: isImage ? (compressed ? jpegName(path) : nameOf(path, '.jpg')) : nameOf(path, ''),
		type: isImage ? 'image' : 'file',
		dataBase64: b64,
		bytes: bytes,
		// 乐观内联 dataUrl 的 MIME 子类型：压缩输出恒 jpeg；未压缩按扩展名推
		mime: isImage ? 'jpeg' : ''
	}
}

/** 选择入口公共守卫：满额预检（camera 白拍一张才拒绝的体验问题）+ 并发互斥。
 *  返回 false 时调用方直接结束；true 时流程结束必须调 releasePicker()。 */
function beginPick(existing: PendingAttachment[]): boolean {
	if (picking) return false
	if (existing.length >= ATTACH_MAX_COUNT) {
		toast(t('home.plus.tooMany'))
		return false
	}
	picking = true
	return true
}

function releasePicker(): void {
	picking = false
}

/** 拍照：拍一张 → 压缩 → base64。用户取消静默返回；权限被拒明确提示。 */
export function pickCamera(existing: PendingAttachment[]): Promise<PendingAttachment | null> {
	return new Promise<PendingAttachment | null>((resolve): void => {
		if (!beginPick(existing)) { resolve(null); return }
		try {
			uni.chooseImage({
				count: 1,
				sourceType: ['camera'],
				success: (res): void => {
					const paths: string[] = res.tempFilePaths
					if (paths.length === 0) { releasePicker(); resolve(null); return }
					collect(paths[0], 'image', existing).then((item: PendingAttachment | null): void => {
						releasePicker()
						resolve(item)
					}, (): void => {
						releasePicker()
						toast(t('home.plus.readFailed'))
						resolve(null)
					})
				},
				fail: (err): void => {
					releasePicker()
					// 用户主动取消静默；权限被拒/相机不可用必须让用户知道为什么没反应
					const msg: string = err.errMsg.toLowerCase()
					if (msg.indexOf('cancel') < 0) toast(t('home.msg.permDenied'))
					resolve(null)
				}
			})
		} catch (_) {
			releasePicker()
			toast(t('home.plus.readFailed'))
			resolve(null)
		}
	})
}

/** 照片·视频：相册多选（仅图片；视频内核不支持内联，选择器直接不给选）。 */
export function pickAlbum(existing: PendingAttachment[]): Promise<PendingAttachment[]> {
	return new Promise<PendingAttachment[]>((resolve): void => {
		if (!beginPick(existing)) { resolve([]); return }
		const room: number = ATTACH_MAX_COUNT - existing.length
		try {
			uni.chooseImage({
				count: Math.min(room, 9),
				sourceType: ['album'],
				success: (res): void => {
					const paths: string[] = res.tempFilePaths
					const out: PendingAttachment[] = []
					const step = (i: number): void => {
						if (i >= paths.length) { releasePicker(); resolve(out); return }
						// 逐条按「当前已选 + 本批已收」重校验，批内超限即停
						collect(paths[i], 'image', existing.concat(out)).then((item: PendingAttachment | null): void => {
							if (item != null) out.push(item)
							step(i + 1)
						}, (): void => { step(i + 1) })
					}
					step(0)
				},
				fail: (err): void => {
					releasePicker()
					const msg: string = err.errMsg.toLowerCase()
					if (msg.indexOf('cancel') < 0) toast(t('home.msg.permDenied'))
					resolve([])
				}
			})
		} catch (_) {
			releasePicker()
			toast(t('home.plus.readFailed'))
			resolve([])
		}
	})
}

/** 添加文件：系统文件选择器（uni.chooseFile；不支持的平台明确报错，不静默）。 */
export function pickFile(existing: PendingAttachment[]): Promise<PendingAttachment[]> {
	return new Promise<PendingAttachment[]>((resolve): void => {
		if (!beginPick(existing)) { resolve([]); return }
		const room: number = ATTACH_MAX_COUNT - existing.length
		try {
			uni.chooseFile({
				count: Math.min(room, 9),
				type: 'all',
				success: (res): void => {
					const files: any[] = res.tempFiles as any[]
					const out: PendingAttachment[] = []
					const step = (i: number): void => {
						if (i >= files.length) { releasePicker(); resolve(out); return }
						const f: any = files[i]
						const path: string = typeof f.path === 'string' ? f.path as string : ''
						if (path.length === 0) { step(i + 1); return }
						collect(path, 'file', existing.concat(out)).then((item: PendingAttachment | null): void => {
							if (item != null) {
								// 文件选择器带原始文件名，优先于路径尾段（content:// 等无名 URI）
								if (typeof f.name === 'string' && (f.name as string).length > 0) item.name = f.name as string
								out.push(item)
							}
							step(i + 1)
						}, (): void => { step(i + 1) })
					}
					step(0)
				},
				fail: (err): void => {
					releasePicker()
					const msg: string = err.errMsg.toLowerCase()
					if (msg.indexOf('cancel') < 0) toast(t('home.plus.readFailed'))
					resolve([])
				}
			})
		} catch (_) {
			releasePicker()
			toast(t('home.plus.unsupported'))
			resolve([])
		}
	})
}

/** 回填收编：按「回填时刻的当前已选」重校验数量与体积预算，超出部分明确拒绝。
 *  页面必须经此入口合并选择结果，不得直接 concat（并发窗口绕过限额的兜底闸）。 */
export function mergeAttachments(current: PendingAttachment[], picked: PendingAttachment[]): PendingAttachment[] {
	const out: PendingAttachment[] = current.slice(0)
	let total: number = 0
	out.forEach((a: PendingAttachment): void => { total += a.bytes })
	let rejected: boolean = false
	picked.forEach((a: PendingAttachment): void => {
		if (out.length >= ATTACH_MAX_COUNT || total + a.bytes > ATTACH_MAX_TOTAL_BYTES) {
			rejected = true
			return
		}
		out.push(a)
		total += a.bytes
	})
	if (rejected) toast(t('home.plus.totalTooBig'))
	return out
}