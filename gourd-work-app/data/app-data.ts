/**
 * 首页与对话页共享的数据类型与剩余静态占位数据。
 *
 * 设备 / 工作区 / 模型 / 会话已接真实链路（hooks/useDevices、useRunEnv、useConversations）；
 * 权限、技能、连接器仍为演示内容。技能 / 连接器的标识色属于内容色（与头像同理），
 * 不参与亮暗主题切换，因此保留在后端数据位置而不是 $theme-palette。
 */

export type DeviceOption = {
	/** 后台设备 id（dev-xxxxxxxx）；未登录/无设备时为空串 */
	deviceId: string
	name: string
	online: boolean
	note: string
	/** 毫秒时间戳，最后在线时刻（契约 §1.1 lastSeen）；0=未知 */
	lastSeen: number
}

export type WorkspaceOption = {
	/** 展示名：项目工作区为路径 basename，全局「对话」区为 i18n 文案 */
	name: string
	/** 工作区绝对路径；空串=全局「对话」区（sessions?root= 空） */
	root: string
}

export type PermissionOption = {
	name: string
	desc: string
	danger: boolean
}

export type ModelOption = {
	/** 内核模型标识（POST models/select 的 modelName 字段） */
	model: string
	name: string
	desc: string
	/** 该模型可选的思考深度码（内核 thinkingLevels，空=不支持选择） */
	thinkingLevels: string[]
}

export type LevelOption = {
	/** 展示名（i18n 文案或格式化窗口大小） */
	name: string
	/** 提交给内核的原始值：思考深度码（low/medium/...）或上下文 token 数串 */
	value: string
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

/** 全局「对话」区的内部键：不落 UI（展示名走 i18n conv.title），也是 root='' 的映射键。
 * 不能用展示文案当键：切换语言后所有比对会失配 */
export const DEFAULT_WORKSPACE: string = '__chat__'

export const PERMISSIONS: PermissionOption[] = [
	{ name: '默认权限', desc: '仅可访问当前工作空间内的文件', danger: false },
	{ name: '允许完全访问', desc: '可读写本机文件并执行命令', danger: true }
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

/** 演示产物清单：接口接入前对所有会话展示同一份（设计稿 S3 弹层示例数据） */
export const ARTIFACTS: ArtifactFile[] = [
	{ name: '信息架构梳理.md', kind: 'MD', icon: 'doc', size: '12.4 KB' },
	{ name: '首页与侧栏结构图.png', kind: 'PNG', icon: 'image', size: '2.4 MB' },
	{ name: 'gwork-mobile-v3.html', kind: 'HTML', icon: 'doc', size: '318.3 KB' }
]
