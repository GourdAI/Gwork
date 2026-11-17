/**
 * 首页与对话页共享的静态占位数据。
 *
 * 设备、工作空间、模型、技能、连接器、会话后续都应由接口返回；这里的名称与
 * 描述是演示内容，不是主题色；技能 / 连接器的标识色属于内容色（与头像同理），
 * 不参与亮暗主题切换，因此保留在后端数据位置而不是 $theme-palette。
 */

export type DeviceOption = {
	name: string
	online: boolean
	note: string
}

export type WorkspaceOption = {
	name: string
}

export type PermissionOption = {
	name: string
	desc: string
	danger: boolean
}

export type ModelOption = {
	name: string
	desc: string
}

export type LevelOption = {
	name: string
	desc: string
}

export type SkillOption = {
	name: string
	desc: string
	badge: string
	color: string
}

export type ConnectorOption = {
	name: string
	desc: string
	enabled: boolean
	color: string
	icon: string
}

/** AI 消息生命周期（对齐 uni-ai-x 会话状态机）：流式输出中 / 正常完成 / 用户手动停止 */
export type ChatMsgStatus = 'processing' | 'done' | 'stopped'

/** 会话内单条消息；meta 为设计稿 AI 气泡底部的状态行（如「已完成 2 秒」）。
	status / thinking 仅 AI 消息消费：thinking 为真表示思考中（尚未吐正文），渲染 loading */
export type ChatMessage = {
	id: string
	role: 'user' | 'ai'
	text: string
	meta: string
	status: ChatMsgStatus
	thinking: boolean
}

export type Conversation = {
	id: string
	title: string
	workspace: string
	pinned: boolean
	updatedAt: number
	messages: ChatMessage[]
}

/** 会话产出文件；icon 决定卡片占位图标（doc=文档类，image=图片类），详情字段待接口定义 */
export type ArtifactFile = {
	name: string
	kind: string
	icon: 'doc' | 'image'
	size: string
}

export const DEFAULT_WORKSPACE: string = '对话'

export const DEVICES: DeviceOption[] = [
	{ name: 'MacBook', online: true, note: '' },
	{ name: 'MacBook Pro 16', online: true, note: '' },
	{ name: 'iMac Studio', online: false, note: '上次连接 2 天前' },
	{ name: 'Windows 工作站', online: true, note: '' }
]

export const WORKSPACES: WorkspaceOption[] = [
	{ name: DEFAULT_WORKSPACE },
	{ name: '2026-08-15-16-14-35' },
	{ name: '助理' }
]

export const PERMISSIONS: PermissionOption[] = [
	{ name: '默认权限', desc: '仅可访问当前工作空间内的文件', danger: false },
	{ name: '允许完全访问', desc: '可读写本机文件并执行命令', danger: true }
]

export const MODELS: ModelOption[] = [
	{ name: 'Hy4', desc: '腾讯混元 · 综合能力强' },
	{ name: 'Claude 4.5 Sonnet', desc: 'Anthropic · 擅长代码与长文' },
	{ name: 'GPT-5', desc: 'OpenAI · 通用推理' },
	{ name: 'DeepSeek V3', desc: 'DeepSeek · 高性价比' }
]

export const THINK_LEVELS: LevelOption[] = [
	{ name: '低', desc: '快速响应，几乎不额外推理' },
	{ name: '中', desc: '常规任务，速度与质量平衡' },
	{ name: '高', desc: '复杂任务，深度推理更准确' }
]

export const CONTEXT_WINDOWS: LevelOption[] = [
	{ name: '32K', desc: '短对话，响应更快' },
	{ name: '128K', desc: '常规长文档与多轮对话' },
	{ name: '300K', desc: '超长上下文，适合大型资料' },
	{ name: '1M', desc: '最大窗口，适合整库级上下文' }
]

export const SKILLS: SkillOption[] = [
	{ name: '需求PRD转产品原型', desc: '需求PRD到产品原型 prd-to-prototype', badge: '需', color: '#b8860b' },
	{ name: 'AI交付前全自动自检技能', desc: 'AI交付前全自动自检技能。任何一次向用户交付前自动校验', badge: 'A', color: '#2f8f5b' },
	{ name: '合同条款审查与修订', desc: '站在指定一方立场修订不利条款，再做交叉矛盾检查', badge: '合', color: '#6b5bd2' },
	{ name: 'B站评论分析', desc: '输入B站视频链接获取一级评论，支持分页与情感分析', badge: 'B', color: '#6b5bd2' },
	{ name: '市场调研', desc: '提供市场分析、消费者洞察与竞品对比', badge: '市', color: '#4a8f4a' }
]

export const CONNECTORS: ConnectorOption[] = [
	{ name: '腾讯会议', desc: '通过命令行创建、查询和管理腾讯会议。', enabled: true, color: '#2f7df6', icon: 'camera' },
	{ name: '腾讯文档', desc: '创建、编辑和协作腾讯文档。用 AI 自动化处理文档。', enabled: false, color: '#2f7df6', icon: 'file' },
	{ name: 'MasterGo 莫高设计', desc: '连接 MasterGo 画布，让 AI 进入设计流程。', enabled: false, color: '#4f8cff', icon: 'mountain' }
]

/** 账号身份：个人账号 / 企业账号（「我的」与账号设置按它切换文案与徽标） */
export type IdentityType = 'personal' | 'enterprise'

/** 企业认证状态：ok 可直接进入；pending / fail / 未购套餐 只能弹提示（原型 ENT_ALERTS 三种受阻态） */
export type EnterpriseStatus = 'ok' | 'pending' | 'fail'

export type EnterpriseAccount = {
	name: string
	role: string
	status: EnterpriseStatus
	pkg: boolean
}

/** 当前账号已加入的企业；名称与角色是内容数据（同工作区命名），提示文案在 locale */
export const ENTERPRISES: EnterpriseAccount[] = [
	{ name: 'GWork 科技', role: '管理员', status: 'ok', pkg: true },
	{ name: '星辰传媒', role: '成员', status: 'pending', pkg: true },
	{ name: '蓝鲸制造', role: '成员', status: 'fail', pkg: false }
]

/** 演示产物清单：接口接入前对所有会话展示同一份（设计稿 S3 弹层示例数据） */
export const ARTIFACTS: ArtifactFile[] = [
	{ name: '信息架构梳理.md', kind: 'MD', icon: 'doc', size: '12.4 KB' },
	{ name: '首页与侧栏结构图.png', kind: 'PNG', icon: 'image', size: '2.4 MB' },
	{ name: 'gwork-mobile-v3.html', kind: 'HTML', icon: 'doc', size: '318.3 KB' }
]
