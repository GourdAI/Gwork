package uts.sdk.modules.gworkSpeech

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

/**
 * Android 系统语音识别会话（UTS 原生混编，Kotlin 直调 SpeechRecognizer）。
 *
 * 为什么用混编而不是纯 UTS：
 * 1. SpeechRecognizer 全部方法必须主线程调用，Kotlin 内显式 Handler(mainLooper) 保证；
 * 2. RecognitionListener 有 10 个回调（含 API 33 新增 default 方法），Kotlin object 实现
 *    只覆写需要的即可，规避 UTS implements 的编译期差异；
 * 3. 静音容忍 extra 必须 Long 类型，Kotlin 字面量直接保证。
 *
 * 会话终态（onResult/onError）至多派发一次（finished 守卫）；cancel 后迟到的原生回调被丢弃。
 * 权限申请在 UTS 侧（UTSAndroid.requestSystemPermission），本类只处理已授权后的会话。
 */
object GworkSpeechSession {
	private val main = Handler(Looper.getMainLooper())
	private var recognizer: SpeechRecognizer? = null
	private var onPartial: ((String) -> Unit)? = null
	private var onResult: ((String) -> Unit)? = null
	private var onError: ((String, String) -> Unit)? = null

	private var finished = true
	private var stopping = false
	private var lastPartial = ""
	private var maxRunnable: Runnable? = null
	private var stopRunnable: Runnable? = null

	/** 设备是否具备系统识别能力（Android 11+ 需 manifest queries 声明，见插件 AndroidManifest.xml） */
	@JvmStatic
	fun available(context: Context): Boolean {
		return try {
			SpeechRecognizer.isRecognitionAvailable(context)
		} catch (e: Throwable) {
			false
		}
	}

	@JvmStatic
	fun start(context: Context, language: String, maxDurationMs: Long,
			  partial: (String) -> Unit, result: (String) -> Unit, error: (String, String) -> Unit) {
		main.post {
			if (!finished) {
				error("busy", "previous session active")
				return@post
			}
			onPartial = partial
			onResult = result
			onError = error
			finished = false
			stopping = false
			lastPartial = ""
			try {
				val r = SpeechRecognizer.createSpeechRecognizer(context.applicationContext)
				recognizer = r
				r.setRecognitionListener(listener)
				val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
				intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
				intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
				intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
				// 按住说话场景：静音容忍调短（必须 Long，Int 会被引擎忽略）
				intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L)
				intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1000L)
				intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
				r.startListening(intent)
			} catch (e: Throwable) {
				emitError("unknown", "start failed: ${e.message}")
				return@post
			}
			// 单段上限：到时按正常收尾（有中间结果给结果，没有给 no-match）
			val max = Runnable { stop() }
			maxRunnable = max
			main.postDelayed(max, maxDurationMs)
		}
	}

	@JvmStatic
	fun stop() {
		main.post {
			if (finished || stopping) return@post
			stopping = true
			clearTimers()
			val r = recognizer
			if (r == null) {
				emitResult(lastPartial)
				return@post
			}
			try {
				r.stopListening()
			} catch (e: Throwable) {
				emitResult(lastPartial)
				return@post
			}
			// 引擎收尾兜底：3 秒内没有 onResults/onError，按已有中间结果落地，绝不悬挂
			val fallback = Runnable {
				if (finished) return@Runnable
				if (lastPartial.isNotEmpty()) emitResult(lastPartial)
				else emitError("timeout", "stop timeout without results")
			}
			stopRunnable = fallback
			main.postDelayed(fallback, 3000)
		}
	}

	@JvmStatic
	fun cancel() {
		main.post {
			if (finished) return@post
			finished = true
			clearTimers()
			val r = recognizer
			recognizer = null
			clearCallbacks()
			try {
				r?.cancel()
				r?.destroy()
			} catch (e: Throwable) {
			}
		}
	}

	private val listener = object : RecognitionListener {
		override fun onReadyForSpeech(params: Bundle?) {}
		override fun onBeginningOfSpeech() {}
		override fun onRmsChanged(rmsdB: Float) {}
		override fun onBufferReceived(buffer: ByteArray?) {}
		override fun onEndOfSpeech() {}
		override fun onEvent(eventType: Int, params: Bundle?) {}

		override fun onPartialResults(partialResults: Bundle?) {
			if (finished) return
			val text = firstMatch(partialResults)
			if (text.isEmpty()) return
			lastPartial = text
			onPartial?.invoke(text)
		}

		override fun onResults(results: Bundle?) {
			if (finished) return
			val text = firstMatch(results)
			emitResult(if (text.isNotEmpty()) text else lastPartial)
		}

		override fun onError(error: Int) {
			if (finished) return
			// 已收尾阶段：no-match/自发结束都按「结果落地」而非报错（用户说过话给中间结果）
			if (stopping && lastPartial.isNotEmpty()) {
				emitResult(lastPartial)
				return
			}
			val code = mapError(error)
			if (stopping && code == "no-match") {
				emitResult("")
				return
			}
			emitError(code, "SpeechRecognizer error $error")
		}
	}

	private fun firstMatch(results: Bundle?): String {
		if (results == null) return ""
		val list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
		if (list == null || list.isEmpty()) return ""
		return list[0] ?: ""
	}

	private fun mapError(error: Int): String {
		return when (error) {
			SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "no-match"
			SpeechRecognizer.ERROR_AUDIO, SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "permission"
			SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER -> "network"
			else -> "unknown"
		}
	}

	private fun emitResult(text: String) {
		if (finished) return
		finished = true
		clearTimers()
		destroyRecognizer()
		val cb = onResult
		clearCallbacks()
		cb?.invoke(text)
	}

	private fun emitError(code: String, detail: String) {
		if (finished) return
		finished = true
		clearTimers()
		destroyRecognizer()
		val cb = onError
		clearCallbacks()
		cb?.invoke(code, detail)
	}

	private fun clearTimers() {
		maxRunnable?.let { main.removeCallbacks(it) }
		maxRunnable = null
		stopRunnable?.let { main.removeCallbacks(it) }
		stopRunnable = null
	}

	private fun destroyRecognizer() {
		val r = recognizer
		recognizer = null
		try {
			r?.destroy()
		} catch (e: Throwable) {
		}
	}

	private fun clearCallbacks() {
		onPartial = null
		onResult = null
		onError = null
	}
}