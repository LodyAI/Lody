import Foundation

func chunk(_ bytes: Data, total: Int, offset: Int) -> Data {
  var result = Data()
  withUnsafeBytes(of: UInt32(total).bigEndian) { result.append(contentsOf: $0) }
  withUnsafeBytes(of: UInt32(offset).bigEndian) { result.append(contentsOf: $0) }
  result.append(bytes)
  return result
}

@MainActor func verify() async throws {
  // Guard corruption and allocation boundaries independently of RTC's happy path.
  var assembler = SimulatorRTCFrame()
  let partial = try assembler.append(chunk(Data([1, 2]), total: 4, offset: 0))
  let complete = try assembler.append(chunk(Data([3, 4]), total: 4, offset: 2))
  precondition(partial == nil && complete == Data([1, 2, 3, 4]))
  for bad in [chunk(Data([1]), total: 17 * 1024 * 1024, offset: 0),
              chunk(Data([1]), total: 2, offset: 1), Data(repeating: 0, count: 16 * 1024 + 1)] {
    do { _ = try assembler.append(bad); preconditionFailure("Accepted corrupt frame") } catch {}
  }
  _ = try assembler.append(chunk(Data([1]), total: 3, offset: 0))
  do { _ = try assembler.append(chunk(Data([2]), total: 4, offset: 1)); preconditionFailure("Accepted changed total") } catch {}
  print("PASS bounded frame reassembly and corrupt frame rejection")

  let base = ProcessInfo.processInfo.environment["LODY_SIMULATOR_TEST_URL"]!
  func make(_ mode: String) -> SimulatorTransport {
    SimulatorTransport(viewer: URL(string: "\(base)/\(mode)/?token=synthetic")!, h264: true)
  }
  let transport = make("native")
  var fallbacks = 0
  transport.onFallback = { fallbacks += 1 }
  let (messages, continuation) = AsyncStream<URLSessionWebSocketTask.Message>.makeStream()
  transport.onMessage = { continuation.yield($0) }
  transport.onOpen = { transport.send(["type": "heartbeat"]) }
  transport.onClose = { code in preconditionFailure("Unexpected close \(code)") }
  transport.start(preferRTC: true)
  var iterator = messages.makeAsyncIterator()
  let first = await iterator.next()
  guard case .data(let frame) = first else {
    preconditionFailure("No RTC frame: \(String(describing: first)), mode \(transport.mode), fallbacks \(fallbacks)")
  }
  precondition(frame == Data((0..<40_000).map { UInt8($0 % 251) }) && transport.mode == .webRTC && fallbacks == 0)
  let success = await transport.perform(operationId: "synthetic-operation", control: ["kind": "button", "button": "home"])
  precondition(success)
  print("PASS libdatachannel <-> werift frames and acknowledged control")

  let uncertain = await transport.perform(operationId: "synthetic-operation", control: ["kind": "button", "button": "lock"])
  precondition(!uncertain)
  guard case .string("fallback-ready") = await iterator.next() else { preconditionFailure("No WebSocket fallback") }
  precondition(fallbacks == 1 && transport.mode == .webSocket)
  // Echo is an ordering barrier: fallback has accepted input before inspecting its receipts.
  guard case .string = await iterator.next() else { preconditionFailure("No fallback heartbeat") }
  transport.close()
  continuation.finish()
  transport.onOpen = nil
  print("PASS established RTC loss falls back without replaying uncertain control")

  for mode in ["unsupported", "malformed", "redirect"] {
    let connection = make(mode)
    let (events, output) = AsyncStream<URLSessionWebSocketTask.Message>.makeStream()
    var switched = 0
    connection.onFallback = { switched += 1 }
    connection.onMessage = { output.yield($0) }
    connection.start(preferRTC: true)
    var next = events.makeAsyncIterator()
    guard case .string("fallback-ready") = await next.next() else { preconditionFailure("No \(mode) fallback") }
    precondition(switched == 1 && connection.mode == .webSocket)
    connection.close()
    output.finish()
    print("PASS \(mode) signaling uses WebSocket")
  }
  let stopped = make("hanging")
  stopped.onFallback = { preconditionFailure("Stop opened a fallback connection") }
  stopped.onOpen = { preconditionFailure("Stop opened a connection") }
  stopped.start(preferRTC: true)
  _ = try await URLSession.shared.data(from: URL(string: "\(base)/await-hanging")!)
  stopped.close()
  stopped.send(["type": "touch1-down"])
  let rejected = await stopped.perform(operationId: "synthetic-operation", control: ["kind": "button", "button": "home"])
  precondition(!rejected && stopped.mode == .closed)

  let (data, _) = try await URLSession.shared.data(from: URL(string: "\(base)/stats")!)
  let stats = try JSONSerialization.jsonObject(with: data) as! [String: Any]
  precondition((stats["controls"] as! [String]).isEmpty, "Uncertain control replayed over HTTP")
  precondition(stats["rtcCommands"] as! Int == 2, "RTC controls were not each delivered once")
  precondition(stats["redirects"] as! Int == 0, "Capability followed redirect")
  precondition(stats["hanging"] as! Int == 1, "Negotiation was not in flight")
  precondition(!(stats["sockets"] as! [String]).contains("/hanging/stream"))
  precondition((stats["inputs"] as! [[String: Any]]).allSatisfy { $0["type"] as? String == "heartbeat" })
  print("PASS close cancels negotiation and input; no capability redirects or input replay")
}

Task { @MainActor in
  do { try await verify(); print("Simulator transport checks passed"); exit(0) }
  catch { print("Simulator transport check failed: \(error)"); exit(1) }
}
dispatchMain()
