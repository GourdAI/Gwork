import { i18n } from '@/locale/i18n.ts'
import { showToast } from '@/utils/tools.ts'

/** 后端 JSON 响应体，字段类型不稳定，读取时需自行判断 */
export type ApiBody = Record<string, any>

/** 直接取自 uni.request 的类型，保证新增的平台参数自动可用 */
export type UniRequestOptions = Parameters<typeof uni.request>[0]
export type UniMethod = NonNullable<UniRequestOptions['method']>
export type UniRequestResponse = Parameters<NonNullable<UniRequestOptions['success']>>[0]
export type UniRequestTask = ReturnType<typeof uni.request>

/** 取自 uni.connectSocket 的返回类型（设备中转 WS 用，见 utils/gwork-link.ts） */
export type UniSocketTask = ReturnType<typeof uni.connectSocket>

/** 与 uni.request 参数一致（去掉由工厂接管的 url 与回调），额外支持 anon、toast 与 onTask */
export type ApiRequestOptions = Omit<UniRequestOptions, 'url' | 'success' | 'fail' | 'complete'> & {
	/** 不带 token */
	anon?: boolean
	/** 失败时是否弹 toast，默认弹；传 false 关闭 */
	toast?: boolean
	/** 拿到 RequestTask 后的回调，用于 abort 或监听 onHeadersReceived 等 */
	onTask?: (task: UniRequestTask) => void
}

/** 成功响应：与 uni.request 的 success 结果一致，data 为后端响应体 */
export type ApiResponse<T> = Omit<UniRequestResponse, 'data'> & { data: T }

export type ApiMethodFn = <T>(path: string, data?: Record<string, any> | null, options?: ApiRequestOptions) => Promise<ApiResponse<T>>

export type ApiClient = {
	request<T>(path: string, options?: ApiRequestOptions): Promise<ApiResponse<T>>
	/** 与 uni.request 的 method 一一对应；data 作为请求体，GET/HEAD 等无请求体的方法由 uni 转为查询串 */
	get: ApiMethodFn
	post: ApiMethodFn
	put: ApiMethodFn
	delete: ApiMethodFn
	head: ApiMethodFn
	options: ApiMethodFn
	trace: ApiMethodFn
	connect: ApiMethodFn
}

/** 响应判定结果：ok 表示成功；失败时 message 为展示文案，silent 为 true 时不弹 toast（由实例自行处理） */
export type ResponseVerdict = { ok: true } | { ok: false; message: string; businessCode?: number; silent?: boolean }

/** 各实例自定义的响应判定，只决定成败与文案，不做通用的 HTTP 解析 */
export type ResponseInterceptor = (statusCode: number, body: ApiBody | null) => ResponseVerdict

/** 单个后端实例的连接参数，每个实例各一份，互不共享 */
export type ApiClientConfig = {
	baseUrl: string
	timeout: number
	/** 实例级默认请求头 */
	headers?: Record<string, string>
	/** 本地存 token 的 key；不传则不附带鉴权头，不同实例必须不同 */
	tokenKey?: string
	/** 失败时写入 ApiError 的来源标识，用来区分不同后端实例 */
	errorSubject: string
	/** 未提供时只按 HTTP 状态与响应体是否存在判定 */
	interceptResponse?: ResponseInterceptor
}

/** 统一的错误对象，reject 出去的错误都是它，便于 instanceof 判断 */
export class ApiError extends Error {
	subject: string
	httpStatus: number
	businessCode: number
	body: ApiBody | null

	constructor(message: string, subject: string, httpStatus: number, businessCode: number, body: ApiBody | null) {
		super(message)
		this.subject = subject
		this.httpStatus = httpStatus
		this.businessCode = businessCode
		this.body = body
	}
}

function defaultInterceptResponse(statusCode: number, body: ApiBody | null): ResponseVerdict {
	const httpOk = statusCode >= 200 && statusCode < 300
	if (httpOk && body != null) return { ok: true }
	const message = httpOk ? i18n.global.t('request.failed') : i18n.global.t('request.httpError', { status: statusCode })
	return { ok: false, message: message }
}

/**
 * 创建基于 uni.request 的请求函数：路径拼接 baseUrl，其余参数原样透传给 uni.request。
 * 成功时 resolve 为 uni.request 的响应对象；失败统一 reject 为 ApiError。
 */
export function createApiClient(config: ApiClientConfig): ApiClient {
	const interceptResponse = config.interceptResponse ?? defaultInterceptResponse

	const request = <T>(path: string, options?: ApiRequestOptions): Promise<ApiResponse<T>> => {
		const { anon, onTask, toast, header, ...rest } = options ?? {}
		const showError = (message: string) => {
			if (toast !== false) showToast(message)
		}
		const requestHeader: Record<string, string> = {
			'Accept': 'application/json',
			'Content-Type': 'application/json',
			...config.headers,
			...header
		}
		if (config.tokenKey != null && anon !== true) {
			const token = uni.getStorageSync(config.tokenKey) as string
			if (token != null && token.length > 0) {
				requestHeader['Authorization'] = `Bearer ${token}`
			}
		}

		return new Promise<ApiResponse<T>>((resolve, reject) => {
			const task = uni.request({
				timeout: config.timeout,
				...rest,
				url: config.baseUrl + path,
				header: requestHeader,
				success: (res: UniRequestResponse) => {
					const body = (res.data ?? null) as ApiBody | null
					const verdict = interceptResponse(res.statusCode, body)
					if (verdict.ok) {
						resolve({ ...res, data: body as T })
						return
					}
					if (!verdict.silent) showError(verdict.message)
					reject(new ApiError(verdict.message, config.errorSubject, res.statusCode, verdict.businessCode ?? 0, body))
				},
				fail: () => {
					const message = i18n.global.t('request.network')
					// toast:false 对网络失败同样生效（此前只对业务失败生效）：
					// 站点竞速探测必然有一路失败，静默请求不能往用户脸上弹「网络异常」
					if (toast !== false) showError(message)
					reject(new ApiError(message, config.errorSubject, 0, 0, null))
				}
			})
			onTask?.(task)
		})
	}

	const withMethod = (method: UniMethod): ApiMethodFn => {
		return <T>(path: string, data?: Record<string, any> | null, options?: ApiRequestOptions): Promise<ApiResponse<T>> => {
			return request<T>(path, { ...options, method: method, data: data ?? undefined })
		}
	}

	return {
		request: request,
		get: withMethod('GET'),
		post: withMethod('POST'),
		put: withMethod('PUT'),
		delete: withMethod('DELETE'),
		head: withMethod('HEAD'),
		options: withMethod('OPTIONS'),
		trace: withMethod('TRACE' as UniMethod),
		connect: withMethod('CONNECT' as UniMethod)
	}
}
