import Foundation
import os

/// WebRTC-first transport. A single switch to WebSocket discards partial media
/// and pending inputs. Codec recovery remains owned by SimulatorStreamView.
@MainActor final class SimulatorTransport {
  private nonisolated static let log = Logger(subsystem: "ai.lody.mobile", category: "simulator-transport")
  enum Mode { case connecting, webRTC, webSocket, closed }
  private(set) var mode: Mode = .connecting
  var onOpen: (() -> Void)?
  var onMessage: ((URLSessionWebSocketTask.Message) -> Void)?
  var onClose: ((Int) -> Void)?
  var onFallback: (() -> Void)?
  private var rtc: SimulatorRTC?
  private var socket: URLSessionWebSocketTask?
  private var receiving: Task<Void, Never>?
  private let viewer: URL
  private let h264: Bool
  private let session: URLSession

  init(viewer: URL, h264: Bool, configuration: URLSessionConfiguration = .ephemeral) {
    self.viewer = viewer
    self.h264 = h264
    session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
  }

  func start(preferRTC: Bool) {
    guard mode == .connecting, rtc == nil, socket == nil else { return }
    guard preferRTC else { return startWebSocket() }
    let rtc = SimulatorRTC(viewer: viewer, h264: h264, session: session)
    self.rtc = rtc
    rtc.onOpen = { [weak self, weak rtc] in
      guard let self, let rtc, self.rtc === rtc, self.mode != .closed else { return }
      self.mode = .webRTC
      Self.log.info("open: WebRTC data channels")
      self.onOpen?()
    }
    rtc.onMessage = { [weak self, weak rtc] message in
      guard let self, let rtc, self.rtc === rtc, self.mode == .webRTC else { return }
      self.onMessage?(message)
    }
    rtc.onFailure = { [weak self, weak rtc] code in
      guard let self, let rtc, self.rtc === rtc, self.mode != .closed else { return }
      self.rtc = nil
      self.mode = .connecting
      Self.log.info("WebRTC failed (\(code, privacy: .public)); falling back to WebSocket")
      self.onFallback?()
      // Codec rejection changes the next connection's codec as well.
      if code == 4002 { return self.fail(code) }
      self.startWebSocket()
    }
    rtc.start()
  }

  private func startWebSocket() {
    guard mode != .closed,
          let address = SimulatorRemote.endpoint(viewer, "stream",
            query: h264 ? [URLQueryItem(name: "codec", value: "h264")] : [], websocket: true) else { return fail(1000) }
    let socket = session.webSocketTask(with: SimulatorRemote.request(viewer, address, timeout: 20))
    self.socket = socket
    socket.maximumMessageSize = 16 * 1024 * 1024 + 16
    socket.resume()
    mode = .webSocket
    Self.log.info("open: WebSocket")
    onOpen?()
    receiving = Task { [weak self] in
      while !Task.isCancelled {
        let message: URLSessionWebSocketTask.Message
        do { message = try await socket.receive() } catch {
          guard let self, self.socket === socket else { return }
          self.fail(socket.closeCode.rawValue)
          return
        }
        guard let self, self.socket === socket, self.mode == .webSocket else { return }
        self.onMessage?(message)
      }
    }
  }

  func send(_ envelope: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: envelope),
          let text = String(data: data, encoding: .utf8) else { return }
    switch mode {
    case .webRTC: rtc?.send(text)
    case .webSocket: socket?.send(.string(text)) { _ in }
    case .connecting, .closed: break // Inputs are never queued for a future transport.
    }
  }

  func perform(operationId: String, control: [String: String]) async -> Bool {
    switch mode {
    case .webRTC:
      // An unacknowledged command may already have executed. Never retry via HTTP.
      return await rtc?.requestControl(operationId: operationId, control: control) ?? false
    case .webSocket:
      return await SimulatorRemote.control(viewer, operationId: operationId, control: control, session: session)
    case .connecting, .closed:
      return false
    }
  }

  func close() {
    guard mode != .closed else { return }
    mode = .closed
    rtc?.close()
    rtc = nil
    receiving?.cancel()
    receiving = nil
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    session.invalidateAndCancel()
  }

  private func fail(_ code: Int) {
    guard mode != .closed else { return }
    close()
    onClose?(code)
  }

  /// The viewer URL carries a capability. Never follow a redirect with its
  /// signaling body or Origin to a different endpoint.
  private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
  }
}
