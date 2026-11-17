import { ref, watch, onUnmounted } from 'vue'
import type { Ref } from 'vue'

/**
 * rice-popup / rice-dialog 关闭动画期内重开会被其内部状态机吞掉：
 * close() 靠定时器在动画结束后才落 realShow=false，期间 show 翻回 true 时 open()
 * 因 realShow 仍为 true 提前返回，之后 show 不再变化、watch 不再触发，弹层永久打不开。
 * 这里不把 visible 直传弹层：距上次关闭不足一个动画周期时延迟拉起，错开其内部关闭定时器。
 */
export function useDelayedPopup(visible: () => boolean, animMs: number): { popupShow: Ref<boolean> } {
	const popupShow: Ref<boolean> = ref<boolean>(false)
	let closeAt: number = 0
	let openTimer: number = -1

	watch(visible, (val: boolean): void => {
		if (openTimer !== -1) {
			clearTimeout(openTimer)
			openTimer = -1
		}
		if (!val) {
			closeAt = Date.now()
			popupShow.value = false
			return
		}
		const wait: number = Math.max(0, animMs - (Date.now() - closeAt))
		if (wait === 0) {
			popupShow.value = true
			return
		}
		// 等待期间再次关闭时丢弃这次迟到的拉起
		openTimer = setTimeout((): void => {
			openTimer = -1
			if (visible()) popupShow.value = true
		}, wait)
	}, { immediate: true })

	onUnmounted((): void => {
		if (openTimer !== -1) clearTimeout(openTimer)
	})

	return { popupShow }
}
