/**
 * 会话产物流（对话「全部产物」弹层的数据源）。
 *
 * 数据源与桌面端**完全同源**：内核 `GET /web/chat/changes/session`——跨该会话
 * 全部 run 合并出的「至今改过哪些文件」清单（桌面 app-task-monitor.js 的
 * 「产出」区就是它）。移动端经设备中转 WS 打到 PC 内核同一个端点，因此手机上
 * 看到的产物与 PC 任务监控里的产出是同一份账本，不再有第二套口径。
 *
 * 为什么不用 `/web/chat/changes/run`：那个只能按 runId 查单轮，而弹层入口是
 * 「当前对话」，用户想知道的是这个对话一共产出了哪些文件。逐 run 枚举会
 * 重复请求、且顺序/合并口径要客户端自己重做（内核已按「最新 run 覆盖状态字段、
 * runIds 累加」的规则合并好，与 Java 内核 listSessionLocked 一致）。
 *
 * 三条硬纪律：
 * 1. 【失败不得伪造成空】设备离线 / 链路错误 / 内核返回非 200 一律落到 error 态，
 *    由 UI 明确提示并可重试。绝不把「拉取失败」渲染成「暂无产物」——那会让
 *    用户以为任务真的没产出。
 * 2. 【权限边界】移动端只读：绝不调用 changes/undo/*、changes/reapply/*、
 *    filer/write。中转白名单只放行 changes/session + filer/read——filer/raw 虽也
 *    只读，但它是字节流端点（过不了 JSON 字符串信封）且上限 50MB，前端不用就不
 *    放行（最小权限）。
 * 3. 【root 透传】产物 path 是**会话工作区根**的相对路径，预览时必须把会话自己的
 *    root 经 **query 参数** 显式透传（桌面 app-task-monitor.js 的 root 透传纪律同款），
 *    否则多工作区场景下会读到错误的文件。设备侧另有一道 ROOT_SCOPED_PATHS 闸门，
 *    只允许空 root（内核 workspace）或 projects.json 里注册过的项目根。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import { i18n } from '@/locale/i18n.ts'
import { ensureConnected, request, kernelOk } from '@/utils/gwork-link.ts'
import { useDevices } from '@/hooks/useDevices'
import { fieldString } from '@/utils/tools.ts'
import type { ApiBody } from '@/utils/request.ts'
import type { ArtifactFile, Conversation } from '@/data/app-data'
import { DEFAULT_WORKSPACE } from '@/data/app-data'

/** 扩展名 → 是否按图片处理（只影响卡片图标；图片不做内联预览，见弹层 openDetail） */
const IMAGE_EXTS: string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']

/** 产物清单加载态：idle 未拉取 / loading / ready 有结果 / error 失败可重试 */
export type ArtifactPhase = 'idle' | 'loading' | 'ready' | 'error'

export type ArtifactsState = {
	files: Ref<ArtifactFile[]>
	phase: Ref<ArtifactPhase>
	/** error 态的展示文案（空串=无错误） */
	error: Ref<string>
	/** 内核统计：本会话累计增删行数（弹层副标题用） */
	additions: Ref<number>
	deletions: Ref<number>
	/** 拉取指定会话的产物；force=false 时已有结果直接复用（弹层重复打开零网络） */
	load: (conv: Conversation | null, force?: boolean) => Promise<void>
	/** 清空（切换会话/登出时调用，避免上一条会话的产物冒充当前会话） */
	reset: () => void
	/** 标脏：保留已展示的清单，但让下一次 load() 必须重新拉取。
	 *  用于「本轮任务刚跑完」——账本已经变了，缓存不能继续冒充最新结果。 */
	invalidate: () => void
}

/** 取 path 的 basename；同时容忍 / 与 \ 两种分隔符（PC 端内核可能回 Windows 路径） */
export function baseNameOf(path: string): string {
	const cut: number = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
	return cut >= 0 ? path.substring(cut + 1) : path
}

/** 取扩展名（小写，不含点）；无扩展名返回空串 */
export function extOf(path: string): string {
	const name: string = baseNameOf(path)
	const dot: number = name.lastIndexOf('.')
	if (dot <= 0 || dot === name.length - 1) return ''
	return name.substring(dot + 1).toLowerCase()
}

/** 逐字段判型的数字读取（内核可能给 null / 字符串 / 负数） */
function numOf(row: ApiBody, key: string): number {
	const v = row[key]
	if (typeof v === 'number') return Math.max(0, Math.round(v as number))
	if (typeof v === 'string') {
		const n: number = parseInt(v as string)
		return isNaN(n) ? 0 : Math.max(0, n)
	}
	return 0
}

/** 内核 changeType（ADDED/MODIFIED/DELETED）→ A/M/D 徽标；未知值按 M 处理。
 *  与 useConversations.changeKind 同口径（消息内文件变更卡用的就是它）。 */
export function kindOf(raw: string): string {
	const type: string = raw.toUpperCase()
	if (type === 'ADDED') return 'A'
	if (type === 'DELETED') return 'D'
	return 'M'
}

/**
 * 解析内核 `data.files[]` → 弹层展示行。**纯函数**（不依赖模块状态/网络），
 * verify-mobile-fixes 直接抽取执行做字段判型与坏帧降级验证。
 *
 * 降级纪律：files 缺失/非数组 → 空数组；单行 path 为空 → 跳过该行（无路径
 * 无法预览也无法定位，留着只会是坏卡片）。任何字段类型异常都不抛异常。
 */
export function parseArtifacts(data: ApiBody | null): ArtifactFile[] {
	if (data == null) return []
	const raw = data['files']
	if (!Array.isArray(raw)) return []
	const rows = raw as ApiBody[]
	const out: ArtifactFile[] = []
	for (let i = 0; i < rows.length; i++) {
		const row: ApiBody = rows[i]
		if (row == null || typeof row !== 'object') continue
		const path: string = fieldString(row, 'path')
		if (path.length === 0) continue
		const ext: string = extOf(path)
		out.push({
			path: path,
			name: baseNameOf(path),
			ext: ext.toUpperCase(),
			kind: kindOf(fieldString(row, 'changeType')),
			additions: numOf(row, 'additions'),
			deletions: numOf(row, 'deletions'),
			binary: row['binary'] === true,
			image: IMAGE_EXTS.indexOf(ext) >= 0
		} as ArtifactFile)
	}
	return out
}

const files: Ref<ArtifactFile[]> = ref<ArtifactFile[]>([])
const phase: Ref<ArtifactPhase> = ref<ArtifactPhase>('idle')
const error: Ref<string> = ref<string>('')
const additions: Ref<number> = ref<number>(0)
const deletions: Ref<number> = ref<number>(0)

/** 当前结果归属的会话 id：切换会话必须失效，绝不能把上一条会话的产物当成新的 */
let boundSessionId: string = ''
/** 在途请求代次：连点/快速切会话时，旧响应晚到不得覆盖新会话结果 */
let generation: number = 0

function reset(): void {
	generation += 1
	boundSessionId = ''
	files.value = []
	phase.value = 'idle'
	error.value = ''
	additions.value = 0
	deletions.value = 0
}

/** 标脏但不甩掉已展示的清单：phase 从 ready 退回 idle，下次 load() 必重新拉。
 *
 * **WHY 不直接 reset()**：一轮任务刚结束时会话 id 没变，若 reset 就把用户眼前
 * 的产物列表清空并闪一次 loading；而继续复用又会让「刚产出的文件」看不见
 * （账本已更新、缓存还是旧的）。标脏是这两者之间唯一正确的取舍：
 * 屏上内容先留着，下一次打开弹层立即拿到新账本。 */
function invalidate(): void {
	generation += 1
	if (phase.value === 'ready') phase.value = 'idle'
}

/**
 * 拉取指定会话的产物清单。
 *
 * sessionId 为空（欢迎页/未建会话）直接落 ready+空清单：那不是错误，是确实
 * 还没有产出。设备离线/未登录则落 error，明确告知用户而不是伪装成「暂无产物」。
 */
async function load(conv: Conversation | null, force: boolean = false): Promise<void> {
	if (conv == null || conv.id.length === 0) {
		reset()
		return
	}
	const sid: string = conv.id
	// 复用：同一会话且已有成功结果，不重复请求（弹层反复打开零网络开销）
	if (!force && boundSessionId === sid && phase.value === 'ready') return
	if (!force && boundSessionId === sid && phase.value === 'loading') return

	generation += 1
	const gen: number = generation
	boundSessionId = sid
	phase.value = 'loading'
	error.value = ''

	const devices = useDevices()
	if (devices.activeDeviceId.value.length === 0) {
		if (gen !== generation) return
		phase.value = 'error'
		error.value = i18n.global.t('chat.deviceRequired')
		return
	}

	try {
		await ensureConnected(devices.activeDeviceId.value)
		// root 透传走 **query**：两端内核的该端点都只认 `root` 查询参数
		// （Java `@Param("root")` / Rust `FilerQuery.root`），X-Session-Cwd 头对它无效。
		const root: string = conv.workspace === DEFAULT_WORKSPACE ? '' : conv.workspace
		const query: string = 'sessionId=' + encodeURIComponent(sid)
			+ (root.length > 0 ? '&root=' + encodeURIComponent(root) : '')
		const body: ApiBody = await request('GET', '/web/chat/changes/session', query, '', root)
		if (gen !== generation) return
		if (!kernelOk(body)) {
			phase.value = 'error'
			error.value = fieldString(body, 'description')
			if (error.value.length === 0) error.value = i18n.global.t('chat.artifacts.loadFailed')
			return
		}
		const data = body['data']
		const payload: ApiBody = (data != null && typeof data === 'object') ? data as ApiBody : {}
		const parsed: ArtifactFile[] = parseArtifacts(payload)
		files.value = parsed
		additions.value = numOf(payload, 'additions')
		deletions.value = numOf(payload, 'deletions')
		phase.value = 'ready'
	} catch (err: any) {
		if (gen !== generation) return
		// 失败必须显式报错：拉不到 ≠ 没产出（离线/链路/权限都是可恢复故障）
		phase.value = 'error'
		const msg: string = err instanceof Error ? err.message : ''
		error.value = msg.length > 0 ? msg : i18n.global.t('chat.artifacts.loadFailed')
	}
}

/**
 * 无状态单例：ref 定义在模块级，任何组件调用都拿到同一份数据。
 * 与 useDevices/useRunEnv 同为「模块级共享状态」范式，避免弹层每次重建都重拉。
 */
export function useArtifacts(): ArtifactsState {
	return { files, phase, error, additions, deletions, load, reset, invalidate }
}
