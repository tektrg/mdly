// mdly-writing-helper: Apple's on-device model (FoundationModels) for the
// writing tools ("the dot"). Lives at Contents/MacOS in the app, is started
// once by Electron main and kept alive. Protocol: one JSON object per line.
//
//   in : {"id":"1","op":"availability"}
//        {"id":"2","op":"prewarm"}
//        {"id":"3","op":"run","prompt":"...","maxTokens":1024,"locale":"vi"}
//        {"id":"4","op":"cancel","target":"3"}
//   out: {"id":"1","ok":true,"availability":"available"}
//        {"id":"3","ok":true,"text":"..."}
//        {"id":"3","ok":false,"code":"unsupported-language","error":"..."}
//
// `--availability` prints the availability line and exits 0 (install check).
// `--languages` prints the model's supported languages and exits 0.
// A run's optional `locale` (the selection's language) is checked with
// `supportsLocale`; unsupported answers `unsupported-language`, so the app
// routes the tool to the agent.
// Weak-linked against FoundationModels so it still starts (and reports
// `unsupported-os`) on macOS before 26.
import Foundation

#if canImport(FoundationModels)
	import FoundationModels
#endif

let instructions = """
	You are a careful writing assistant inside a Markdown editor. \
	Follow the user's instruction for the text between the markers. \
	Keep Markdown formatting. Reply with only the rewritten text.
	"""

func availability() -> String {
	#if canImport(FoundationModels)
		if #available(macOS 26.0, *) {
			switch SystemLanguageModel.default.availability {
			case .available:
				return SystemLanguageModel.default.supportsLocale()
					? "available" : "unsupported-language"
			case .unavailable(.appleIntelligenceNotEnabled):
				return "apple-intelligence-off"
			case .unavailable(.deviceNotEligible):
				return "not-eligible"
			case .unavailable(.modelNotReady):
				return "model-not-ready"
			case .unavailable:
				return "unavailable"
			}
		}
	#endif
	return "unsupported-os"
}

let out = FileHandle.standardOutput
let outLock = NSLock()
func send(_ object: [String: Any]) {
	guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
	outLock.lock()
	out.write(data)
	out.write(Data([0x0A]))
	outLock.unlock()
}

func supportedLanguages() -> [String] {
	#if canImport(FoundationModels)
		if #available(macOS 26.0, *) {
			return SystemLanguageModel.default.supportedLanguages
				.map { $0.minimalIdentifier }.sorted()
		}
	#endif
	return []
}

func supportsLocale(_ identifier: String?) -> Bool {
	guard let identifier, !identifier.isEmpty else { return true }
	#if canImport(FoundationModels)
		if #available(macOS 26.0, *) {
			return SystemLanguageModel.default.supportsLocale(Locale(identifier: identifier))
		}
	#endif
	return false
}

if CommandLine.arguments.contains("--languages") {
	send(["ok": true, "languages": supportedLanguages()])
	exit(0)
}

if CommandLine.arguments.contains("--availability") {
	send(["ok": true, "availability": availability()])
	exit(0)
}

/// Maps a generation error to a stable code the app shows as a state.
func errorCode(_ error: Error) -> String {
	#if canImport(FoundationModels)
		if #available(macOS 26.0, *),
			let generation = error as? LanguageModelSession.GenerationError
		{
			switch generation {
			case .exceededContextWindowSize: return "too-long"
			case .unsupportedLanguageOrLocale: return "unsupported-language"
			case .assetsUnavailable: return "model-not-ready"
			case .guardrailViolation, .refusal: return "refused"
			case .rateLimited, .concurrentRequests: return "busy"
			default: return "failed"
			}
		}
	#endif
	if error is CancellationError { return "cancelled" }
	return "failed"
}

final class Runs: @unchecked Sendable {
	private let lock = NSLock()
	private var tasks: [String: Task<Void, Never>] = [:]
	func add(_ id: String, _ task: Task<Void, Never>) {
		lock.lock()
		tasks[id] = task
		lock.unlock()
	}
	func remove(_ id: String) {
		lock.lock()
		tasks[id] = nil
		lock.unlock()
	}
	var isEmpty: Bool {
		lock.lock()
		defer { lock.unlock() }
		return tasks.isEmpty
	}
	func cancel(_ id: String) {
		lock.lock()
		let task = tasks[id]
		lock.unlock()
		task?.cancel()
	}
}
let runs = Runs()


func handle(_ request: [String: Any]) {
	let id = request["id"] as? String ?? ""
	switch request["op"] as? String {
	case "availability":
		send(["id": id, "ok": true, "availability": availability()])
	case "prewarm":
		#if canImport(FoundationModels)
			if #available(macOS 26.0, *), availability() == "available" {
				let session = LanguageModelSession(instructions: instructions)
				session.prewarm()
				warmHolder = session
			}
		#endif
		send(["id": id, "ok": true])
	case "cancel":
		runs.cancel(request["target"] as? String ?? "")
		send(["id": id, "ok": true])
	case "run":
		let prompt = request["prompt"] as? String ?? ""
		let maxTokens = request["maxTokens"] as? Int ?? 1024
		let locale = request["locale"] as? String
		if !supportsLocale(locale) {
			send([
				"id": id, "ok": false, "code": "unsupported-language",
				"error": "The on-device model doesn't support \(locale ?? "")",
			])
			return
		}
		#if canImport(FoundationModels)
			if #available(macOS 26.0, *) {
				let task = Task {
					defer { runs.remove(id) }
					do {
						let session = LanguageModelSession(instructions: instructions)
						let response = try await session.respond(
							to: prompt,
							options: GenerationOptions(
								temperature: 0.2, maximumResponseTokens: maxTokens))
						if Task.isCancelled {
							send(["id": id, "ok": false, "code": "cancelled", "error": "cancelled"])
						} else {
							send(["id": id, "ok": true, "text": response.content])
						}
					} catch {
						let code = Task.isCancelled ? "cancelled" : errorCode(error)
						send(["id": id, "ok": false, "code": code, "error": "\(error)"])
					}
				}
				runs.add(id, task)
				return
			}
		#endif
		send(["id": id, "ok": false, "code": "unsupported-os", "error": "Needs macOS 26"])
	default:
		send(["id": id, "ok": false, "code": "failed", "error": "unknown op"])
	}
}

/// Kept only so `prewarm` keeps the model loaded; every run gets a fresh
/// session so tools never share a transcript.
nonisolated(unsafe) var warmHolder: AnyObject?

// Reads stdin on a background thread; the main run loop keeps tasks alive.
// EOF (Electron quit or killed the pipe) ends the helper.
Thread.detachNewThread {
	while let line = readLine(strippingNewline: true) {
		guard !line.isEmpty,
			let data = line.data(using: .utf8),
			let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
		else { continue }
		handle(request)
	}
	// Let in-flight runs answer before exiting (one-shot piped use).
	while !runs.isEmpty { Thread.sleep(forTimeInterval: 0.05) }
	exit(0)
}
dispatchMain()
