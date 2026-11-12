import Foundation
import XCTest
@testable import LodyKit

final class WorkspaceModeTests: XCTestCase {
  func testModeQueriesKeepEncryptedWorkspacesAndFailClosedForUnknown() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("pins.json")
    var api = AuthAPI()
    api.modePins = WorkspaceModePins(file: file)
    api.transport = Self.transport(listedEncryption: true, failUnknown: true)
    let account = try await api.account(token: "synthetic-session")
    XCTAssertEqual(account.workspaces.map(\.contentMode), [.e2ee, .unknown, .plaintext])
    XCTAssertEqual(AuthAccount.decode(account.json)?.workspaces.map(\.contentMode), [.e2ee, .unknown, .plaintext])
    api.modePins = WorkspaceModePins(file: file)
    api.transport = Self.transport(listedEncryption: false, failUnknown: false)
    let refreshed = try await api.account(token: "synthetic-session")
    XCTAssertEqual(refreshed.workspaces.map(\.contentMode), [.e2ee, .plaintext, .plaintext])
  }

  func testLegacyAdmissionAndPartialDescriptors() async throws {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("pins.json")
    defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
    var api = AuthAPI(); api.modePins = WorkspaceModePins(file: file)
    try api.modePins.observe("secret", mode: .e2ee)
    try api.modePins.observe("crypto", mode: .plaintext)
    api.transport = { request in
      if request.url?.path.hasSuffix("convex/token") == true { return (Data("{\"token\":\"jwt\"}".utf8), 200) }
      let query = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
      let id = (query["args"] as! [[String: String]])[0]["workspaceId"]!
      XCTAssertNotEqual(id, "secret", "Pinned encryption skips remote classification")
      var value: [String: Any] = ["workspaceId": id, "admission": "legacy-unclassified"]
      switch id {
      case "genesis": value["genesisHash"] = NSNull()
      case "crypto": value["cryptoOrgId"] = "untrusted"
      case "mode": value["contentMode"] = "plaintext"
      case "version": value["contentModeVersion"] = 1
      default: break
      }
      return (try JSONSerialization.data(withJSONObject: ["status": "success", "value": value]), 200)
    }
    let rows = try await api.workspaceModes(token: "fixture", workspaces: ["legacy", "genesis", "crypto", "mode", "version", "secret"].map { AuthWorkspace(id: $0, name: $0, slug: nil, image: nil) })
    XCTAssertEqual(rows.map(\.contentMode), [.plaintext, .unknown, .unknown, .unknown, .unknown, .e2ee])
  }

  func testPlaintextCacheWriteFailureKeepsOnlineAdmission() async throws {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("pins.json")
    let pins = WorkspaceModePins(file: file, write: { _, _ in throw CocoaError(.fileWriteOutOfSpace) })
    var api = AuthAPI(); api.modePins = pins
    api.transport = Self.transport(listedEncryption: false, failUnknown: false)
    let account = try await api.account(token: "fixture")
    XCTAssertTrue(account.workspaces.allSatisfy { $0.contentMode == .plaintext })
    XCTAssertEqual(pins.mode("plain"), .plaintext)
    XCTAssertEqual(WorkspaceModePins(file: file).mode("plain"), .unknown)
    XCTAssertThrowsError(try pins.observe("secret", mode: .e2ee))
    XCTAssertEqual(try pins.observe("secret", mode: .plaintext), .e2ee)
  }

  func testQueriesRunFourAtOnceAndShareOneToken() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    var api = AuthAPI(); api.modePins = WorkspaceModePins(file: directory.appendingPathComponent("pins.json"))
    let gate = ModeQueryGate()
    api.transport = { request in
      XCTAssertGreaterThan(request.timeoutInterval, 0)
      XCTAssertLessThanOrEqual(request.timeoutInterval, 6)
      if request.url?.path.hasSuffix("convex/token") == true {
        await gate.token(); return (Data("{\"token\":\"jwt\"}".utf8), 200)
      }
      await gate.enter()
      let query = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
      let id = (query["args"] as! [[String: String]])[0]["workspaceId"]!
      await gate.leave()
      return (try JSONSerialization.data(withJSONObject: ["status": "success", "value": ["workspaceId": id, "admission": "legacy-unclassified"]]), 200)
    }
    let snapshot = api
    let work = Task { try await snapshot.workspaceModes(token: "fixture", workspaces: (1...8).map { AuthWorkspace(id: "w\($0)", name: "Work", slug: nil, image: nil) }) }
    await gate.full()
    await gate.release()
    let rows = try await work.value
    XCTAssertTrue(rows.allSatisfy { $0.contentMode == .plaintext })
    let counts = await gate.counts()
    XCTAssertEqual(counts.0, 4); XCTAssertEqual(counts.1, 1)
  }

  private static func transport(listedEncryption: Bool, failUnknown: Bool) -> AuthAPI.Transport {
    { request in
      let body: Any
      switch request.url?.path {
      case "/api/auth/get-session": body = ["user": ["id": "fixture", "email": "fixture@example.test"]]
      case "/api/auth/organization/list": body = [
        ["id": "secret", "name": "Secret", "contentMode": listedEncryption ? "e2ee" : "plaintext"],
        ["id": "unknown", "name": "Unknown"], ["id": "plain", "name": "Plain"]
      ]
      case "/api/auth/convex/token": body = ["token": "synthetic-jwt"]
      default:
        let query = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
        let id = (query["args"] as! [[String: String]])[0]["workspaceId"]!
        if id == "unknown", failUnknown { return (Data("{}".utf8), 503) }
        body = ["status": "success", "value": ["workspaceId": id, "contentMode": "plaintext", "contentModeVersion": 1]]
      }
      return (try JSONSerialization.data(withJSONObject: body), 200)
    }
  }

  func testWorkspaceAdmissionSurvivesRestartAndRejectsDowngrade() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("pins.json")
    let pins = WorkspaceModePins(file: file)
    XCTAssertEqual(pins.mode("new"), .unknown)
    try pins.observe("secret", mode: .e2ee, genesis: String(repeating: "a", count: 64))
    let reopened = WorkspaceModePins(file: file)
    XCTAssertEqual(reopened.mode("secret"), .e2ee)
    XCTAssertEqual(try reopened.observe("secret", mode: .plaintext), .e2ee)
    XCTAssertEqual(try reopened.observe("plain", mode: .plaintext), .plaintext)
    XCTAssertEqual(WorkspaceModePins(file: file).mode("plain"), .plaintext)
    try Data("corrupt".utf8).write(to: file)
    XCTAssertEqual(WorkspaceModePins(file: file).mode("plain"), .unknown)
    XCTAssertThrowsError(try WorkspaceModePins(file: file).observe("plain", mode: .plaintext))
  }
}

private actor ModeQueryGate {
  private var active = 0, peak = 0, tokens = 0
  private var opened = false
  private var waits: [CheckedContinuation<Void, Never>] = []
  private var ready: CheckedContinuation<Void, Never>?
  func token() { tokens += 1 }
  func enter() async {
    active += 1; peak = max(peak, active)
    if active == 4 { ready?.resume(); ready = nil }
    if !opened { await withCheckedContinuation { waits.append($0) } }
  }
  func leave() { active -= 1 }
  func full() async { if active >= 4 { return }; await withCheckedContinuation { ready = $0 } }
  func release() { opened = true; let pending = waits; waits = []; pending.forEach { $0.resume() } }
  func counts() -> (Int, Int) { (peak, tokens) }
}
