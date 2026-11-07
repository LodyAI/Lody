import Foundation
import LodyCore

extension DataRuntime {
  func recordSessionTrace(_ value: RuntimeContract.SessionTraceEvent) {
    var fields = ["session": DiagnosticsStore.correlation(value.sessionId)]
    if let stage = value.stage { fields["readStage"] = stage.rawValue }
    if let status = value.status { fields["syncStatus"] = status }
    if let code = value.code { fields["syncCode"] = code }
    if let age = Self.whole(value.ageMs) { fields["ageMs"] = age }
    if let attempts = Self.whole(value.attempts) { fields["attempts"] = attempts }
    let store = DiagnosticsStore.shared
    switch value.event {
    case .retry: store.record("session-sync", "read_retry", fields: fields)
    case .slow: store.record("session-sync", "read_slow", fields: fields)
    case .stalled: store.record("session-sync", "read_stalled", fields: fields)
    case .status: store.record("session-sync", "session_status", fields: fields)
    case .resume: store.record("session-sync", "session_resume", fields: fields)
    }
  }

  func recordRuntime(_ event: StaticString, phase: String, reason: String, extra: [String: String] = [:]) {
    let fields = extra.merging(["runtimePhase": phase, "runtimeReason": reason, "generation": String(generation)]) { _, new in new }
    DiagnosticsStore.shared.record("session-sync", event, fields: fields)
  }

  private static func whole(_ value: Double?) -> String? {
    guard let value, value.isFinite, abs(value) < 1e12 else { return nil }
    return String(Int(value))
  }
}
