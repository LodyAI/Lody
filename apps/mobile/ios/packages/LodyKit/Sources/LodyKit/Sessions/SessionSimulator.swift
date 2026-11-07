import LodyCore
import Foundation

@MainActor
struct SimulatorService {
  typealias Command = RuntimeContract.IosSimulatorControlParamsCommand
  typealias Reply = RuntimeContract.IosSimulatorControlResult
  var call: @MainActor (Command) async throws -> Reply

  static func live(workspaceId: String, userId: String, sessionId: String) -> Self {
    Self(call: { command in
      guard let runtime = DataRuntime.current, runtime.workspace == workspaceId, runtime.userId == userId else {
        throw OutboxError.scopeExpired
      }
      return try await runtime.perform(RuntimeContract.Calls.IosSimulatorControl.self,
        .init(workspaceId: workspaceId, sessionId: sessionId, userId: userId, command: command))
    })
  }
}

@MainActor
final class SessionSimulator {
  typealias Device = RuntimeContract.IosSimulatorControlResultDevicesItem
  private struct Watcher { weak var owner: AnyObject?; let changed: () -> Void }
  let sessionId: String
  let service: SimulatorService
  private(set) var name = ""
  private(set) var phase = "closed"
  private(set) var message = ""
  private(set) var preview: RuntimeContract.IosSimulatorControlResultPreview?
  private var version = 0
  private var task: Task<Void, Never>?
  private var watchers: [Watcher] = []
  private var hidden: String?
  var running: Bool { !["failed", "closed"].contains(phase) }
  var connecting: Bool { ["preparing", "booting", "connecting"].contains(phase) }
  var phaseText: String {
    let key = ["preparing": "starting", "booting": "starting", "connecting": "connecting", "ready": "ready", "failed": "failed", "closed": "closed"][phase]!
    return String(localized: String.LocalizationValue("simulator.phase." + key), bundle: .lody)
  }
  var sourceJSON: String {
    guard phase == "ready", let preview, let url = preview.viewerUrl else { return "" }
    let data = try! JSONSerialization.data(withJSONObject: ["streamId": sessionId + ":" + preview.operationId,
      "url": url, "udid": preview.udid, "name": name, "operationId": preview.operationId])
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
    let reply = try await request(.list(.init()))
    guard let devices = reply.devices else { throw NSError(domain: "LodyKit.Simulator", code: 1, userInfo: [NSLocalizedDescriptionKey: "simulator_invalid_response"]) }
    return devices
  }
  func resume() async throws -> Bool {
    version += 1
    let token = version
    phase = "connecting"; message = ""; publish()
    do {
      let reply = try await request(.status(.init()))
      guard token == version else { return false }
      guard let preview = reply.preview, preview.phase != .failed, preview.phase != .closed else {
        phase = "closed"; self.preview = nil; publish(); return false
      }
      let devices = try await devices()
      guard token == version else { return false }
      name = devices.first { $0.udid == preview.udid }?.name ?? preview.udid
      apply(reply)
      poll(token: token)
      return true
    } catch {
      if token == version { fail(error) }
      throw error
    }
  }
  func start(_ device: Device) {
    version += 1
    let token = version
    task?.cancel(); name = device.name; preview = nil; hidden = nil; phase = "preparing"; message = ""; publish()
    task = Task { [weak self] in
      guard let self else { return }
      do {
        let reply = try await request(.start(.init(udid: device.udid)))
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
    _ = try await request(.stop(.init(operationId: operationId)))
  }
  private func request(_ command: SimulatorService.Command) async throws -> SimulatorService.Reply {
    let reply = try await service.call(command)
    guard reply.success == true else { throw NSError(domain: "LodyKit.Simulator", code: 1,
      userInfo: [NSLocalizedDescriptionKey: reply.message ?? reply.error ?? String(localized: "simulator.phase.failed", bundle: .lody)]) }
    return reply
  }
  private func apply(_ reply: SimulatorService.Reply) {
    preview = reply.preview; phase = reply.preview?.phase.rawValue ?? "closed"; message = reply.preview?.message ?? ""; publish()
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
      let reply = try await request(.status(.init(operationId: operationId)))
      guard token == version, !Task.isCancelled else { return }
      apply(reply)
    }
    if token == version, connecting { throw NSError(domain: "LodyKit.Simulator", code: 1,
      userInfo: [NSLocalizedDescriptionKey: String(localized: "simulator.phase.failed", bundle: .lody)]) }
  }
}
