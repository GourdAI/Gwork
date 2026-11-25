/**
 * GWork 官方账号会话管理：登录 / 注册 / 验证码 / 保活 / 登出 / 用户信息。
 *
 * 与桌面端 src-tauri/src/auth.rs 同一套契约（后台 gourd-work-admin）：
 * - 登录 POST /api/user/login → data{access_token(15min), access_expires_at, session{sid,...}, user}
 *   + Set-Cookie: new_api_refresh=<sid.secret>（HttpOnly 语义，原生端手动回传）。
 *   原生端从 RequestSuccess.cookies 数组读取（Set-Cookie 被网络层收进 cookie jar，
 *   header 里没有）；H5 走代理镜像头 X-Gwork-Set-Cookie（见 extractRefreshCookie）。
 * - 刷新 POST /api/user/auth/refresh：Cookie + X-Auth-Session: sid + Origin，
 *   成功轮换 refresh cookie，必须持久化新值 —— 拿旧 secret 重放会被服务端撤销整个会话。
 * - 登出 POST /api/user/auth/logout：Bearer access + Cookie + X-Auth-Session。
 * - 注册 POST /api/user/register：{username,password,email,verification_code}，
 *   成功只回 {success:true} 不发凭据，随后自动登录。
 * - 注册验证码 GET /api/verification?email=...（后台限流：同 IP 30s 内 2 次，
 *   客户端取 60s 冷却更宽松）。
 * - 能力探测 GET /api/status：email_verification 只有【显式 false】才放开邮箱验证，
 *   探测失败保持必填（fail-closed，与桌面端一致）。
 *
 * 【密码加密传输】是否需要加密只问 GET /api/user/login/encryption-key 自己的
 * enabled 字段（唯一真相源）。四态判定与桌面端 decide_login_encryption 一致：
 * 明确关闭 / 旧版后台 404 → 明文；开启且公钥可用 → v2 信封；无法判定 → 中止登录，
 * 绝不静默发明文（后台开启加密时明文会被判 Invalid parameters，误导成「密码错误」）。
 * v2 信封需要 RSA-OAEP(label) + AES-GCM，仅 H5 的 WebCrypto 支持带 label 的 OAEP；
 * 原生端在后台开启加密时明确报错引导（当前线上两站点均未开启，实测 enabled:false）。
 *
 * 凭据存 uni storage（App 端为应用沙箱私有目录）；access token 15 分钟短命，
 * 每次鉴权请求前临期先刷新，App 回前台再补一次 —— 覆盖移动端「切后台很久再回来」。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import { i18n } from '@/locale/i18n.ts'
import { fieldString } from '@/utils/tools.ts'
import { gworkRequest, gworkDataOf, sessionHeader, ensureGworkHost } from '@/utils/gwork-request.ts'
import type { ApiBody, ApiResponse } from '@/utils/request.ts'

const SESSION_KEY = 'gwork_account_session'
const REFRESH_COOKIE = 'new_api_refresh'
/** access token 提前刷新余量（秒），与桌面端 REFRESH_LEAD_SECS 一致 */
const REFRESH_LEAD_SECS = 60
/** 365 天绝对上限（与服务端 LoginSessionAbsoluteTTL 一致），仅用于本地兜底判断 */
const ABSOLUTE_TTL_SECS = 365 * 24 * 60 * 60

export type GworkSession = {
	refreshToken: string
	sid: string
	accessToken: string
	accessExpiresAt: number
	sessionExpiresAt: number
	userId: number
	username: string
	displayName: string
}

/** 登录态（跨页面共享）：signedIn 以「有 access token」为准，临期由 ensureFresh 刷新 */
const signedIn: Ref<boolean> = ref<boolean>(false)

let session: GworkSession | null = null
/** 会话写操作串行化：login/refresh/logout 并发时旧 secret 重放会触发服务端撤销 */
let sessionChain: Promise<any> = Promise.resolve()
/** 注册能力（email_verification），默认必填；只有探测到显式 false 才放开 */
let emailRequired: boolean = true
let configProbedAt: number = 0
/** 登录加密公钥缓存（5 分钟，与桌面端 / web 端一致） */
let encKeyCache: { kid: string; publicKey: string; disabled: boolean; at: number } | null = null

function t(key: string): string {
	return i18n.global.t(key)
}

function nowSecs(): number {
	return Math.floor(Date.now() / 1000)
}

function persist(): void {
	if (session == null) {
		uni.removeStorageSync(SESSION_KEY)
		signedIn.value = false
		return
	}
	uni.setStorageSync(SESSION_KEY, JSON.stringify(session))
	signedIn.value = session.accessToken.length > 0
}

function load(): GworkSession | null {
	const raw = uni.getStorageSync(SESSION_KEY) as string
	if (raw == null || raw.length === 0) return null
	try {
		const obj = JSON.parse(raw) as GworkSession
		if (obj.refreshToken == null || obj.refreshToken.length === 0) return null
		return obj
	} catch (_) {
		return null
	}
}

/** 单条 Set-Cookie 值里可能合并了多个 cookie（部分平台用逗号拼接），逐段找 new_api_refresh */
function pickRefreshFromLine(line: string): string {
	const segments = line.split(',')
	for (let i = 0; i < segments.length; i++) {
		const pair = segments[i].split(';')[0].trim()
		const eq = pair.indexOf('=')
		if (eq <= 0) continue
		if (pair.substring(0, eq).trim() === REFRESH_COOKIE) {
			return pair.substring(eq + 1).trim()
		}
	}
	return ''
}

/** 从响应里取 new_api_refresh 的值（sid.secret）。三条来源按序尝试：
 * 1. 原生端 RequestSuccess.cookies（uni-app x Android/iOS/鸿蒙 3.91+/4.11+）：
 *    Set-Cookie 被原生网络层收进 cookie jar，header 里【没有】set-cookie，
 *    官方给的取法就是这个字符串数组 —— HBuilderX 真机此前一直失败的真因。
 * 2. header 的 set-cookie（部分平台/旧基座仍透传；大小写不敏感、多行/数组合并形态兼容）。
 * 3. header 的 x-gwork-set-cookie：H5 浏览器把 Set-Cookie 列为 forbidden response
 *    header 拿不到，由代理/网关镜像成可读自定义头（vite 开发代理已配，生产网关须同样镜像）。 */
function extractRefreshCookie(header: Record<string, any> | null, cookies: string[] | null): string {
	if (cookies != null) {
		for (let i = 0; i < cookies.length; i++) {
			const value = pickRefreshFromLine(cookies[i])
			if (value.length > 0) return value
		}
	}
	if (header == null) return ''
	const keys = Object.keys(header)
	for (let i = 0; i < keys.length; i++) {
		const name = keys[i].toLowerCase()
		if (name !== 'set-cookie' && name !== 'x-gwork-set-cookie') continue
		const raw = header[keys[i]]
		const lines: string[] = typeof raw === 'string' ? raw.split('\n') : (Array.isArray(raw) ? raw as string[] : [])
		for (let j = 0; j < lines.length; j++) {
			const value = pickRefreshFromLine(lines[j])
			if (value.length > 0) return value
		}
	}
	return ''
}

/** 登录/刷新响应 data → 会话；缺失字段用旧会话兜底（与桌面端 session_from_auth_data 一致） */
function sessionFromData(data: ApiBody, refreshToken: string, fallback: GworkSession | null): GworkSession {
	const user = (data.user != null && typeof data.user === 'object' ? data.user : {}) as ApiBody
	const sess = (data.session != null && typeof data.session === 'object' ? data.session : {}) as ApiBody
	let sid = fieldString(sess, 'sid')
	if (sid.length === 0) sid = fallback != null ? fallback.sid : ''
	if (sid.length === 0) sid = refreshToken.split('.')[0]
	const username = fieldString(user, 'username').length > 0 ? fieldString(user, 'username') : (fallback != null ? fallback.username : '')
	const displayName = fieldString(user, 'display_name').length > 0 ? fieldString(user, 'display_name') : username
	const idRaw = user.id
	const userId = typeof idRaw === 'number' ? idRaw : (fallback != null ? fallback.userId : 0)
	const createdAt = typeof sess.created_at === 'number' ? sess.created_at as number : 0
	const expiresAt = typeof sess.expires_at === 'number' ? sess.expires_at as number : 0
	const sessionExpiresAt = createdAt > 0 ? createdAt + ABSOLUTE_TTL_SECS : (expiresAt > 0 ? expiresAt : (fallback != null ? fallback.sessionExpiresAt : 0))
	return {
		refreshToken: refreshToken,
		sid: sid,
		accessToken: fieldString(data, 'access_token'),
		accessExpiresAt: typeof data.access_expires_at === 'number' ? data.access_expires_at as number : 0,
		sessionExpiresAt: sessionExpiresAt,
		userId: userId,
		username: username,
		displayName: displayName
	}
}

/** 会话终结类错误：凭据必须清掉；网络/限流类错误保留凭据等重试。
 * 只认鉴权命名空间的错误码 + HTTP 401：403 可能是权限不足（AUTH_INSUFFICIENT_PRIVILEGE）
 * 或安全验证问题（SECURITY_PROOF_*），不代表登录会话失效，误清会把用户无辜踢下线 */
function isTerminalAuthError(err: any): boolean {
	const body = err != null ? err.body : null
	const code = body != null && typeof body.code === 'string' ? body.code as string : ''
	if (code === 'AUTH_UNAUTHORIZED' || code === 'AUTH_SESSION_REVOKED' || code === 'AUTH_TOKEN_EXPIRED' || code === 'AUTH_SESSION_MISMATCH' || code === 'AUTH_USER_DISABLED' || code === 'AUTH_USER_INVALID') return true
	const status = err != null && typeof err.httpStatus === 'number' ? err.httpStatus as number : 0
	return status === 401
}

function clearSession(): void {
	session = null
	persist()
}

/** 把会话写操作排进串行链：前一个失败不阻断后续 */
function serialize<T>(job: () => Promise<T>): Promise<T> {
	const run = sessionChain.then(job, job)
	sessionChain = run.then((): void => { }, (): void => { })
	return run
}

/* ---------------- 能力探测 ---------------- */

/** 注册是否强制邮箱验证码。60s 缓存；只有显式 email_verification:false 才放开 */
export async function probeRegisterConfig(): Promise<boolean> {
	const now = Date.now()
	if (configProbedAt > 0 && now - configProbedAt < 60000) return emailRequired
	try {
		const res = await gworkRequest.get<ApiBody>('/api/status', null, { anon: true, toast: false })
		const data = gworkDataOf(res.data as ApiBody)
		if (typeof data.email_verification === 'boolean') {
			emailRequired = data.email_verification as boolean
			configProbedAt = now
		}
	} catch (_) {
		// 探测失败保持必填：线上后台已开启邮箱验证，降级会让用户漏填验证码
	}
	return emailRequired
}

/* ---------------- 登录加密 ---------------- */

type EncDecision = { kind: 'plain' } | { kind: 'encrypted'; kid: string; publicKey: string } | { kind: 'unavailable'; reason: string }

async function loginEncryption(): Promise<EncDecision> {
	const now = Date.now()
	if (encKeyCache != null && now - encKeyCache.at < 300000) {
		if (encKeyCache.disabled) return { kind: 'plain' }
		return { kind: 'encrypted', kid: encKeyCache.kid, publicKey: encKeyCache.publicKey }
	}
	let res: ApiResponse<ApiBody>
	try {
		res = await gworkRequest.get<ApiBody>('/api/user/login/encryption-key', null, { anon: true, toast: false, header: sessionHeader() })
	} catch (err: any) {
		// 旧版后台没有该端点（404）：该版本也不校验加密，按明文登录
		const status = err != null && typeof err.httpStatus === 'number' ? err.httpStatus as number : 0
		if (status === 404) return { kind: 'plain' }
		const msg = err instanceof Error ? err.message : t('request.network')
		return { kind: 'unavailable', reason: msg }
	}
	const data = gworkDataOf(res.data as ApiBody)
	if (data.enabled !== true) {
		encKeyCache = { kid: '', publicKey: '', disabled: true, at: now }
		return { kind: 'plain' }
	}
	const kid = fieldString(data, 'kid')
	const publicKey = fieldString(data, 'public_key')
	if (kid.length === 0 || publicKey.length === 0) {
		return { kind: 'unavailable', reason: t('gwork.encNoKey') }
	}
	encKeyCache = { kid: kid, publicKey: publicKey, disabled: false, at: now }
	return { kind: 'encrypted', kid: kid, publicKey: publicKey }
}

// #ifdef WEB
/** H5：WebCrypto 实现 admin v2 信封（RSA-OAEP-SHA256(label=password-v2) 包 AES key + AES-256-GCM，AAD=password-v2:<kid>） */
async function encryptPasswordV2Web(password: string, publicKeyPem: string, kid: string): Promise<string> {
	const subtle = (globalThis as any).crypto.subtle
	const body = publicKeyPem.replace('-----BEGIN PUBLIC KEY-----', '').replace('-----END PUBLIC KEY-----', '').replace(/\s+/g, '')
	const binary = atob(body)
	const der = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i)
	const key = await subtle.importKey('spki', der.buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'])
	const aesKey = (globalThis as any).crypto.getRandomValues(new Uint8Array(32))
	const nonce = (globalThis as any).crypto.getRandomValues(new Uint8Array(12))
	const enc = new TextEncoder()
	const wrapped = await subtle.encrypt({ name: 'RSA-OAEP', label: enc.encode('password-v2') }, key, aesKey)
	const aes = await subtle.importKey('raw', aesKey, 'AES-GCM', false, ['encrypt'])
	const ct = await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: enc.encode('password-v2:' + kid) }, aes, enc.encode(password))
	const b64 = (buf: ArrayBuffer): string => {
		const bytes = new Uint8Array(buf)
		let s = ''
		for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
		return btoa(s)
	}
	return 'v2.' + b64(wrapped) + '.' + b64(nonce.buffer as ArrayBuffer) + '.' + b64(ct)
}
// #endif

async function buildLoginPayload(username: string, password: string): Promise<Record<string, any>> {
	const decision = await loginEncryption()
	if (decision.kind === 'plain') {
		return { username: username, password: password }
	}
	if (decision.kind === 'unavailable') {
		// 无法判定绝不发明文：后台若已开启加密，明文会被判 Invalid parameters，误导成「密码错误」
		throw new Error(t('gwork.encUnknown') + decision.reason)
	}
	// #ifdef WEB
	const encrypted = await encryptPasswordV2Web(password, decision.publicKey, decision.kid)
	return { username: username, password_encrypted: encrypted, encryption_key_id: decision.kid }
	// #endif
	// #ifndef WEB
	// 原生端 WebCrypto 不可用（带 label 的 RSA-OAEP 无现成 UTS 实现）：明确报错而不是发明文
	throw new Error(t('gwork.encNativeUnsupported'))
	// #endif
}

/** 服务端轮换/重载加密私钥后，旧 kid 会被 DecryptPassword 拒掉。信封类请求
 *  失败时清掉 5 分钟公钥缓存，否则接下来 5 分钟内登录/注册会持续失败
 *  （web 端已有 clearPasswordEncryptionCache，移动端此前缺失）。 */
function invalidateEncKeyCache(): void {
	if (encKeyCache != null && !encKeyCache.disabled) encKeyCache = null
}

/* ---------------- 登录 / 注册 / 验证码 ---------------- */

export async function gworkLogin(username: string, password: string): Promise<GworkSession> {
	return serialize<GworkSession>(async (): Promise<GworkSession> => {
		await ensureGworkHost()
		// 本机上一份会话的快照，必须在 session = ... 覆盖之前取：覆盖之后旧
		// refreshToken 就永久丢失，那份 Session 会在服务端一直 active 到绝对
		// 上限到期。见下方 revokeSessionQuietly 调用处的说明。
		const superseded = session
		const payload = await buildLoginPayload(username, password)
		let res: ApiResponse<ApiBody>
		try {
			res = await gworkRequest.post<ApiBody>('/api/user/login', payload, { anon: true, toast: false, header: sessionHeader() })
		} catch (err: any) {
			if (payload['password_encrypted'] != null) invalidateEncKeyCache()
			throw err
		}
		const body = res.data as ApiBody
		const data = gworkDataOf(body)
		// 两阶段验证（2FA / 邮箱 challenge）：data 无 access_token，明确报错而非当成功
		if (data.require_verification === true || fieldString(data, 'access_token').length === 0) {
			throw new Error(t('gwork.needVerification'))
		}
		const refresh = extractRefreshCookie(res.header as Record<string, any>, res.cookies as string[] | null)
		if (refresh.length === 0) {
			throw new Error(t('gwork.noSession'))
		}
		session = sessionFromData(data, refresh, null)
		if (session.sid.length === 0) {
			throw new Error(t('gwork.needVerification'))
		}
		persist()
		/* 【2026-11 `Conflict [AUTH_SESSION_LIMIT]` 报障的一环】移动端每次登录都
		   让后台签发一份新 Session，并用它覆盖内存与 storage 里的旧凭据。旧凭据被
		   覆盖后 refreshToken 永久丢失，那份 Session 会在服务端保持 active 直到
		   365 天绝对上限到期 —— 反复登录、或在两个账号之间来回切换，就会攒出一堆
		   用户既看不见也撤不掉的僵尸行，最终占满 USER_SESSION_ACTIVE_LIMIT。
		   服务端已改为触顶时自动挤号兜底，但本机自己制造的垃圾应由本机自己清掉，
		   不该靠兜底把用户别的设备挤下线。
		   best-effort：失败不影响刚刚成功的登录；旧凭据可能早已在服务端失效。
		   调用点在 serialize 链内，与 refresh/logout 天然串行，无并发撤销竞态。 */
		if (superseded != null && shouldRevokeSuperseded(superseded.sid, session.sid, superseded.refreshToken)) {
			await revokeSessionQuietly(superseded)
		}
		return session
	})
}

/** 注册成功后自动登录（后台注册接口只回 success:true 不发凭据）
 *
 * 密码走与登录同一套加密判定：后台开启 password_login_encryption 时，
 * 注册若仍发明文就是一条绕过登录侧加密的明文旁路（管理员以为「密码不再明文
 * 传输」，实际上注册请求里还是明文）。因此这里复用 buildLoginPayload：
 * 明确关闭/旧版后台 → 明文；开启 → v2 信封；无法判定 → 中止（绝不静默发明文）。 */
export async function gworkRegister(username: string, password: string, email: string, code: string): Promise<GworkSession> {
	await ensureGworkHost()
	const payload: Record<string, any> = await buildLoginPayload(username, password)
	if (email.trim().length > 0) payload['email'] = email.trim()
	if (code.trim().length > 0) payload['verification_code'] = code.trim()
	try {
		await gworkRequest.post<ApiBody>('/api/user/register', payload, { anon: true, toast: false, header: sessionHeader() })
	} catch (err: any) {
		// 注册也走信封：密钥轮换后旧 kid 会让本次及后续 5 分钟都失败，必须清缓存
		if (payload['password_encrypted'] != null) invalidateEncKeyCache()
		throw err
	}
	return gworkLogin(username, password)
}

/** 发送注册邮箱验证码；成功返回后台 message（可能为空串，由调用方兜底文案） */
export async function gworkSendCode(email: string): Promise<string> {
	await ensureGworkHost()
	const res = await gworkRequest.get<ApiBody>('/api/verification?email=' + encodeURIComponent(email.trim()), null, { anon: true, toast: false, header: sessionHeader() })
	const body = res.data as ApiBody
	const msg = fieldString(body, 'message')
	return msg.length > 0 ? msg : t('gwork.codeSent')
}

/* ---------------- 保活 / 恢复 / 登出 ---------------- */

async function doRefresh(): Promise<GworkSession> {
	const current = session
	if (current == null || current.refreshToken.length === 0 || current.sid.length === 0) {
		throw new Error(t('gwork.notSignedIn'))
	}
	if (current.accessExpiresAt > nowSecs() + REFRESH_LEAD_SECS) {
		return current
	}
	let res: ApiResponse<ApiBody>
	try {
		res = await gworkRequest.post<ApiBody>('/api/user/auth/refresh', null, {
			anon: true,
			toast: false,
			header: sessionHeader({
				'X-Auth-Session': current.sid,
				'Cookie': REFRESH_COOKIE + '=' + current.refreshToken
			})
		})
	} catch (err: any) {
		if (isTerminalAuthError(err)) clearSession()
		throw err
	}
	const data = gworkDataOf(res.data as ApiBody)
	if (fieldString(data, 'access_token').length === 0) {
		throw new Error(t('gwork.refreshNoToken'))
	}
	// 轮换后的新 refresh cookie 必须落盘；服务端没发新的时保留旧值
	const rotated = extractRefreshCookie(res.header as Record<string, any>, res.cookies as string[] | null)
	session = sessionFromData(data, rotated.length > 0 ? rotated : current.refreshToken, current)
	if (session.sid.length === 0) session.sid = current.sid
	if (session.sessionExpiresAt <= 0) session.sessionExpiresAt = current.sessionExpiresAt
	persist()
	return session
}

export function gworkRefresh(): Promise<GworkSession> {
	return serialize<GworkSession>(doRefresh)
}

/** 鉴权请求前调用：临期先刷新；无会话直接抛错 */
export async function ensureFresh(): Promise<GworkSession> {
	if (session == null) throw new Error(t('gwork.notSignedIn'))
	if (session.accessExpiresAt > nowSecs() + REFRESH_LEAD_SECS) return session
	return gworkRefresh()
}

/** 启动恢复：读回会话 → 立即刷新一次 → 失败按错误类型决定清凭据还是保留重试 */
export async function gworkRestore(): Promise<boolean> {
	// 内存里已有会话（登录成功但 App.onLaunch 的异步 restore 才落地）时不得用
	// storage 快照覆盖：H5 冷启动直达业务页时两者会竞态，覆盖会回退刚轮换的凭据
	if (session != null) return signedIn.value
	session = load()
	if (session == null) {
		signedIn.value = false
		return false
	}
	signedIn.value = true
	try {
		await gworkRefresh()
		return true
	} catch (err: any) {
		if (isTerminalAuthError(err)) {
			clearSession()
			return false
		}
		// 网络类失败保留凭据：下次请求临期再刷，不能把用户踢下线
		return session != null
	}
}

/** 退出登录：服务端撤销会话 + 清本地。网络失败也必须清本地，否则重启又恢复成登录态 */
export async function gworkLogout(): Promise<void> {
	return serialize<void>(async (): Promise<void> => {
		const current = session
		if (current != null && current.refreshToken.length > 0) {
			await revokeSessionQuietly(current)
		}
		clearSession()
	})
}

/** 让服务端撤销一份会话，失败一律吞掉（best-effort）。
 *  logout 与登录后的顶替清理共用这一份实现：两处的失败都不该阻塞主流程。 */
async function revokeSessionQuietly(target: GworkSession): Promise<void> {
	try {
		await gworkRequest.post<ApiBody>('/api/user/auth/logout', null, {
			anon: true,
			toast: false,
			header: sessionHeader({
				'X-Auth-Session': target.sid,
				'Cookie': REFRESH_COOKIE + '=' + target.refreshToken,
				'Authorization': 'Bearer ' + target.accessToken
			})
		})
	} catch (_) {
		// 服务端撤销失败不阻塞本地登出；旧会话可能早已失效，被拒属于预期
	}
}

/** 登录后是否该撤销被顶替掉的旧会话（纯判据，便于单测枚举真值表）。
 *
 * 三种情况必须跳过，否则会把刚登录成功的用户自己弄掉线：
 * - 旧 sid 为空：本地从没存过会话（首次登录），无东西可撤；
 * - 旧 sid == 新 sid：后台复用了同一个 Session，撤它就是撤自己；
 * - 旧 refreshToken 为空：logout 靠 Refresh Cookie 定位会话，缺它必然被拒。 */
function shouldRevokeSuperseded(oldSid: string, newSid: string, oldRefreshToken: string): boolean {
	return oldSid.length > 0 && oldSid !== newSid && oldRefreshToken.length > 0
}

/* ---------------- 用户信息 ---------------- */

export type GworkSelf = {
	username: string
	displayName: string
	email: string
	/** 服务端格式化余额串；旧后台未下发时为空串，展示「—」，绝不拿原始 quota 换算 */
	quotaDisplay: string
}

export async function gworkSelf(): Promise<GworkSelf> {
	const s = await ensureFresh()
	let res: ApiResponse<ApiBody>
	try {
		res = await gworkRequest.get<ApiBody>('/api/user/self', null, {
			anon: true,
			toast: false,
			header: sessionHeader({ 'Authorization': 'Bearer ' + s.accessToken })
		})
	} catch (err: any) {
		if (isTerminalAuthError(err)) clearSession()
		throw err
	}
	const data = gworkDataOf(res.data as ApiBody)
	const self: GworkSelf = {
		username: fieldString(data, 'username'),
		displayName: fieldString(data, 'display_name'),
		email: fieldString(data, 'email'),
		quotaDisplay: fieldString(data, 'quota_display')
	}
	if (session != null) {
		if (self.username.length > 0) session.username = self.username
		if (self.displayName.length > 0) session.displayName = self.displayName
		persist()
	}
	return self
}

/** 修改显示名：UpdateSelf 契约要求 username + display_name 一起提交 */
export async function gworkUpdateDisplayName(displayName: string): Promise<void> {
	const s = await ensureFresh()
	try {
		await gworkRequest.put<ApiBody>('/api/user/self', { username: s.username, display_name: displayName }, {
			anon: true,
			toast: false,
			header: sessionHeader({ 'Authorization': 'Bearer ' + s.accessToken })
		})
	} catch (err: any) {
		if (isTerminalAuthError(err)) clearSession()
		throw err
	}
	if (session != null) {
		session.displayName = displayName
		persist()
	}
}

export function gworkSignedIn(): Ref<boolean> {
	return signedIn
}

export function gworkSessionSnapshot(): GworkSession | null {
	return session
}

/* ---------------- 邮箱换绑（step-up 安全流程） ----------------
 * 契约（controller/email_binding.go + service/security_verification.go）：
 * 1. POST /api/verify {method:'password', scope:'account.binding.bind',
 *    context:{provider:'email', email:<新邮箱>}, password} → data.proof_token
 *    （context 必须恰好 provider+email 两个字段，email 服务端会 NormalizeEmail）
 * 2. POST /api/oauth/email/bind/start {email} + X-Security-Proof
 *    → data{flow_token, old_email_required, resend_at, ...}，新旧邮箱验证码都已发出
 * 3. POST /api/oauth/email/bind {flow_token, new_code, old_code}（未绑过邮箱时 old_code 可空）
 * 4. 重发 POST /api/oauth/email/bind/resend {flow_token}
 * 所有请求需 Bearer access token（UserAuth），proof 一次性消费，失败需重新验证。
 */

export type EmailBindFlow = {
	flowToken: string
	oldEmailRequired: boolean
	resendAt: number
	currentEmail: string
}

/** 密码校验（step-up），返回一次性安全凭证；密码加密开启时与登录同一套判定 */
export async function gworkVerifyForEmailBind(email: string, password: string): Promise<string> {
	const s = await ensureFresh()
	const payload: Record<string, any> = {
		method: 'password',
		scope: 'account.binding.bind',
		context: { provider: 'email', email: email.trim() }
	}
	const decision = await loginEncryption()
	if (decision.kind === 'plain') {
		payload['password'] = password
	} else if (decision.kind === 'unavailable') {
		throw new Error(t('gwork.encUnknown') + decision.reason)
	} else {
		// #ifdef WEB
		payload['password_encrypted'] = await encryptPasswordV2Web(password, decision.publicKey, decision.kid)
		payload['encryption_key_id'] = decision.kid
		// #endif
		// #ifndef WEB
		throw new Error(t('gwork.encNativeUnsupported'))
		// #endif
	}
	const res = await gworkRequest.post<ApiBody>('/api/verify', payload, {
		anon: true,
		toast: false,
		header: sessionHeader({ 'Authorization': 'Bearer ' + s.accessToken })
	})
	const proof = fieldString(gworkDataOf(res.data as ApiBody), 'proof_token')
	if (proof.length === 0) throw new Error(t('gwork.verifyFailed'))
	return proof
}

/** 发起换绑：向新旧邮箱发验证码，返回流程令牌 */
export async function gworkEmailBindStart(email: string, proofToken: string): Promise<EmailBindFlow> {
	const s = await ensureFresh()
	const res = await gworkRequest.post<ApiBody>('/api/oauth/email/bind/start', { email: email.trim() }, {
		anon: true,
		toast: false,
		header: sessionHeader({
			'Authorization': 'Bearer ' + s.accessToken,
			'X-Security-Proof': proofToken
		})
	})
	const data = gworkDataOf(res.data as ApiBody)
	const flowToken = fieldString(data, 'flow_token')
	if (flowToken.length === 0) throw new Error(t('gwork.verifyFailed'))
	return {
		flowToken: flowToken,
		oldEmailRequired: data.old_email_required === true,
		resendAt: typeof data.resend_at === 'number' ? data.resend_at as number : 0,
		currentEmail: fieldString(data, 'current_email')
	}
}

/** 提交换绑：oldCode 在未绑过邮箱（oldEmailRequired=false）时可为空 */
export async function gworkEmailBindFinish(flowToken: string, newCode: string, oldCode: string): Promise<void> {
	const s = await ensureFresh()
	await gworkRequest.post<ApiBody>('/api/oauth/email/bind', {
		flow_token: flowToken, new_code: newCode, old_code: oldCode
	}, {
		anon: true,
		toast: false,
		header: sessionHeader({ 'Authorization': 'Bearer ' + s.accessToken })
	})
}

/** 重发换绑验证码（新旧邮箱同时重发），返回新的可重发时间戳 */
export async function gworkEmailBindResend(flowToken: string): Promise<number> {
	const s = await ensureFresh()
	const res = await gworkRequest.post<ApiBody>('/api/oauth/email/bind/resend', { flow_token: flowToken }, {
		anon: true,
		toast: false,
		header: sessionHeader({ 'Authorization': 'Bearer ' + s.accessToken })
	})
	const data = gworkDataOf(res.data as ApiBody)
	return typeof data.resend_at === 'number' ? data.resend_at as number : 0
}