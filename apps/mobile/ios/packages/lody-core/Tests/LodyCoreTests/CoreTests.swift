import XCTest
import LodyCore

final class CoreTests: XCTestCase {
  func testSuspensionDoesNotConsumeHeartbeatDeadline() {
    var health = RuntimeHealth()
    health.started(at: 100)
    XCTAssertTrue(health.timedOut(at: 120))
    health.acknowledged(at: 120)
    health.suspend()
    XCTAssertFalse(health.timedOut(at: 900))
    health.resume(at: 900)
    XCTAssertTrue(health.ready)
    XCTAssertFalse(health.timedOut(at: 907.9))
    XCTAssertTrue(health.timedOut(at: 908))
  }

  func testRestoringUnavailableModelDoesNotSendObsoleteOptions() {
    let agent = CreationAgent(id: "a", name: "Agent", machineId: "m", machineName: "Mac", cliType: "builtin", agentType: "codex")
    let options = CreationOptions(sessionId: "s", agents: [agent], capabilities: [
      Capability(machineId: "m", cliType: "builtin", agentType: "codex", models: [CapabilityChoice(id: "current", name: "Current")])
    ])
    let prefs = CreatePrefs(projects: ["p": ProjectPrefs(modelId: "removed", effort: "obsolete", machineId: "m", agentKey: agent.key)])
    let restored = CreateLogic.restoreSelection(prefs, target: "p", options: options)
    XCTAssertEqual(restored.agentKey, agent.key)
    XCTAssertNil(restored.choice.modelId)
    XCTAssertNil(restored.choice.effort)
    XCTAssertEqual(CreateJSON.decode(CreatePrefs.self, CreateJSON.encode(prefs)), prefs)
  }
}
