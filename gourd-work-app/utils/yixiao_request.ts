import { createApiClient, type ApiBody, type ApiRequestOptions, type ApiResponse, type ResponseVerdict } from '@/utils/request.ts'
import { i18n } from '@/locale/i18n.ts'
import { showToast } from '@/utils/tools.ts'

declare const __ENV__: Record<string, string>

// H5 走 vite dev 代理规避浏览器跨域；原生端直连 VITE_YIXIAO_BASE_URL
// #ifdef H5
const YIXIAO_BASE_URL = __ENV__.VITE_YIXIAO_PROXY
// #endif
// #ifndef H5
const YIXIAO_BASE_URL = __ENV__.VITE_YIXIAO_BASE_URL
// #endif

export const YIXIAO_TOKEN_KEY = 'yixiao_access_token'

/** 取响应体里的业务码 code；后端可能返回数字或字符串，统一转成数字，非纯数字返回 null */
function codeOf(body: ApiBody): number | null {
	const raw = body.code
	if (typeof raw === 'number') return raw
	if (typeof raw === 'string' && /^\d+$/.test(raw)) return parseInt(raw, 10)
	return null
}

/** 易晓错误信息字段为 msg 或 message，两者都兼容 */
function messageOf(body: ApiBody | null): string {
	if (body == null) return ''
	const raw = body.msg ?? body.message
	return typeof raw === 'string' ? raw : ''
}

const LOGIN_PAGE = '/pages/login/index'
const GATEWAY_STATUSES = [502, 503, 504]

// 并发请求同时 401 时只跳一次登录页，跳转结束后释放锁，下次过期仍能触发
let redirectingToLogin = false
function handleSessionExpired(): void {
	if (redirectingToLogin) return
	redirectingToLogin = true
	uni.removeStorageSync(YIXIAO_TOKEN_KEY)
	showToast(i18n.global.t('request.authExpired'))
	uni.reLaunch({
		url: LOGIN_PAGE,
		complete: () => {
			redirectingToLogin = false
		}
	})
}

/**
 * 易晓的响应判定：HTTP 2xx 且业务码为 200 才成功。
 * 401/403 清除 token 并跳转登录页（toast 由跳转流程统一弹出，故标记 silent）；
 * 502/503/504 在后端无可读文案时落到网关兜底提示。
 */
function interceptYixiaoResponse(statusCode: number, body: ApiBody | null): ResponseVerdict {
	const businessCode = body != null ? codeOf(body) : null
	const authFailed = statusCode == 401 || statusCode == 403 || businessCode == 401 || businessCode == 403
	if (authFailed) handleSessionExpired()
	const httpOk = statusCode >= 200 && statusCode < 300
	if (httpOk && businessCode == 200 && body != null) return { ok: true }

	const fallback = authFailed
		? i18n.global.t('request.authExpired')
		: httpOk
			? i18n.global.t('request.failed')
			: GATEWAY_STATUSES.includes(statusCode)
				? i18n.global.t('request.gatewayError')
				: i18n.global.t('request.httpError', { status: statusCode })
	const serverMessage = messageOf(body)
	return {
		ok: false,
		message: serverMessage.length > 0 ? serverMessage : fallback,
		businessCode: businessCode ?? 0,
		silent: authFailed
	}
}

const client = createApiClient({
	baseUrl: YIXIAO_BASE_URL,
	timeout: parseInt(__ENV__.VITE_YIXIAO_REQUEST_TIMEOUT),
	tokenKey: YIXIAO_TOKEN_KEY,
	errorSubject: 'yixiao',
	interceptResponse: interceptYixiaoResponse
})

/** 返回后端响应体（data 层）的方法集合 */
const unwrap = <T>(pending: Promise<ApiResponse<T>>): Promise<T> => {
	return pending.then((res) => res.data)
}

export const yixiaoRequest = {
	request: <T>(path: string, options?: ApiRequestOptions): Promise<ApiResponse<T>> => {
		return client.request<T>(path, options)
	},
	get: <T>(path: string, data?: Record<string, any> | null, options?: ApiRequestOptions): Promise<T> => {
		return unwrap(client.get<T>(path, data, options))
	},
	post: <T>(path: string, data?: Record<string, any> | null, options?: ApiRequestOptions): Promise<T> => {
		return unwrap(client.post<T>(path, data, options))
	},
	put: <T>(path: string, data?: Record<string, any> | null, options?: ApiRequestOptions): Promise<T> => {
		return unwrap(client.put<T>(path, data, options))
	},
	delete: <T>(path: string, data?: Record<string, any> | null, options?: ApiRequestOptions): Promise<T> => {
		return unwrap(client.delete<T>(path, data, options))
	}
}
