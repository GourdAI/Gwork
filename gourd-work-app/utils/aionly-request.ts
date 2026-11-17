import { createApiClient, type ApiBody, type ApiRequestOptions, type ApiResponse, type ResponseVerdict } from '@/utils/request.ts'
import { aionlyConfig } from '@/config/aionly-config.ts'
import { i18n } from '@/locale/i18n.ts'

const AIONLY_TOKEN_KEY = 'aionly_access_token'

function clearAionlyToken(): void {
	uni.removeStorageSync(AIONLY_TOKEN_KEY)
}

/** 在 uni.request 参数之上，AIOnly 额外支持的加密选项 */
export type AionlyRequestOptions = ApiRequestOptions & {
	/** 请求体加密密钥，经 encrypt-key 头传给后端 */
	encryptKey?: string
	/** 站点加密接口：请求体加密，且不校验 token */
	siteEncrypt?: boolean
}

/** 取响应体里的业务码 code；后端有时返回数字、有时返回字符串，统一转成数字，非纯数字返回 null */
function codeOf(body: ApiBody): number | null {
	const raw = body.code
	if (typeof raw === 'number') return raw
	if (typeof raw === 'string' && /^\d+$/.test(raw)) return parseInt(raw, 10)
	return null
}

/** 取后端给的错误提示 msg，没有则返回空串，由下方兜底文案替换 */
function messageOf(body: ApiBody | null): string {
	if (body == null) return ''
	const msg = body.msg
	return typeof msg === 'string' ? msg : ''
}

/**
 * AIOnly 的响应判定：HTTP 2xx 且业务码为 200 才成功；401/403 时清除本地 token。
 * 无业务码的接口（如验证码 repCode）不做业务码判断，由调用方自行处理。
 */
const LOGIN_PAGE = '/pages/login/index'

// 并发请求同时 401 时只跳一次登录页，跳转结束后释放锁，下次过期仍能触发
let redirectingToLogin = false
function handleSessionExpired(): void {
	if (redirectingToLogin) return
	redirectingToLogin = true
	clearAionlyToken()
	uni.showToast({ title: i18n.global.t('request.authExpired'), icon: 'none' })
	uni.reLaunch({
		url: LOGIN_PAGE,
		complete: () => {
			redirectingToLogin = false
		}
	})
}

function interceptAionlyResponse(statusCode: number, body: ApiBody | null): ResponseVerdict {
	const businessCode = body != null ? codeOf(body) : null
	const authFailed = statusCode == 401 || businessCode == 401 || businessCode == 403
	if (authFailed) handleSessionExpired()
	const httpOk = statusCode >= 200 && statusCode < 300
	const codeOk = businessCode == null || businessCode == 200
	if (httpOk && codeOk && body != null) return { ok: true }

	const fallback = authFailed
		? i18n.global.t('request.authExpired')
		: httpOk
			? i18n.global.t('request.failed')
			: i18n.global.t('request.httpError', { status: statusCode })
	const serverMessage = messageOf(body)
	return { ok: false, message: serverMessage.length > 0 ? serverMessage : fallback, businessCode: businessCode ?? 0, silent: authFailed }
}

const client = createApiClient({
	baseUrl: aionlyConfig.baseUrl,
	timeout: aionlyConfig.requestTimeout,
	headers: {
		'clientid': aionlyConfig.clientId,
		'hostname': aionlyConfig.hostname
	},
	tokenKey: AIONLY_TOKEN_KEY,
	errorSubject: 'aionly',
	interceptResponse: interceptAionlyResponse
})

function withEncryptHeaders(options?: AionlyRequestOptions): ApiRequestOptions {
	const { encryptKey, siteEncrypt, header, ...rest } = options ?? {}
	const requestHeader: Record<string, string> = { ...header }
	if (typeof encryptKey === 'string') {
		requestHeader['encrypt-key'] = encryptKey
	}
	if (siteEncrypt === true) {
		requestHeader['isToken'] = 'false'
		requestHeader['isEncrypt'] = 'true'
	}
	return { ...rest, header: requestHeader }
}

/** 返回后端响应体的方法集合，覆盖 uni.request 支持的全部 method */
const unwrap = <T>(pending: Promise<ApiResponse<T>>): Promise<T> => {
	return pending.then((res) => res.data)
}

export const aionlyRequest = {
	request: <T>(path: string, options?: AionlyRequestOptions): Promise<ApiResponse<T>> => {
		return client.request<T>(path, withEncryptHeaders(options))
	},
	get: <T>(path: string, data?: Record<string, any> | null, options?: AionlyRequestOptions): Promise<T> => {
		return unwrap(client.get<T>(path, data, withEncryptHeaders(options)))
	},
	post: <T>(path: string, data?: Record<string, any> | null, options?: AionlyRequestOptions): Promise<T> => {
		return unwrap(client.post<T>(path, data, withEncryptHeaders(options)))
	},
	put: <T>(path: string, data?: Record<string, any> | null, options?: AionlyRequestOptions): Promise<T> => {
		return unwrap(client.put<T>(path, data, withEncryptHeaders(options)))
	},
	delete: <T>(path: string, data?: Record<string, any> | null, options?: AionlyRequestOptions): Promise<T> => {
		return unwrap(client.delete<T>(path, data, withEncryptHeaders(options)))
	},
	head: <T>(path: string, data?: Record<string, any> | null, options?: AionlyRequestOptions): Promise<T> => {
		return unwrap(client.head<T>(path, data, withEncryptHeaders(options)))
	},
	options: <T>(path: string, data?: Record<string, any> | null, options?: AionlyRequestOptions): Promise<T> => {
		return unwrap(client.options<T>(path, data, withEncryptHeaders(options)))
	},
	trace: <T>(path: string, data?: Record<string, any> | null, options?: AionlyRequestOptions): Promise<T> => {
		return unwrap(client.trace<T>(path, data, withEncryptHeaders(options)))
	},
	connect: <T>(path: string, data?: Record<string, any> | null, options?: AionlyRequestOptions): Promise<T> => {
		return unwrap(client.connect<T>(path, data, withEncryptHeaders(options)))
	}
}

/** 取响应里的 data 字段对象；没有 data 字段时，把整个响应体当作数据返回（兼容两种后端格式） */
export function dataOf(body: ApiBody): ApiBody {
	const data = body.data
	return data != null && typeof data === 'object' ? data as ApiBody : body
}

/** 从分页响应里取出列表行，兼容 `rows` 直接在根上、或在 `data.rows` 里两种结构；都没有则返回空数组 */
export function rowsOf(body: ApiBody): ApiBody[] {
	if (Array.isArray(body.rows)) return body.rows as ApiBody[]
	const nested = dataOf(body).rows
	if (Array.isArray(nested)) return nested as ApiBody[]
	return []
}
