import Foundation
import LodyCore

enum OutboxError: Error { case scopeExpired }
extension Bundle { static let lody = Bundle.main }
@MainActor final class DataRuntime {
  static var current: DataRuntime?
  var workspace = ""
  var userId = ""
  func perform(_ call: RuntimeContract.Calls.IosSimulatorControl.Type, _ params: RuntimeContract.IosSimulatorControlParams) async throws -> RuntimeContract.IosSimulatorControlResult { fatalError("fixture must not use cloud") }
  func perform(_ call: RuntimeContract.Calls.AndroidEmulatorControl.Type, _ params: RuntimeContract.AndroidEmulatorControlParams) async throws -> RuntimeContract.AndroidEmulatorControlResult { fatalError("fixture must not use cloud") }
}
@MainActor final class Fixture {
  var calls: [String] = []
  var pending: CheckedContinuation<RuntimeContract.IosSimulatorControlResult, Error>?
  var deferResume = false
  let wireDevice = RuntimeContract.IosSimulatorControlResultDevicesItem(udid: "phone", name: "Phone", runtime: "iOS", deviceType: "iPhone", state: "Booted", available: true, occupancy: .available)
  let device = SessionSimulator.Device(id: "phone", name: "Phone", runtime: "iOS", deviceType: "iPhone", state: "Booted", available: true, occupied: false)
  func ready(_ operation: String) -> RuntimeContract.IosSimulatorControlResult {
    .init(success: true, preview: .init(operationId: operation, udid: "phone", phase: .ready, transport: .remote, viewerUrl: "lody-simulator-fixture://stream"))
  }
  var service: SimulatorService {
    .ios { [self] command in
      switch command {
      case .list: calls.append("list"); return .init(success: true, devices: [wireDevice])
      case .start: calls.append("start"); return ready("new")
      case .status:
        calls.append("status")
        if deferResume { return try await withCheckedThrowingContinuation { pending = $0 } }
        return ready("resumed")
      case .stop: calls.append("stop"); return .init(success: true)
      case .exterior: preconditionFailure("The viewer owns exterior requests")
      }
    }
  }
}
@MainActor final class AndroidFixture {
  var starts: [RuntimeContract.AndroidEmulatorControlParamsCommandStart] = []
  var service: SimulatorService {
    .android { [self] command in
      switch command {
      case .list:
        return .init(success: true, devices: [.init(id: "Pixel_9", name: "Pixel 9", runtime: "Android", deviceType: "AVD", state: "Booted", available: true, occupancy: .available)])
      case .start(let start):
        starts.append(start)
        return .init(success: true, preview: .init(operationId: "android-\(starts.count)", id: start.id, phase: .ready, transport: .remote, viewerUrl: "lody-simulator-fixture://stream"))
      case .status, .stop: return .init(success: true)
      }
    }
  }
}
@main struct SimulatorCheck {
  @MainActor static func main() async throws {
    let fixture = Fixture()
    let store = SessionSimulator(sessionId: "session", service: fixture.service)
    let resumed = try await store.resume()
    precondition(resumed && store.phase == "ready" && store.name == "Phone")
    precondition(fixture.calls == ["status", "list"])
    precondition(!store.previewJSON.isEmpty)
    store.hidePreview(); precondition(store.previewJSON.isEmpty && !store.sourceJSON.isEmpty)
    store.revealPreview(); precondition(!store.previewJSON.isEmpty)
    try await store.stop(); precondition(store.phase == "closed" && fixture.calls.last == "stop")
    fixture.deferResume = true
    let stale = Task { try await store.resume() }
    while fixture.pending == nil { await Task.yield() }
    store.start(fixture.device)
    while store.phase != "ready" { await Task.yield() }
    fixture.pending!.resume(returning: fixture.ready("stale"))
    let accepted = try await stale.value
    precondition(!accepted && store.preview?.operationId == "new")
    precondition(fixture.calls.filter { $0 == "start" }.count == 1)

    // Android keeps its own state and stream identity, starts Balanced, and a quality switch
    // starts the same AVD again instead of choosing another device.
    let android = AndroidFixture()
    let emulator = SessionSimulator(sessionId: "session", service: android.service)
    let avd = try await emulator.devices()[0]
    emulator.start(avd)
    while emulator.phase != "ready" { await Task.yield() }
    precondition(android.starts.map(\.quality) == [.balanced] && android.starts[0].id == "Pixel_9")
    let source = try JSONSerialization.jsonObject(with: Data(emulator.sourceJSON.utf8)) as! [String: Any]
    let iosSource = try JSONSerialization.jsonObject(with: Data(store.sourceJSON.utf8)) as! [String: Any]
    precondition(source["platform"] as? String == "android" && iosSource["platform"] as? String == "ios")
    precondition(source["streamId"] as? String != iosSource["streamId"] as? String)
    emulator.setQuality(.clear)
    while emulator.preview?.operationId != "android-2" { await Task.yield() }
    precondition(android.starts.map(\.quality) == [.balanced, .clear] && android.starts.allSatisfy { $0.id == "Pixel_9" })
    precondition(store.preview?.operationId == "new" && store.phase == "ready")
    store.finish(); emulator.finish()
    print("PASS: resume discovers the device, floating preview hides independently, stale status cannot replace a new start, writes are not replayed, Android keeps separate state and switches quality on the same AVD")
  }
}
