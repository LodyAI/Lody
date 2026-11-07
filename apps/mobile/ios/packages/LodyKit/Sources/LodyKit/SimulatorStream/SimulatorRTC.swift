import Foundation
import LodyDataChannel
import os

/// One native, data-only peer for the CLI's authenticated simulator gateway.
/// No audio/video tracks, WebView, credentials in documents, or input replay.
@MainActor final class SimulatorRTC {
  /// libdatachannel calls back on its own threads with integer handles. Events
  /// resolve through this table on the main queue, so a closed peer's late
  /// callbacks find nothing.
  private static var owners: [Int32: Weak] = [:]
  private struct Weak { weak var rtc: SimulatorRTC? }
  private static func owner(_ id: Int32) -> SimulatorRTC? { owners[id]?.rtc }

  var onOpen: (() -> Void)?
  var onMessage: ((URLSessionWebSocketTask.Message) -> Void)?
  var onFailure: ((Int) -> Void)?
  private(set) var isOpen = false
  private var closed = false
  private var offerSent = false
  private var readyReceived = false
  private var gatheringComplete = false
  private var gatheringGrace: Task<Void, Never>?
  private var gatheringTimedOut = false
  private var peer: Int32?
  private var media: Int32?
  private var control: Int32?
  private var frames = SimulatorRTCFrame()
  private var signaling: Task<Void, Never>?
  private var deadline: Task<Void, Never>?
  private var pendingControl: (id: String, finish: (Bool) -> Void)?
  private var controlDeadline: Task<Void, Never>?
  private let viewer: URL
  private let h264: Bool
  private let session: URLSession

  init(viewer: URL, h264: Bool, session: URLSession) {
    self.viewer = viewer
    self.h264 = h264
    self.session = session
  }

  func start() {
    deadline = Task { [weak self] in
      do { try await Task.sleep(for: .seconds(12)) } catch { return }
      self?.fail("deadline")
    }
    signaling = Task { [weak self] in
      guard let self, !closed else { return }
      do {
        let data = try await read("rtc-config")
        let config = try JSONDecoder().decode(IceConfiguration.self, from: data)
        guard !closed else { return }
        let urls = try config.urls()
        Self.log.info("ice servers: \(Self.schemes(urls), privacy: .public)")
        try open(iceServers: urls)
      } catch { fail("rtc-config \(Self.describe(error))") }
    }
  }

  private func open(iceServers: [String]) throws {
    let peer = Self.withCStrings(iceServers) { servers in
      var config = rtcConfiguration()
      config.iceServers = servers
      config.iceServersCount = Int32(iceServers.count)
      config.iceTransportPolicy = RTC_TRANSPORT_POLICY_ALL
      return rtcCreatePeerConnection(&config)
    }
    guard peer >= 0 else { throw URLError(.cannotConnectToHost) }
    self.peer = peer
    Self.owners[peer] = Weak(rtc: self)
    rtcSetStateChangeCallback(peer, onState)
    rtcSetGatheringStateChangeCallback(peer, onGathering)
    rtcSetLocalCandidateCallback(peer, onCandidate)
    rtcSetDataChannelCallback(peer, onRemoteChannel)
    var options = rtcDataChannelInit()
    options.reliability.unordered = false
    let media = rtcCreateDataChannelEx(peer, "media", &options)
    let control = rtcCreateDataChannelEx(peer, "control", &options)
    guard media >= 0, control >= 0 else { throw URLError(.cannotConnectToHost) }
    self.media = media
    self.control = control
    for channel in [media, control] {
      Self.owners[channel] = Weak(rtc: self)
      rtcSetOpenCallback(channel, onChannelOpen)
      rtcSetClosedCallback(channel, onChannelClosed)
      rtcSetMessageCallback(channel, onChannelMessage)
    }
    // Unreachable STUN servers can hold gathering open past the connect deadline.
    gatheringGrace = Task { [weak self] in
      do { try await Task.sleep(for: .seconds(3)) } catch { return }
      self?.gatheringTimedOut = true
      self?.exchangeOffer()
    }
    exchangeOffer()
  }

  fileprivate enum Event: Sendable {
    case failed(String), state(rtcState), opened, candidate, gathered, message(Data, binary: Bool)
  }

  fileprivate static func handle(_ id: Int32, _ event: Event) {
    guard let rtc = owner(id) else { return }
    switch event {
    case .failed(let reason): rtc.fail(reason)
    case .state(let state):
      log.info("peer state \(state.rawValue)")
      if [RTC_FAILED, RTC_DISCONNECTED, RTC_CLOSED].contains(state) { rtc.fail("peer state \(state.rawValue)") }
    case .opened: rtc.openIfReady()
    case .candidate: rtc.exchangeOffer()
    case .gathered:
      rtc.gatheringComplete = true
      rtc.exchangeOffer()
    case .message(let data, let binary): rtc.receive(data, binary: binary, channel: id)
    }
  }

  private func exchangeOffer() {
    guard !closed, !offerSent, let peer, let sdp = Self.string({ rtcGetLocalDescription(peer, $0, $1) }),
          Self.string({ rtcGetLocalDescriptionType(peer, $0, $1) }) == "offer",
          gatheringComplete || gatheringTimedOut || sdp.contains(" typ relay ") else { return }
    guard sdp.utf8.count <= 64 * 1024 else { return fail("offer size") }
    offerSent = true
    Self.log.info("offer: gathered=\(self.gatheringComplete) \(Self.candidates(sdp), privacy: .public)")
    signaling = Task { [weak self] in
      guard let self else { return }
      do {
        let data = try await read("rtc", body: ["sdp": sdp, "codec": h264 ? "h264" : "mjpeg"])
        struct Answer: Decodable { let sdp: String }
        let answer = try JSONDecoder().decode(Answer.self, from: data)
        guard !closed else { return }
        guard !answer.sdp.isEmpty, answer.sdp.utf8.count <= 64 * 1024,
              rtcSetRemoteDescription(peer, answer.sdp, "answer") == RTC_ERR_SUCCESS else { return fail("answer") }
        Self.log.info("answer: \(Self.candidates(answer.sdp), privacy: .public)")
      } catch { fail("rtc \(Self.describe(error))") }
    }
  }

  /// Stream responses incrementally so a remote response cannot allocate unbounded memory.
  private func read(_ name: String, body: [String: String]? = nil) async throws -> Data {
    guard let address = SimulatorRemote.endpoint(viewer, name) else { throw URLError(.badURL) }
    var request = SimulatorRemote.request(viewer, address, timeout: 12)
    if let body {
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (bytes, response) = try await session.bytes(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard status == 200 else { throw URLError(.badServerResponse, userInfo: ["status": status]) }
    var data = Data()
    for try await byte in bytes {
      guard data.count < 70 * 1024 else { throw URLError(.dataLengthExceedsMaximum) }
      data.append(byte)
    }
    try Task.checkCancellation()
    return data
  }

  func send(_ text: String) {
    guard !closed, isOpen, let control, rtcIsOpen(control) else { return }
    guard text.utf8.count <= 128 * 1024, rtcGetBufferedAmount(control) <= 128 * 1024,
          rtcSendMessage(control, text, -1) >= 0 else { return fail("send") }
  }

  func requestControl(operationId: String, control: [String: String]) async -> Bool {
    guard !closed, isOpen, pendingControl == nil else { return false }
    let id = UUID().uuidString
    guard let body = try? JSONSerialization.data(withJSONObject: [
      "operationId": operationId, "requestId": id, "control": control,
    ]), let text = String(data: body, encoding: .utf8) else { return false }
    return await withCheckedContinuation { continuation in
      pendingControl = (id, { continuation.resume(returning: $0) })
      controlDeadline = Task { [weak self] in
        do { try await Task.sleep(for: .seconds(12)) } catch { return }
        self?.finishControl(false)
      }
      send(text)
    }
  }

  private func finishControl(_ success: Bool) {
    let pending = pendingControl
    pendingControl = nil
    controlDeadline?.cancel()
    controlDeadline = nil
    pending?.finish(success)
  }

  func close() {
    guard !closed else { return }
    closed = true
    isOpen = false
    signaling?.cancel()
    signaling = nil
    deadline?.cancel()
    deadline = nil
    gatheringGrace?.cancel()
    gatheringGrace = nil
    finishControl(false)
    frames = SimulatorRTCFrame()
    for id in [media, control, peer].compactMap({ $0 }) { Self.owners[id] = nil }
    // Deleting waits for in-flight callbacks; they only enqueue main-queue work.
    for channel in [media, control].compactMap({ $0 }) { rtcDeleteDataChannel(channel) }
    if let peer {
      rtcClosePeerConnection(peer)
      rtcDeletePeerConnection(peer)
    }
    media = nil
    control = nil
    peer = nil
  }

  private func fail(_ reason: String, code: Int = 1000) {
    guard !closed else { return }
    Self.log.info("failed: \(reason, privacy: .public)")
    close()
    onFailure?(code)
  }

  /// The remote ready message can overtake the local open event of the other channel.
  private func openIfReady() {
    guard !closed, readyReceived, !isOpen, let media, let control, rtcIsOpen(media), rtcIsOpen(control) else { return }
    isOpen = true
    deadline?.cancel()
    deadline = nil
    if let peer { Self.log.info("ready via \(Self.candidateTypes(peer), privacy: .public) candidates") }
    onOpen?()
  }

  private func receive(_ data: Data, binary: Bool, channel: Int32) {
    guard !closed else { return }
    if channel == media {
      guard isOpen, binary else { return fail("media frame") }
      do {
        if let frame = try frames.append(data) { onMessage?(.data(frame)) }
      } catch { fail("media reassembly") }
      return
    }
    guard !binary, data.count <= 128 * 1024,
          let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return fail("control message") }
    switch message["type"] as? String {
    case "rtc-ready":
      guard !isOpen, !readyReceived else { return fail("ready") }
      readyReceived = true
      openIfReady()
    case "rtc-close":
      fail("rtc-close", code: message["code"] as? Int == 4002 ? 4002 : 1000)
    case "rtc-control-result":
      if message["requestId"] as? String == pendingControl?.id {
        finishControl(message["success"] as? Bool == true)
      }
    default:
      if isOpen, let text = String(data: data, encoding: .utf8) { onMessage?(.string(text)) }
    }
  }

  /// Scheme and transport only, such as "turn:udp"; never hosts or credentials.
  private static func schemes(_ urls: [String]) -> String {
    let list = urls.map { url in
      let scheme = url.prefix { $0 != ":" }
      let transport = url.range(of: "transport=").map { url[$0.upperBound...].prefix { $0 != "&" } } ?? "default"
      return "\(scheme):\(transport)"
    }
    return list.isEmpty ? "none" : list.joined(separator: ",")
  }

  /// Candidate type counts from an SDP, such as "host=2 relay=1"; never addresses.
  private static func candidates(_ sdp: String) -> String {
    var counts: [String: Int] = [:]
    for line in sdp.split(whereSeparator: \.isNewline) where line.hasPrefix("a=candidate:") {
      let parts = line.split(separator: " ")
      guard let index = parts.firstIndex(of: "typ"), index + 1 < parts.count else { continue }
      counts[String(parts[index + 1]), default: 0] += 1
    }
    return counts.isEmpty ? "no candidates" : counts.sorted { $0.key < $1.key }.map { "\($0)=\($1)" }.joined(separator: " ")
  }

  /// Error code and HTTP status only; the failing URL carries the viewer capability.
  private static func describe(_ error: Error) -> String {
    guard let error = error as? URLError else { return String(describing: type(of: error)) }
    return "URLError \(error.code.rawValue) status \(error.userInfo["status"] as? Int ?? 0)"
  }

  private static let log = Logger(subsystem: "ai.lody.mobile", category: "simulator-transport")

  /// Local/remote candidate types only, such as "host/relay"; never addresses.
  private static func candidateTypes(_ peer: Int32) -> String {
    var local = [CChar](repeating: 0, count: 256)
    var remote = [CChar](repeating: 0, count: 256)
    guard rtcGetSelectedCandidatePair(peer, &local, 256, &remote, 256) > 0 else { return "unknown" }
    func type(_ candidate: [CChar]) -> String {
      let text = String(decoding: candidate.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
      let parts = text.split(separator: " ")
      guard let index = parts.firstIndex(of: "typ"), index + 1 < parts.count else { return "unknown" }
      return String(parts[index + 1])
    }
    return "\(type(local))/\(type(remote))"
  }

  private static func string(_ read: (UnsafeMutablePointer<CChar>, Int32) -> Int32) -> String? {
    var buffer = [CChar](repeating: 0, count: 64 * 1024 + 1)
    guard buffer.withUnsafeMutableBufferPointer({ read($0.baseAddress!, Int32($0.count)) }) > 0 else { return nil }
    return String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
  }

  private static func withCStrings<T>(_ strings: [String], _ body: (UnsafeMutablePointer<UnsafePointer<CChar>?>?) -> T) -> T {
    let copies = strings.map { strdup($0) }
    defer { copies.forEach { free($0) } }
    var pointers = copies.map { UnsafePointer($0) }
    return pointers.withUnsafeMutableBufferPointer { body($0.baseAddress) }
  }

  private struct IceConfiguration: Decodable {
    struct Server: Decodable { let urls: [String]; let username: String?; let credential: String? }
    let iceServers: [Server]
    /// libdatachannel takes credentials inside the URL and URL-decodes them.
    func urls() throws -> [String] {
      guard iceServers.count <= 8 else { throw URLError(.badServerResponse) }
      return try iceServers.flatMap { server in
        guard !server.urls.isEmpty, server.urls.count <= 8,
              server.urls.allSatisfy({ url in
                url.utf8.count <= 512 && ["stun:", "turn:", "turns:"].contains(where: url.hasPrefix)
              }), (server.username?.utf8.count ?? 0) <= 1024,
              (server.credential?.utf8.count ?? 0) <= 4096 else { throw URLError(.badServerResponse) }
        return server.urls.map { url in
          guard !url.hasPrefix("stun:"), let username = server.username, let credential = server.credential,
                let colon = url.firstIndex(of: ":") else { return url }
          let scheme = url[...colon]
          return "\(scheme)\(Self.escape(username)):\(Self.escape(credential))@\(url[url.index(after: colon)...])"
        }
      }
    }
    private static func escape(_ value: String) -> String {
      value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    }
  }
}

// libdatachannel invokes these on its own threads, so they stay nonisolated.
private func post(_ id: Int32, _ event: SimulatorRTC.Event) {
  DispatchQueue.main.async { MainActor.assumeIsolated { SimulatorRTC.handle(id, event) } }
}
private let onState: rtcStateChangeCallbackFunc = { peer, state, _ in
  post(peer, .state(state))
}
private let onGathering: rtcGatheringStateCallbackFunc = { peer, state, _ in
  post(peer, state == RTC_GATHERING_COMPLETE ? .gathered : .candidate)
}
private let onCandidate: rtcCandidateCallbackFunc = { peer, _, _, _ in post(peer, .candidate) }
// Both channels must be created by us; reject unsolicited remote channels.
private let onRemoteChannel: rtcDataChannelCallbackFunc = { peer, _, _ in post(peer, .failed("remote channel")) }
private let onChannelOpen: rtcOpenCallbackFunc = { channel, _ in post(channel, .opened) }
private let onChannelClosed: rtcClosedCallbackFunc = { channel, _ in post(channel, .failed("channel closed")) }
private let onChannelMessage: rtcMessageCallbackFunc = { channel, message, size, _ in
  guard let message else { return }
  // A negative size marks a null-terminated text message.
  let binary = size >= 0
  let data = binary ? Data(bytes: message, count: Int(size)) : Data(bytes: message, count: strlen(message))
  post(channel, .message(data, binary: binary))
}
