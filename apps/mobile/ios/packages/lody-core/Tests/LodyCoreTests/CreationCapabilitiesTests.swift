import XCTest
import LodyCore

final class CreationCapabilitiesTests: XCTestCase {
  func testModelControlsSurviveCacheAndFollowSelectedModel() throws {
    let wire = """
    {"machineId":"m","agentConfigId":"a","cliType":"builtin","agentType":"codex","models":[],"modes":[],
     "reasoningEfforts":{"small":[],"large":["high","max"]},"fastModes":{"small":false,"large":true},
     "configOptions":[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"small","options":[{"id":"small","name":"Small"},{"id":"large","name":"Large"}]},
     {"id":"fast-mode","name":"Fast","type":"boolean","currentValue":false,"options":[]}]}
    """
    let capability = try JSONDecoder().decode(Capability.self, from: Data(wire.utf8))
    let restored = try JSONDecoder().decode(Capability.self, from: JSONEncoder().encode(capability))
    XCTAssertEqual(CreateLogic.effortsFor(restored, modelId: "large"), ["high", "max"])
    XCTAssertEqual(CreateLogic.effortsFor(restored, modelId: "small"), [])
    XCTAssertNil(CreateLogic.fastMode(restored, ModelChoice()))
    XCTAssertNil(CreateLogic.fastMode(restored, ModelChoice(modelId: "small")))
    XCTAssertEqual(CreateLogic.fastMode(restored, ModelChoice(modelId: "large"))?.enabled, false)
  }
}
