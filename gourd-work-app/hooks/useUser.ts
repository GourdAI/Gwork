/**
 * 当前登录用户的跨页面共享状态。
 *
 * 「我的」、账号设置、换绑邮箱与会话抽屉底栏共用同一份；模块级单例 ref，
 * 与 useRunEnv 同一模式，无需 provide / inject。
 *
 * 账号数据来自 GWork 官方后台（utils/gwork-auth.ts）：
 * - 登录成功 / 启动恢复后调 refreshUserFromAccount() 拉取 GetSelf 回写；
 * - 余额只认服务端格式化串 quota_display（桌面端同款纪律）：原始 quota 整数
 *   既不是金额也不是可读余额，客户端绝不自行换算；旧后台未下发时显示「—」。
 * - 账号均为个人身份（产品无企业账号体系）。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import { gworkSelf, gworkUpdateDisplayName, gworkSignedIn } from '@/utils/gwork-auth.ts'
import type { GworkSelf } from '@/utils/gwork-auth.ts'

const DEFAULT_AVATAR = '/static/avatar-default.png'

const name: Ref<string> = ref<string>('')
const email: Ref<string> = ref<string>('')
const points: Ref<string> = ref<string>('—')
const avatar: Ref<string> = ref<string>(DEFAULT_AVATAR)

/** GetSelf 回写共享状态；displayName 缺省回落 username（与后台 web 端同规则） */
function applySelf(self: GworkSelf): void {
	name.value = self.displayName.length > 0 ? self.displayName : self.username
	email.value = self.email
	points.value = self.quotaDisplay.length > 0 ? self.quotaDisplay : '—'
}

/** 登录成功 / 会话恢复后调用：拉取用户信息回写；失败静默（余额保持「—」，不阻塞页面） */
export function refreshUserFromAccount(): void {
	if (!gworkSignedIn().value) return
	gworkSelf().then((self: GworkSelf): void => {
		applySelf(self)
	}, (): void => { })
}

/** 退出登录后清空共享状态，避免下个账号看到上一个账号的资料 */
export function resetUser(): void {
	name.value = ''
	email.value = ''
	points.value = '—'
	avatar.value = DEFAULT_AVATAR
}

function setAvatar(value: string): void {
	avatar.value = value
}

/** 修改显示名：真实调用后台 UpdateSelf，成功后回写共享状态；失败 reject 由页面提示 */
async function updateDisplayName(value: string): Promise<void> {
	await gworkUpdateDisplayName(value)
	name.value = value
}

export type User = {
	name: Ref<string>
	email: Ref<string>
	points: Ref<string>
	avatar: Ref<string>
	setAvatar: (value: string) => void
	updateDisplayName: (value: string) => Promise<void>
}

export function useUser(): User {
	return {
		name,
		email,
		points,
		avatar,
		setAvatar,
		updateDisplayName
	}
}