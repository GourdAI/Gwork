/**
 * GWork 官方账号请求实例（gourd-work-admin / new-api）。
 *
 * 契约与桌面端 src-tauri/src/auth.rs 逐条对齐：
 * - 响应信封 {success, message, data}，只有「HTTP 2xx + 显式 success:true」算成功
 *   （fail-closed：缺 success 字段的异常 JSON 一律按失败处理，绝不 fail-open）。
 * - 业务错误也常是 HTTP 200 + success:false；message 可能只是 HTTP StatusText，
 *   精确原因在 code 里，报错时把 code 一并带出（如 AUTH_SESSION_REVOKED）。
 * - 站点选定后全程锁定同一 base：会话 Cookie / 刷新令牌不跨站重放。
 *
 * 本实例不用工厂的 token 注入（access token 由 gwork-auth.ts 管理并在临期时
 * 先 refresh），故不配 tokenKey。
 */
import { createApiClient, type ApiBody, type ApiClient, type ApiRequestOptions, type ApiResponse, type ResponseVerdict } from '@/utils/request.ts'
import { i18n } from '@/locale/i18n.ts'
import { GWORK_BASES, GWORK_REQUEST_TIMEOUT, originOf } from '@/config/gwork-config.ts'

const clients: ApiClient[] = GWORK_BASES.map((base: string): ApiClient => {
	return createApiClient({
		baseUrl: base,
		timeout: GWORK_REQUEST_TIMEOUT,
		errorSubject: 'gwork',
		interceptResponse: interceptGworkResponse
	})
})

/** 当前锁定的站点下标；-1 = 尚未探测 */
let hostIndex: number = -1
let probing: Promise<number> | null = null

function gworkBase(): string {
	return GWORK_BASES[hostIndex >= 0 ? hostIndex : 0]
}

/** refresh/logout 的 Origin 必须是站点真实源（H5 代理前缀不是合法 Origin） */
export function gworkOrigin(): string {
	return originOf(gworkBase())
}

function strOf(body: ApiBody | null, key: string): string {
	if (body == null) return ''
	const v = body[key]
	return typeof v === 'string' ? v : ''
}

/**
 * new-api 判定：HTTP 2xx + 显式 success:true 才成功。
 * 会话终结类错误（token 失效 / 会话撤销）由 gwork-auth.ts 依据 code 处理，
 * 这里只负责如实报错，不清凭据、不跳页 —— 网络抖动不能把用户踢下线。
 */
function interceptGworkResponse(statusCode: number, body: ApiBody | null): ResponseVerdict {
	const httpOk = statusCode >= 200 && statusCode < 300
	const success = body != null && body.success === true
	if (httpOk && success && body != null) return { ok: true }

	const code = strOf(body, 'code')
	const msg = strOf(body, 'message')
	const fallback = httpOk
		? i18n.global.t('request.failed')
		: i18n.global.t('request.httpError', { status: statusCode })
	const base = msg.length > 0 ? msg : fallback
	return {
		ok: false,
		message: code.length > 0 ? base + ' [' + code + ']' : base,
		businessCode: statusCode,
		// 错误统一由调用方按场景展示（登录表单 hint / toast），避免双重提示
		silent: true
	}
}

/** 对锁定站点发请求；未锁定时先探测 */
async function call<T>(method: 'get' | 'post' | 'put', path: string, data?: Record<string, any> | null, options?: ApiRequestOptions): Promise<ApiResponse<T>> {
	const idx = await ensureGworkHost()
	const client = clients[idx]
	if (method === 'get') return client.get<T>(path, data, options)
	if (method === 'put') return client.put<T>(path, data, options)
	return client.post<T>(path, data, options)
}

/** 会话请求头：Origin 与站点同源（SessionCookieOriginGuard 在 secure cookie 部署下强制校验） */
export function sessionHeader(extra?: Record<string, string>): Record<string, string> {
	const header: Record<string, string> = { 'Origin': gworkOrigin() }
	if (extra != null) {
		const keys = Object.keys(extra)
		for (let i = 0; i < keys.length; i++) {
			header[keys[i]] = extra[keys[i]]
		}
	}
	return header
}

export const gworkRequest = {
	get: async <T>(path: string, data?: Record<string, any> | null, options?: ApiRequestOptions): Promise<ApiResponse<T>> => {
		return call<T>('get', path, data, options)
	},
	post: async <T>(path: string, data?: Record<string, any> | null, options?: ApiRequestOptions): Promise<ApiResponse<T>> => {
		return call<T>('post', path, data, options)
	},
	put: async <T>(path: string, data?: Record<string, any> | null, options?: ApiRequestOptions): Promise<ApiResponse<T>> => {
		return call<T>('put', path, data, options)
	}
}

/** 单站探测：GET {base}/api/status 必须 2xx + success:true + data 对象存在。
 * 工厂已把 success/fail 接管为 Promise（ApiRequestOptions 剔除了回调字段），
 * 这里必须走 .then/.catch，传 success 回调既过不了类型也不会执行 */
function probeOne(idx: number): Promise<number> {
	return clients[idx].request<ApiBody>('/api/status', {
		method: 'GET',
		anon: true,
		toast: false
	}).then((res): number => {
		const body = res.data as ApiBody | null
		const data = body != null ? body.data : null
		if (body != null && body.success === true && data != null && typeof data === 'object') {
			return idx
		}
		throw new Error('invalid status')
	})
}

/**
 * 双站点竞速探测（与桌面端 ensure_host 同语义）：谁先返回有效 JSON 用谁；
 * 全部失败时抛错，绝不静默选一个 —— 登录请求打到不可达站点只会得到误导性网络错误。
 * 进程内只探测一次，结果全程锁定。
 */
export function ensureGworkHost(): Promise<number> {
	if (hostIndex >= 0) return Promise.resolve(hostIndex)
	if (probing != null) return probing
	probing = new Promise<number>((resolve, reject) => {
		let pending = GWORK_BASES.length
		let settled = false
		const onFail = () => {
			pending -= 1
			if (pending === 0 && !settled) {
				settled = true
				probing = null
				reject(new Error(i18n.global.t('request.network')))
			}
		}
		for (let i = 0; i < GWORK_BASES.length; i++) {
			probeOne(i).then((idx: number) => {
				if (settled) return
				settled = true
				hostIndex = idx
				probing = null
				resolve(idx)
			}, onFail)
		}
	})
	return probing
}

/** 取响应信封的 data 对象；缺失时返回空对象，字段读取一律经 fieldString 判型 */
export function gworkDataOf(body: ApiBody): ApiBody {
	const data = body.data
	return data != null && typeof data === 'object' ? data as ApiBody : {}
}