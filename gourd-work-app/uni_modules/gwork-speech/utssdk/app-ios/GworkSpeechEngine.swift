import Foundation
import Speech
import AVFoundation

/// gwork-speech iOS 原生引擎（UTS 原生混编）。
/// 闭包桥接：start 传入的 partial/result/error 三个回调由本类持有并派发，
/// UTS 侧只做会话状态与统一错误码管理。所有终态回调至多派发一次（finished 守卫）。
public class GworkSpeechEngine {
	private var recognizer: SFSpeechRecognizer?
	private var request: SFSpeechAudioBufferRecognitionRequest?
	private var task: SFSpeechRecognitionTask?
	private var audioEngine: AVAudioEngine?

	private var onPartial: ((String) -> Void)?
	private var onResult: ((String) -> Void)?
	private var onError: ((String, String) -> Void)?

	private var finished = true
	private var stopping = false
	/// 当前 audioEngine 是否已 installTap：保证 removeTap 恰好一次（二次 remove 会抛 NSException）
	private var tapInstalled = false
	private var lastPartial = ""
	private var stopTimer: DispatchWorkItem?
	/// 会话代号：权限弹窗期间用户松手取消后，迟到的授权回调不得再启动引擎
	private var sessionToken = 0

	public init() {}

	/// 系统是否具备语音识别能力：按应用识别语言探测，设备不支持该语言时直接 false，
	/// 业务层隐藏语音入口而非点击报错。
	/// 只验 locale 支持、不验 isAvailable——后者反映瞬时状态（断网时非端侧语言为 false），
	/// 若据其隐藏入口，恢复网络后入口也回不来；瞬时不可用由 start 时再验并报错
	public func available(language: String) -> Bool {
		return SFSpeechRecognizer(locale: Locale(identifier: language)) != nil
	}

	/// 申请识别 + 麦克风权限后开始实时识别。
	/// onError 第一参为语义码：permission / unsupported / network / no-match / unknown
	public func start(language: String,
					  onPartial: @escaping (String) -> Void,
					  onResult: @escaping (String) -> Void,
					  onError: @escaping (String, String) -> Void) {
		// UTS 调用可能来自非主线程；全部状态读写与 AVAudioEngine 操作统一收敛主线程
		if !Thread.isMainThread {
			DispatchQueue.main.async {
				self.start(language: language, onPartial: onPartial, onResult: onResult, onError: onError)
			}
			return
		}
		guard finished else {
			onError("busy", "previous session active")
			return
		}
		sessionToken += 1
		let token = sessionToken
		SFSpeechRecognizer.requestAuthorization { [weak self] status in
			DispatchQueue.main.async {
				guard let self = self, token == self.sessionToken else { return }
				guard status == .authorized else {
					onError("permission", "speech authorization \(status.rawValue)")
					return
				}
				AVAudioSession.sharedInstance().requestRecordPermission { granted in
					DispatchQueue.main.async {
						guard token == self.sessionToken else { return }
						guard granted else {
							onError("permission", "microphone denied")
							return
						}
						self.beginSession(language: language, onPartial: onPartial, onResult: onResult, onError: onError)
					}
				}
			}
		}
	}

	private func beginSession(language: String,
							  onPartial: @escaping (String) -> Void,
							  onResult: @escaping (String) -> Void,
							  onError: @escaping (String, String) -> Void) {
		guard finished else {
			onError("busy", "previous session active")
			return
		}
		guard let rec = SFSpeechRecognizer(locale: Locale(identifier: language)) else {
			onError("unsupported", "locale unsupported: \(language)")
			return
		}
		// isAvailable 是瞬时状态（断网/服务抖动）：归 network 可重试，
		// 不能归 unsupported——那会让业务层永久隐藏语音入口
		guard rec.isAvailable else {
			onError("network", "recognizer temporarily unavailable")
			return
		}
		self.onPartial = onPartial
		self.onResult = onResult
		self.onError = onError
		finished = false
		stopping = false
		lastPartial = ""
		recognizer = rec

		do {
			let session = AVAudioSession.sharedInstance()
			try session.setCategory(.record, mode: .measurement, options: .duckOthers)
			try session.setActive(true, options: .notifyOthersOnDeactivation)

			let req = SFSpeechAudioBufferRecognitionRequest()
			req.shouldReportPartialResults = true
			// iOS 13+ 支持端侧的语言优先端侧：不占服务器配额、音频不出设备
			if #available(iOS 13.0, *), rec.supportsOnDeviceRecognition {
				req.requiresOnDeviceRecognition = true
			}
			request = req

			let engine = AVAudioEngine()
			audioEngine = engine
			let inputNode = engine.inputNode
			let format = inputNode.outputFormat(forBus: 0)
			inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
				self?.request?.append(buffer)
			}
			tapInstalled = true
			engine.prepare()
			try engine.start()

			task = rec.recognitionTask(with: req) { [weak self] result, error in
				DispatchQueue.main.async {
					self?.handleRecognition(result: result, error: error)
				}
			}
		} catch {
			emitError(code: "unknown", detail: "audio engine start failed: \(error.localizedDescription)")
		}
	}

	private func handleRecognition(result: SFSpeechRecognitionResult?, error: Error?) {
		guard !finished else { return }
		if let result = result {
			let text = result.bestTranscription.formattedString
			if result.isFinal {
				emitResult(text: text)
				return
			}
			if !text.isEmpty {
				lastPartial = text
				onPartial?(text)
			}
		}
		if let error = error as NSError? {
			// 收尾阶段报错但已有中间结果：按结果落地，避免「说了话却报错」
			if stopping && !lastPartial.isEmpty {
				emitResult(text: lastPartial)
				return
			}
			// kAFAssistantErrorDomain 1110 = no speech detected（没听到内容）
			if error.code == 1110 && error.domain == "kAFAssistantErrorDomain" {
				emitResult(text: "")
				return
			}
			// 216/209 = 请求被取消/音频无内容（cancel/endAudio 伴随噪声）：
			// 收尾阶段按结果落地，非收尾阶段静默按没听清，绝不当网络错误打扰
			if error.domain == "kAFAssistantErrorDomain" && (error.code == 216 || error.code == 209) {
				emitResult(text: lastPartial)
				return
			}
			var code = "unknown"
			if error.domain == "kLSRErrorDomain" || error.domain == "kAFAssistantErrorDomain" {
				code = "network"
			}
			emitError(code: code, detail: "\(error.domain) \(error.code) \(error.localizedDescription)")
		}
	}

	/// 停止采集并 endAudio，等 Speech 框架回最终结果；3 秒兜底绝不悬挂
	public func stop() {
		if !Thread.isMainThread {
			DispatchQueue.main.async { self.stop() }
			return
		}
		guard !finished, !stopping else { return }
		stopping = true
		audioEngine?.stop()
		removeTapSafely()
		request?.endAudio()
		let work = DispatchWorkItem { [weak self] in
			guard let self = self, !self.finished else { return }
			if !self.lastPartial.isEmpty {
				self.emitResult(text: self.lastPartial)
			} else {
				self.emitError(code: "timeout", detail: "stop timeout without final result")
			}
		}
		stopTimer = work
		DispatchQueue.main.asyncAfter(deadline: .now() + 3.0, execute: work)
	}

	/// 静默放弃：不派发任何回调（权限弹窗期间的取消也令迟到的授权链失效）
	public func cancel() {
		if !Thread.isMainThread {
			DispatchQueue.main.async { self.cancel() }
			return
		}
		sessionToken += 1
		guard !finished else { return }
		finished = true
		clearStopTimer()
		teardownAudio()
		task?.cancel()
		task = nil
		recognizer = nil
		onPartial = nil
		onResult = nil
		onError = nil
	}

	private func emitResult(text: String) {
		guard !finished else { return }
		finished = true
		clearStopTimer()
		teardownAudio()
		task?.finish()
		task = nil
		recognizer = nil
		let cb = onResult
		onPartial = nil
		onResult = nil
		onError = nil
		cb?(text)
	}

	private func emitError(code: String, detail: String) {
		guard !finished else { return }
		finished = true
		clearStopTimer()
		teardownAudio()
		task?.cancel()
		task = nil
		recognizer = nil
		let cb = onError
		onPartial = nil
		onResult = nil
		onError = nil
		cb?(code, detail)
	}

	private func clearStopTimer() {
		stopTimer?.cancel()
		stopTimer = nil
	}

	private func teardownAudio() {
		if let engine = audioEngine {
			engine.stop()
			removeTapSafely()
		}
		audioEngine = nil
		request = nil
		try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
	}

	/// removeTap 幂等化：stop() 已移除过 tap 时二次 remove 在部分 iOS 版本会抛
	/// NSException（required condition is false: nullptr == Tap()）且 Swift 无法 catch，
	/// 用 tapInstalled 标记保证每个 engine 实例恰好 remove 一次
	private func removeTapSafely() {
		guard let engine = audioEngine else { return }
		if tapInstalled {
			tapInstalled = false
			engine.inputNode.removeTap(onBus: 0)
		}
	}
}