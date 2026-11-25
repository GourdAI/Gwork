/**
 * 工作区清单的跨页面共享状态（模块级单例，与 useTheme 同一模式）。
 *
 * 契约 §4（已修订）：工作区清单权威来源 = GET /web/chat/projects
 * （桌面注册的项目，data:[{name,path,createdAt}]），name=桌面给的展示名、
 * path=绝对路径；sessions 的 projectRoot 去重只作兜底补充。
 * 全局「对话」区固定占首位（root=''）。
 * 由会话层刷新时拉取回写，run-sheet / conv-drawer 只读消费，避免双源。
 */
import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { i18n } from '@/locale/i18n.ts'
import { DEFAULT_WORKSPACE } from '@/data/app-data'
import type { WorkspaceOption } from '@/data/app-data'

/** 项目工作区（不含全局「对话」区），name=basename、root=绝对路径 */
const projectWorkspaces: Ref<WorkspaceOption[]> = ref<WorkspaceOption[]>([])

/** 当前工作区键：DEFAULT_WORKSPACE=全局区，其余为项目绝对路径。
 *  语义 = 「新对话的默认工作空间」，选择入口在新对话输入区（composer chip），
 *  侧栏只浏览/展开，不再充当选择器；每次新建对话后由 beginNewSession 复位回全局区。 */
const currentWorkspace: Ref<string> = ref<string>(DEFAULT_WORKSPACE)

export function workspaceLabel(key: string): string {
	if (key === DEFAULT_WORKSPACE) return i18n.global.t('conv.title')
	return basenameOf(key)
}

export function basenameOf(root: string): string {
	const trimmed: string = root.replace(/[\\/]+$/, '')
	const idx: number = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
	const name: string = idx >= 0 ? trimmed.slice(idx + 1) : trimmed
	return name.length > 0 ? name : root
}

/** 会话层回写：权威清单来自 /web/chat/projects（name+path）；
 * sessions 里出现但项目清单没有的 root 作兜底补充（basename 展示）。
 *
 * keepCurrent=true 时只刷新清单、不动当前选中项：refreshConversations 会先用
 * 「只有 named、没有 roots」预置一次清单，若此时就做回落判断，任何一次
 * /web/chat/projects 抖动都会把用户刚选的工作区悄悄打回全局区，
 * 表现为「选了工作空间，侧栏里那个工作区连同任务一起不见了」。
 * 回落只在带完整信息（权威清单 + 会话 root 全量）的收尾调用里做。 */
export function setProjectRoots(roots: string[], named?: WorkspaceOption[], keepCurrent: boolean = false): void {
	const seen: Set<string> = new Set<string>()
	const list: WorkspaceOption[] = []
	// 成功但返回空数组 ≠ 拉取失败：refreshConversations 会先用「只有 named、没有 roots」
	// 预置一次清单（keepCurrent=true）。旧实现在那一趟就把清单清空，收尾再用空
	// namedFinal 把当前工作区打回全局区 →「选了工作空间，侧栏里那个工作区连同任务消失」。
	// 预置阶段若权威清单为空且没有 sessions 兜底 root，先保留上一轮清单不做任何判断。
	if (keepCurrent && roots.length === 0 && (named == null || named.length === 0)) return
	if (named != null) {
		for (let i = 0; i < named.length; i++) {
			const item: WorkspaceOption = named[i]
			if (item.root.length === 0 || seen.has(item.root)) continue
			seen.add(item.root)
			list.push({ name: item.name.length > 0 ? item.name : basenameOf(item.root), root: item.root })
		}
	}
	for (let i = 0; i < roots.length; i++) {
		const root: string = roots[i]
		if (root.length === 0 || seen.has(root)) continue
		seen.add(root)
		list.push({ name: basenameOf(root), root: root })
	}
	projectWorkspaces.value = list
	if (keepCurrent) return
	// 当前选中的工作区已不在清单（桌面移除/换设备）：回落全局区，避免新对话挂到不存在的根
	if (currentWorkspace.value !== DEFAULT_WORKSPACE && !seen.has(currentWorkspace.value)) {
		currentWorkspace.value = DEFAULT_WORKSPACE
	}
}

/** 设备切换/登出：清「清单 + 当前回显」，新对话默认回全局区。 */
export function clearWorkspaces(): void {
	projectWorkspaces.value = []
	currentWorkspace.value = DEFAULT_WORKSPACE
}

export type Workspaces = {
	/** 全部工作区：全局「对话」区固定首位 + 项目区 */
	workspaces: ComputedRef<WorkspaceOption[]>
	projects: Ref<WorkspaceOption[]>
	current: Ref<string>
	setCurrent: (key: string) => void
}

export function useWorkspaces(): Workspaces {
	const workspaces: ComputedRef<WorkspaceOption[]> = computed<WorkspaceOption[]>((): WorkspaceOption[] => {
		const global: WorkspaceOption = { name: i18n.global.t('conv.title'), root: '' }
		return [global].concat(projectWorkspaces.value.map((item: WorkspaceOption): WorkspaceOption => {
			return { name: item.name.length > 0 ? item.name : basenameOf(item.root), root: item.root }
		}))
	})

	function setCurrent(key: string): void {
		currentWorkspace.value = key.length === 0 ? DEFAULT_WORKSPACE : key
	}

	return { workspaces, projects: projectWorkspaces, current: currentWorkspace, setCurrent }
}
