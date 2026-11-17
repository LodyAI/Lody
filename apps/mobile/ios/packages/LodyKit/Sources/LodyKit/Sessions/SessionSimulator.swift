import LodyCore
import Foundation

/// The device platforms behind the shared device-preview route. Each keeps its own
/// signed lifecycle call, state and stream; an iOS proof never authorizes Android.
enum DevicePlatform: String, CaseIterable, Sendable {
  case ios, android
}

/// Android capture tiers. Remote previews start Balanced; switching starts the same AVD again.
enum DevicePreviewQuality: String, CaseIterable, Sendable {
  case saver, balanced, clear
}

/// One platform's lifecycle calls, normalized so the store, picker and pages stay shared.
@MainActor
struct SimulatorService {
  enum Command: Equatable {
    case list
    case start(id: String, quality: DevicePreviewQuality?)
    case status(operationId: String?)
    case stop(operationId: String)
  }
  /// iOS UDIDs and Android AVD names are both `id`.
  struct Device: Equatable, Sendable {
    var id: String
    var name: String
    var runtime: String
    var deviceType: String
    var state: String
    var available: Bool
    var unavailableReason: String?
    var occupied: Bool
  }
  struct Preview: Equatable, Sendable {
    var operationId: String
    var deviceId: String
    var phase: String
    var viewerUrl: String?
    var message: String?
  }
  struct Reply {
    var success: Bool
    var devices: [Device]?
    var preview: Preview?
    var error: String?
    var message: String?
  }

  let platform: DevicePlatform
  var call: @MainActor (Command) async throws -> Reply

  static func ios(_ call: @escaping @MainActor (RuntimeContract.IosSimulatorControlParamsCommand) async throws -> RuntimeContract.IosSimulatorControlResult) -> Self {
    Self(platform: .ios, call: { command in
      let wire: RuntimeContract.IosSimulatorControlParamsCommand = switch command {
      case .list: .list(.init())
      case .start(let id, _): .start(.init(udid: id))
      case .status(let operationId): .status(.init(operationId: operationId))
      case .stop(let operationId): .stop(.init(operationId: operationId))
      }
      let reply = try await call(wire)
      return Reply(success: reply.success == true,
        devices: reply.devices?.map { Device(id: $0.udid, name: $0.name, runtime: $0.runtime, deviceType: $0.deviceType, state: $0.state,
          available: $0.available, unavailableReason: $0.unavailableReason, occupied: $0.occupancy == .otherSession) },
        preview: reply.preview.map { Preview(operationId: $0.operationId, deviceId: $0.udid, phase: $0.phase.rawValue, viewerUrl: $0.viewerUrl, message: $0.message) },
        error: reply.error, message: reply.message)
    })
  }

  static func android(_ call: @escaping @MainActor (RuntimeContract.AndroidEmulatorControlParamsCommand) async throws -> RuntimeContract.AndroidEmulatorControlResult) -> Self {
    Self(platform: .android, call: { command in
      let wire: RuntimeContract.AndroidEmulatorControlParamsCommand = switch command {
      case .list: .list(.init())
      case .start(let id, let quality): .start(.init(id: id, quality: quality.flatMap { RuntimeContract.AndroidEmulatorControlParamsCommandStartQuality(rawValue: $0.rawValue) }))
      case .status(let operationId): .status(.init(operationId: operationId))
      case .stop(let operationId): .stop(.init(operationId: operationId))
      }
      let reply = try await call(wire)
      return Reply(success: reply.success == true,
        devices: reply.devices?.map { Device(id: $0.id, name: $0.name, runtime: $0.runtime, deviceType: $0.deviceType, state: $0.state,
          available: $0.available, unavailableReason: $0.unavailableReason, occupied: $0.occupancy == .otherSession) },
        preview: reply.preview.map { Preview(operationId: $0.operationId, deviceId: $0.id, phase: $0.phase.rawValue, viewerUrl: $0.viewerUrl, message: $0.message) },
        error: reply.error, message: reply.message)
    })
  }

  static func live(_ platform: DevicePlatform, workspaceId: String, userId: String, sessionId: String) -> Self {
    func runtime() throws -> DataRuntime {
      guard let runtime = DataRuntime.current, runtime.workspace == workspaceId, runtime.userId == userId else {
        throw OutboxError.scopeExpired
      }
      return runtime
    }
    switch platform {
    case .ios:
      return .ios { command in
        try await runtime().perform(RuntimeContract.Calls.IosSimulatorControl.self,
          .init(workspaceId: workspaceId, sessionId: sessionId, userId: userId, command: command))
      }
    case .android:
      return .android { command in
        try await runtime().perform(RuntimeContract.Calls.AndroidEmulatorControl.self,
          .init(workspaceId: workspaceId, sessionId: sessionId, userId: userId, command: command))
      }
    }
  }
}

@MainActor
final class SessionSimulator {
  typealias Device = SimulatorService.Device
  private struct Watcher { weak var owner: AnyObject?; let changed: () -> Void }
  let sessionId: String
  let service: SimulatorService
  var platform: DevicePlatform { service.platform }
  private(set) var name = ""
  private(set) var phase = "closed"
  private(set) var message = ""
  private(set) var preview: SimulatorService.Preview?
  /// Android only; the host does not report the tier, so this is the last one requested.
  private(set) var quality = DevicePreviewQuality.balanced
  private var version = 0
  private var task: Task<Void, Never>?
  private var watchers: [Watcher] = []
  private var hidden: String?
  var running: Bool { !["failed", "closed"].contains(phase) }
  var connecting: Bool { ["preparing", "booting", "connecting"].contains(phase) }
  var phaseText: String {
    let key = ["preparing": "starting", "booting": "starting", "connecting": "connecting", "ready": "ready", "failed": "failed", "closed": "closed"][phase]!
    // Starting and failure name the device kind; the other phases read the same on both platforms.
    let prefix = platform == .android && ["starting", "failed"].contains(key) ? "emulator.phase." : "simulator.phase."
    return String(localized: String.LocalizationValue(prefix + key), bundle: .lody)
  }
  var sourceJSON: String {
    guard phase == "ready", let preview, let url = preview.viewerUrl else { return "" }
    // Streams are shared by `streamId`, so it carries the platform as well as the operation.
    let data = try! JSONSerialization.data(withJSONObject: ["streamId": platform.rawValue + ":" + sessionId + ":" + preview.operationId,
      "url": url, "udid": preview.deviceId, "name": name, "operationId": preview.operationId, "platform": platform.rawValue])
    return String(decoding: data, as: UTF8.self)
  }
  var previewJSON: String { hidden == preview?.operationId ? "" : sourceJSON }

  init(sessionId: String, service: SimulatorService) { self.sessionId = sessionId; self.service = service }
  isolated deinit { task?.cancel() }
  func finish() { version += 1; task?.cancel(); task = nil }
  func watch(_ owner: AnyObject, changed: @escaping () -> Void) { watchers.append(.init(owner: owner, changed: changed)) }
  private func publish() { watchers.removeAll { $0.owner == nil }; for watcher in watchers { watcher.changed() } }
  func hidePreview() { hidden = preview?.operationId; publish() }
  func revealPreview() { hidden = nil; publish() }

  func devices() async throws -> [Device] {
    let reply = try await request(.list)
    guard let devices = reply.devices else { throw NSError(domain: "LodyKit.Simulator", code: 1, userInfo: [NSLocalizedDescriptionKey: "simulator_invalid_response"]) }
    return devices
  }
  func resume() async throws -> Bool {
    version += 1
    let token = version
    phase = "connecting"; message = ""; publish()
    do {
      let reply = try await request(.status(operationId: nil))
      guard token == version else { return false }
      guard let preview = reply.preview, preview.phase != "failed", preview.phase != "closed" else {
        phase = "closed"; self.preview = nil; publish(); return false
      }
      let devices = try await devices()
      guard token == version else { return false }
      name = devices.first { $0.id == preview.deviceId }?.name ?? preview.deviceId
      apply(reply)
      poll(token: token)
      return true
    } catch {
      if token == version { fail(error) }
      throw error
    }
  }
  func start(_ device: Device) { start(id: device.id, name: device.name) }
  /// Android: starts the running AVD again at another tier, replacing the capture operation.
  func setQuality(_ next: DevicePreviewQuality) {
    guard platform == .android, let preview, next != quality else { return }
    quality = next
    start(id: preview.deviceId, name: name)
  }
  private func start(id: String, name: String) {
    version += 1
    let token = version
    task?.cancel(); self.name = name; preview = nil; hidden = nil; phase = "preparing"; message = ""; publish()
    let quality = platform == .android ? quality : nil
    task = Task { [weak self] in
      guard let self else { return }
      do {
        let reply = try await request(.start(id: id, quality: quality))
        guard !Task.isCancelled, token == version else { return }
        apply(reply)
        try await polling(token: token)
      } catch { if !Task.isCancelled, token == version { fail(error) } }
    }
  }
  func stop() async throws {
    version += 1; task?.cancel(); task = nil
    let operationId = preview?.operationId
    preview = nil; phase = "closed"; publish()
    guard let operationId else { return }
    _ = try await request(.stop(operationId: operationId))
  }
  private func request(_ command: SimulatorService.Command) async throws -> SimulatorService.Reply {
    let reply = try await service.call(command)
    guard reply.success else {
      // A list failure on Android usually means the SDK or emulator binary is missing.
      let missing = platform == .android && command == .list && reply.error == "unavailable"
      let fallback = String(localized: String.LocalizationValue(missing ? "emulator.sdkUnavailable" : "simulator.phase.failed"), bundle: .lody)
      throw NSError(domain: "LodyKit.Simulator", code: 1,
        userInfo: [NSLocalizedDescriptionKey: missing ? fallback : reply.message ?? reply.error ?? fallback])
    }
    return reply
  }
  private func apply(_ reply: SimulatorService.Reply) {
    preview = reply.preview; phase = reply.preview?.phase ?? "closed"; message = reply.preview?.message ?? ""; publish()
  }
  private func fail(_ error: Error) { phase = "failed"; message = error.localizedDescription; publish() }
  private func poll(token: Int) {
    task?.cancel()
    task = Task { [weak self] in
      do { try await self?.polling(token: token) }
      catch { if !Task.isCancelled, let self, token == version { fail(error) } }
    }
  }
  private func polling(token: Int) async throws {
    for _ in 0..<180 {
      guard token == version, connecting, let operationId = preview?.operationId else { return }
      try await Task.sleep(for: .seconds(1))
      let reply = try await request(.status(operationId: operationId))
      guard token == version, !Task.isCancelled else { return }
      apply(reply)
    }
    if token == version, connecting { throw NSError(domain: "LodyKit.Simulator", code: 1,
      userInfo: [NSLocalizedDescriptionKey: String(localized: String.LocalizationValue(platform == .android ? "emulator.phase.failed" : "simulator.phase.failed"), bundle: .lody)]) }
  }
}
