import Foundation

struct SessionRuntimeEvent: Sendable {
  var generation = -1
  var state = ""
  var sessionId: String?
  var session: String?

  init(generation: Int = -1, state: String = "", sessionId: String? = nil, session: String? = nil) {
    (self.generation, self.state, self.sessionId, self.session) = (generation, state, sessionId, session)
  }

  init(_ info: [AnyHashable: Any]) {
    self.init(
      generation: (info["generation"] as? NSNumber)?.intValue ?? -1, state: info["state"] as? String ?? "",
      sessionId: info["sessionId"] as? String, session: info["session"] as? String
    )
  }
}

struct SessionFeedState: Equatable, Sendable {
  var status = "syncing"
  var revision = -1
  var overflow = false
  var entriesJSON = "[]"
  var billableTurnCount: Int?
  var historyHasMore = false
  var historyLoading = false
  var composerJSON: String?
  var usageJSON: String?
  var preview: SessionBrowserPreview?
  var transcript = SessionTranscriptFacts()
  var isLiveUpdate = false
}

@MainActor
struct SessionFeedService {
  var watch: @MainActor (_ sessionId: String, _ receive: @escaping @MainActor (SessionRuntimeEvent) -> Void) -> @MainActor () -> Void
  var reconnect: @MainActor (_ sessionId: String) -> Void
  var cached: @Sendable (_ userId: String, _ workspaceId: String, _ sessionId: String) -> String?

  static let live = SessionFeedService(
    watch: { sessionId, receive in
      let observer = NotificationCenter.default.addObserver(forName: .lodyDataRuntimeEvent, object: nil, queue: .main) { note in
        let event = SessionRuntimeEvent(note.userInfo ?? [:])
        MainActor.assumeIsolated { receive(event) }
      }
      let runtime = DataRuntime.current
      runtime?.watchSession(sessionId)
      return {
        NotificationCenter.default.removeObserver(observer)
        runtime?.unwatchSession(sessionId)
      }
    },
    reconnect: { DataRuntime.current?.openSession($0) },
    cached: { userId, workspaceId, sessionId in
      guard let data = try? JSONSerialization.data(withJSONObject: [userId, workspaceId, sessionId], options: .withoutEscapingSlashes)
      else { return nil }
      return try? LocalStore.shared.read("session:" + String(decoding: data, as: UTF8.self))
    }
  )
}

@MainActor
final class SessionFeed {
  private(set) var state = SessionFeedState()
  var changed: (() -> Void)?
  private let service: SessionFeedService
  private let sessionId: String
  private let userId: String
  private let workspaceId: String
  private var cursor = (generation: -1, revision: -1)
  private var received = false
  private var awaitingSnapshot = true
  private var reportedStatus = ""
  private var unwatch: (@MainActor () -> Void)?
  private var token = 0
  private static let parsing = DispatchQueue(label: "ai.lody.mobile.session-feed", qos: .userInitiated)

  init(sessionId: String, userId: String, workspaceId: String, service: SessionFeedService = .live) {
    self.sessionId = sessionId
    self.userId = userId
    self.workspaceId = workspaceId
    self.service = service
  }

  var watching: Bool { unwatch != nil }
  var generation: Int { cursor.generation }

  func start() {
    guard unwatch == nil, !userId.isEmpty, !workspaceId.isEmpty else { return }
    token += 1
    cursor = (-1, -1)
    received = false
    awaitingSnapshot = true
    state = SessionFeedState()
    changed?()
    let token = token
    let (cached, userId, workspaceId, sessionId) = (service.cached, userId, workspaceId, sessionId)
    LocalStore.queue.async {
      let saved = cached(userId, workspaceId, sessionId).flatMap(SessionEnvelope.prepare)
      DispatchQueue.main.async {
        MainActor.assumeIsolated { [weak self] in
          guard let self, self.token == token, !self.received, let saved, saved.version == 1 else { return }
          self.state.entriesJSON = saved.entriesJSON
          self.state.transcript = saved.transcript
          self.state.preview = saved.preview
          self.state.historyHasMore = saved.historyHasMore
          self.changed?()
        }
      }
    }
    unwatch = service.watch(sessionId) { [weak self] event in self?.receive(event) }
  }

  func finish() {
    token += 1
    unwatch?()
    unwatch = nil
  }

  func reconnect() {
    guard unwatch != nil else { return }
    awaitingSnapshot = true
    service.reconnect(sessionId)
  }

  private func receive(_ event: SessionRuntimeEvent) {
    let token = token
    let generation = event.generation
    let session = event.sessionId == sessionId ? event.session : nil
    let phase = event.state
    // Parsing runs off the main thread; status-only events take the same queue to keep arrival order.
    Self.parsing.async {
      let envelope = session.map(SessionEnvelope.prepare)
      DispatchQueue.main.async {
        MainActor.assumeIsolated { [weak self] in
          guard let self, self.token == token else { return }
          if let envelope {
            self.apply(envelope, generation: generation)
          } else if ["starting", "background", "failed", "stopped"].contains(phase) {
            self.state.status = phase
            self.state.isLiveUpdate = false
            self.awaitingSnapshot = true
            self.changed?()
          }
          self.reportStatus()
        }
      }
    }
  }

  private func reportStatus() {
    guard state.status != reportedStatus else { return }
    reportedStatus = state.status
    DiagnosticsStore.shared.record("session-sync", "feed_status", fields: [
      "session": DiagnosticsStore.correlation(sessionId), "syncStatus": state.status,
    ])
  }

  private func apply(_ envelope: SessionEnvelope?, generation: Int) {
    guard let envelope else {
      state.status = "offline"
      state.isLiveUpdate = false
      awaitingSnapshot = true
      changed?()
      return
    }
    if envelope.overflow, envelope.version == 1 {
      state.overflow = true
      state.isLiveUpdate = false
      awaitingSnapshot = true
      changed?()
      return
    }
    guard envelope.accepted(generation: generation, after: cursor), let revision = envelope.revision else { return }
    let isLiveUpdate = !awaitingSnapshot && state.status == "live" && cursor.generation == generation
    cursor = (generation, revision)
    state.overflow = false
    if envelope.status == "live" {
      received = true
      awaitingSnapshot = false
      state = SessionFeedState(
        status: "live", revision: revision, entriesJSON: envelope.entriesJSON,
        billableTurnCount: envelope.billableTurnCount, historyHasMore: envelope.historyHasMore,
        historyLoading: envelope.historyLoading, composerJSON: envelope.composerJSON, usageJSON: envelope.usageJSON, preview: envelope.preview, transcript: envelope.transcript
      )
      state.isLiveUpdate = isLiveUpdate
    } else {
      state.isLiveUpdate = false
      awaitingSnapshot = true
      state.status = envelope.status
    }
    changed?()
  }
}

extension Notification.Name {
  static let lodyDataRuntimeEvent = Notification.Name("LodyDataRuntimeEvent")
}
