/**
 * 当前登录用户的跨页面共享状态。
 *
 * 「我的」、账号设置、换绑邮箱与会话抽屉底栏共用同一份；模块级单例 ref，
 * 与 useRunEnv 同一模式，无需 provide / inject。接口接入后改为启动时拉取。
 */
import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { ENTERPRISES } from '@/data/app-data'
import type { EnterpriseAccount, IdentityType } from '@/data/app-data'

const name: Ref<string> = ref<string>('Tila')
const email: Ref<string> = ref<string>('tila@gwork.com')
const points: Ref<string> = ref<string>('2000.00')
const avatar: Ref<string> = ref<string>('/static/avatar-default.png')
const idType: Ref<IdentityType> = ref<IdentityType>('personal')
const enterprise: Ref<string> = ref<string>('')

/** 企业身份下的角色；个人身份没有角色徽标，返回空串 */
const role: ComputedRef<string> = computed<string>((): string => {
	if (idType.value !== 'enterprise') return ''
	const found: EnterpriseAccount | undefined = ENTERPRISES.find((item: EnterpriseAccount): boolean => item.name === enterprise.value)
	return found?.role ?? ''
})

function setName(value: string): void {
	name.value = value
}

function setEmail(value: string): void {
	email.value = value
}

function setAvatar(value: string): void {
	avatar.value = value
}

function switchToPersonal(): void {
	idType.value = 'personal'
	enterprise.value = ''
}

/** 返回 false 表示企业受阻（认证中 / 未认证 / 未购套餐），由调用方弹提示 */
function switchToEnterprise(entName: string): boolean {
	const found: EnterpriseAccount | undefined = ENTERPRISES.find((item: EnterpriseAccount): boolean => item.name === entName)
	if (found == null) return false
	if (found.status !== 'ok' || !found.pkg) return false
	idType.value = 'enterprise'
	enterprise.value = found.name
	return true
}

export type User = {
	name: Ref<string>
	email: Ref<string>
	points: Ref<string>
	avatar: Ref<string>
	idType: Ref<IdentityType>
	enterprise: Ref<string>
	role: ComputedRef<string>
	setName: (value: string) => void
	setEmail: (value: string) => void
	setAvatar: (value: string) => void
	switchToPersonal: () => void
	switchToEnterprise: (entName: string) => boolean
}

export function useUser(): User {
	return {
		name,
		email,
		points,
		avatar,
		idType,
		enterprise,
		role,
		setName,
		setEmail,
		setAvatar,
		switchToPersonal,
		switchToEnterprise
	}
}
