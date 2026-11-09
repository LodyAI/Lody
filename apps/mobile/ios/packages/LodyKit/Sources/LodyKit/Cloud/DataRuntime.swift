import LodyRuntime
import LodyCore
import WebKit
import UIKit

// The owner lives in Swift, so a wedged JS event loop cannot disable its watchdog.
@MainActor
final class DataRuntime: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  static weak var current: DataRuntime?
  var webView: WKWebView?
  var sessionId: String?
  private(set) var sessionSnapshot: (generation: Int, json: String)?
  private var retainedSessions: [String] = []
  private var sessionWatchers = SessionSubscriptions()
  var reservedSessions: [String] = []
  var userId = ""
  private let localStore: LocalStore
  let billing = WorkspaceBilling()
  private var cacheErrorShown = false
  private var timer: Timer?
  var attachmentTasks: [String: Task<Void, Never>] = [:]
  var attachmentAttempts: [String: UUID] = [:]
  var grantTask: URLSessionDataTask?
  var grantWaiters: [String] = []
  var channel: RuntimeChannel?
  var contractReady = false
  private var handshakeDeferred = false
  var githubTasks: [String: Task<Void, Never>] = [:]
  var shareTasks: [String: Task<Void, Never>] = [:]
  var health = RuntimeHealth()
  private var pingPending = false
  var workspace: String?
  var owner = ""
  var generation = 0
  var backgrounded = false
  private var phase = "stopped"
  private var reason = ""
  private var lastStartReason = ""
  private var acknowledgements = 0
  var backgroundProbe = false
  var probeUpdates = 0
  var probeBackgroundUpdates = 0
  private let observers = NotificationObservers()
  var onCatalogUpdate: ((_ owner: String, _ state: String, _ catalog: String?) -> Void)?
  var onMachinePresence: ((_ owner: String, _ presence: RuntimeContract.MachinePresence?) -> Void)?
  var knownRepos: [String: String] = [:]
  private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

  init(localStore: LocalStore) {
    self.localStore = localStore
    super.init()
    observers.add(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.workspace != nil else { return }
        self.backgrounded = true
        self.health.suspend()
        self.publishPresenceUnknown()
        self.dispatch(RuntimeContract.Calls.SetActive.self, .init(active: false))
      }
    })
    observers.add(NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { _ in
      MainActor.assumeIsolated { ContentStore.shared.clearAll() }
    })
    observers.add(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.workspace != nil, self.backgrounded else { return }
        self.backgrounded = false
        self.recordRuntime("runtime_resume", phase: self.phase, reason: self.reason, extra: [
          "hasView": String(self.webView != nil), "contractReady": String(self.contractReady),
          "handshakeDeferred": String(self.handshakeDeferred),
        ])
        self.health.resume(at: self.now)
        if self.webView == nil { self.build(reason: "foreground") }
        else {
          self.dispatch(RuntimeContract.Calls.SetActive.self, .init(active: true))
          if self.handshakeDeferred, let view = self.webView {
            self.handshakeDeferred = false
            self.handshake(view)
          }
          self.tick()
        }
      }
    })
  }
  func start(workspace: String, owner: String, userId: String) {
    disposeView()
    if self.workspace != workspace || self.userId != userId {
      sessionId = nil; sessionSnapshot = nil; retainedSessions = []; reservedSessions = []; billing.clear()
    }
    self.userId = userId; cacheErrorShown = false
    self.workspace = workspace; self.owner = owner; health = RuntimeHealth()
    backgrounded = UIApplication.shared.applicationState == .background
    if backgrounded { publish("background", reason: "paused") }
    else { build(reason: "subscribe") }
  }
  func stop(owner: String? = nil) {
    if let owner, self.owner != owner { return }
    workspace = nil; sessionId = nil; retainedSessions = []; reservedSessions = []; userId = ""; billing.clear(); disposeView(); publish("stopped", reason: "unsubscribe")
  }
  func status() -> [String: any Sendable] {
    var value: [String: any Sendable] = ["owner": owner, "generation": generation, "state": phase, "reason": reason, "acknowledgements": acknowledgements, "lastStartReason": lastStartReason]
    if backgroundProbe {
      value["probeBackgroundUpdates"] = probeBackgroundUpdates
      value["probeUpdates"] = probeUpdates
      value["backgroundTaskState"] = SessionBackgroundTasks.shared.debugState
      value["backgroundTaskCount"] = SessionBackgroundTasks.shared.debugCount
    }
    return value
  }
  private func publish(_ state: String, reason: String, catalog: String? = nil) {
    if state != phase { recordRuntime("runtime_phase", phase: state, reason: reason) }
    self.phase = state; self.reason = reason
    emitStatus()
    onCatalogUpdate?(owner, state, catalog)
  }
  private func emitStatus(_ extra: [String: Any] = [:]) {
    let event = (status() as [String: Any]).merging(extra, uniquingKeysWith: { _, new in new })
    if sessionSnapshot?.generation != generation || ["starting", "background", "failed", "stopped"].contains(phase) {
      sessionSnapshot = nil
    }
    if let json = extra["session"] as? String { sessionSnapshot = (generation, json) }
    NotificationCenter.default.post(name: .lodyDataRuntimeEvent, object: self, userInfo: event)
  }
  private func publishPresenceUnknown() {
    emitStatus()
    onMachinePresence?(owner, nil)
  }
  private func build(reason: String) {
    guard workspace != nil else { return }
    disposeView(); lastStartReason = reason; generation += 1; health.started(at: now); acknowledgements = 0
    let view = RuntimeDocument.makeWebView(handler: self, delegate: self)
    // A signature drift silently drops the optional policy witness, and with it the navigation guard.
    assert(responds(to: #selector(webView(_:decidePolicyFor:decisionHandler:) as (WKWebView, WKNavigationAction, @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) -> Void)))
    webView = view
    publish("starting", reason: reason)
    timer = Timer(timeInterval: 2, repeats: true) { [weak self] timer in
      guard self != nil else { timer.invalidate(); return }
      MainActor.assumeIsolated { self?.tick() }
    }
    if let timer { RunLoop.main.add(timer, forMode: .common) }
    if backgroundProbe {
      view.loadHTMLString(Self.backgroundProbeHTML, baseURL: URL(string: "https://lody.ai"))
      return
    }
    do {
      try RuntimeDocument.load(in: view, bundle: Bundle.main)
    } catch { disposeView(); publish("failed", reason: "missing_resource") }
  }
  private func disposeView() {
    SessionBackgroundTasks.shared.finishAll(owner: owner)
    for task in attachmentTasks.values { task.cancel() }
    attachmentTasks.removeAll()
    attachmentAttempts.removeAll()
    timer?.invalidate(); timer = nil
    grantTask?.cancel(); grantTask = nil; grantWaiters.removeAll()
    channel?.close("runtime_replaced"); channel = nil; contractReady = false; handshakeDeferred = false
    githubTasks.values.forEach { $0.cancel() }; githubTasks.removeAll()
    shareTasks.values.forEach { $0.cancel() }; shareTasks.removeAll()
    pingPending = false
    let old = webView; webView = nil
    old?.configuration.userContentController.removeScriptMessageHandler(forName: "dataRuntime")
    old?.navigationDelegate = nil
    old?.stopLoading()
  }
  func recover(_ reason: String) {
    guard workspace != nil else { return }
    recordRuntime("runtime_recover", phase: phase, reason: reason, extra: ["hasView": String(webView != nil)])
    if backgrounded { disposeView(); publish("background", reason: reason); return }
    if health.allowRestart(at: now) { build(reason: reason) }
    else { disposeView(); publish("failed", reason: "restart_limit") }
  }
  private func tick() {
    guard !backgrounded, webView != nil else { return }
    if health.timedOut(at: now) { recover(health.ready ? "heartbeat_timeout" : "startup_timeout"); return }
    guard health.ready, contractReady, !pingPending, let channel else { return }
    pingPending = true
    Task { @MainActor [weak self] in
      let alive = (try? await channel.call(RuntimeContract.Calls.Ping.self, .init())) != nil
      guard let self, self.channel === channel else { return }
      self.pingPending = false
      if alive { self.health.acknowledged(at: self.now); self.acknowledgements += 1 }
    }
  }
  func dispatch<C: RuntimeCall>(_ call: C.Type, _ params: C.Params) {
    guard contractReady, let channel else { return }
    Task { @MainActor in _ = try? await channel.call(call, params) }
  }
  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let view = webView, message.webView === view, message.frameInfo.isMainFrame,
          let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
    switch type {
    case "ready":
      guard !health.ready, workspace != nil else { return }
      health.acknowledged(at: now)
      publish("syncing", reason: "runtime_ready")
      handshake(view)
    case "envelope":
      guard let envelope = body["envelope"] as? String else { return }
      channel?.receive(envelope)
    case "backgroundProbe":
      guard backgroundProbe else { return }
      probeUpdates += 1
      if UIApplication.shared.applicationState == .background { probeBackgroundUpdates += 1 }
      emitStatus()
    default: break
    }
  }
  private func receiveSession(_ id: String, session: String?, synced: Bool?, work: (id: String, state: String)?, active: Bool) {
    if let work { SessionBackgroundTasks.shared.update(id: work.id, state: work.state, owner: owner) }
    guard let session else { return }
    let fits = session.utf8.count <= 12 * 1024 * 1024
    if fits, synced == true, let workspace, !userId.isEmpty {
      let generation = self.generation, userId = self.userId
      LocalStore.queue.async { [weak self] in
        guard let self else { return }
        do { try self.localStore.writeSession(session, userId: userId, workspace: workspace, id: id) }
        catch {
          DispatchQueue.main.async { [weak self] in
            guard let self, self.generation == generation, self.workspace != nil, !self.cacheErrorShown else { return }
            self.cacheErrorShown = true
            self.emitStatus(["reason": "session_cache_failed"])
          }
        }
      }
    }
    guard active, id == sessionId else { return }
    let payload = fits ? session : #"{"v":1,"overflow":true}"#
    emitStatus(["sessionId": id, "session": payload])
  }
  func openSession(_ id: String) {
    if sessionId != id { sessionSnapshot = nil }
    sessionId = id
    dispatch(RuntimeContract.Calls.OpenSession.self, .init(sessionId: id))
  }
  func loadOlderSession(_ id: String) {
    dispatch(RuntimeContract.Calls.LoadOlderSession.self, .init(sessionId: id))
  }
  func watchSession(_ id: String) {
    sessionWatchers.retain(id)
    openSession(id)
  }
  // A replaced chat page can deinit after its successor opened the same session.
  func unwatchSession(_ id: String) {
    if sessionWatchers.release(id) { closeSession(id) }
  }
  func closeSession(_ id: String) {
    ContentStore.shared.clear(session: id)
    guard sessionId == id else { return }
    sessionId = nil
    sessionSnapshot = nil
    dispatch(RuntimeContract.Calls.CloseSession.self, .init())
    emitStatus()
  }
  func ensureSession(_ id: String, sink: ReplySink) {
    guard workspace != nil, !id.isEmpty else {
      fail(sink, "not_ready", String(localized: "native.runtime.sessionNotSynced", bundle: .lody))
      return
    }
    call(RuntimeContract.Calls.EnsureSession.self, .init(sessionId: id), sink: sink) { _ in nil }
  }
  private func handshake(_ view: WKWebView) {
    self.channel?.close("runtime_replaced")
    let channel = RuntimeChannel(generation: generation, post: { [weak view] envelope in
      guard let view else { return }
      RuntimeDocument.deliver(envelope, to: view)
    })
    channel.onEvent = { [weak self] event in self?.handle(event) }
    channel.onRequest = { [weak self] id, request in self?.handle(id, request) }
    self.channel = channel
    let generation = self.generation
    Task { @MainActor [weak self, weak view] in
      let outcome: Result<RuntimeContract.HelloResult, RuntimeFailure>
      do { outcome = .success(try await channel.call(RuntimeContract.Calls.Hello.self, .init(protocol: RuntimeContract.version, gen: generation))) }
      catch { outcome = .failure(error as? RuntimeFailure ?? RuntimeFailure(code: "handshake_failed")) }
      guard let self, let view, self.webView === view, self.channel === channel else { return }
      if case .success(let hello) = outcome, hello.protocol == RuntimeContract.version,
         Set(RuntimeContract.runtimeMethods).isSubset(of: hello.methods) {
        self.contractReady = true
        self.startRuntime(view)
        return
      }
      if case .failure(let failure) = outcome, failure.code != "protocol_mismatch" {
        if self.backgrounded { self.handshakeDeferred = true }
        else { self.recover("handshake_failed") }
        return
      }
      self.disposeView()
      self.publish("failed", reason: "protocol_mismatch")
    }
  }
  private func startRuntime(_ view: WKWebView) {
    guard let workspace, let channel else { return }
    let params = RuntimeContract.StartParams(workspaceId: workspace, userId: userId, active: !backgrounded, knownRepos: knownRepos)
    Task { @MainActor [weak self, weak view] in
      let started = (try? await channel.call(RuntimeContract.Calls.Start.self, params)) != nil
      guard let self, let view, self.webView === view, self.channel === channel else { return }
      guard started else { self.recover("start_failed"); return }
      let current = self.sessionId.flatMap { $0.isEmpty ? nil : $0 }
      self.dispatch(RuntimeContract.Calls.RestoreSessions.self, .init(
        ids: self.retainedSessions, current: current, reserved: self.reservedSessions))
    }
  }
  private func handle(_ event: RuntimeContract.Event) {
    switch event {
    case .catalog(let value):
      guard value.catalog.utf8.count <= 12 * 1024 * 1024 else { return }
      publish("live", reason: "catalog", catalog: value.catalog)
    case .shareProgress(let value):
      NotificationCenter.default.post(name: .lodyShareProgress, object: value)
    case .machinePresence(let value):
      guard !backgrounded, value.onlineMachineIds.reduce(0, { $0 + $1.utf8.count }) <= 1024 * 1024 else { return }
      reason = "machine_presence"
      emitStatus(["creationOptionsChanged": true])
      onMachinePresence?(owner, value)
    case .creationOptionsChanged:
      emitStatus(["creationOptionsChanged": true])
    case .synced:
      if phase != "live" { publish("live", reason: "synced") }
      emitStatus(["creationOptionsChanged": true])
    case .syncError(let value):
      publish("offline", reason: value.reason.rawValue)
    case .sessionSubscriptions(let value):
      retainedSessions = value.ids
      reservedSessions = value.reserved
    case .session(let value):
      receiveSession(value.sessionId, session: value.session, synced: value.synced,
        work: value.backgroundWork.map { ($0.id, $0.state.rawValue) }, active: true)
    case .sessionCache(let value):
      receiveSession(value.sessionId, session: value.session, synced: value.synced,
        work: value.backgroundWork.map { ($0.id, $0.state.rawValue) }, active: false)
    case .sessionTrace(let value):
      recordSessionTrace(value)
    #if DEBUG
    case .diagnostic(let value):
      NSLog("LodyRuntime stage=%@ stream=%@", value.stage, value.stream)
    #else
    case .diagnostic: break
    #endif
    }
  }
  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
    decisionHandler(RuntimeDocument.allows(navigationAction) ? .allow : .cancel)
  }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { if self.webView === webView { recover("process_terminated") } }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { if self.webView === webView { recover("navigation_failed") } }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if self.webView === webView { recover("navigation_failed") } }
}

final class NotificationObservers {
  private var tokens: [NSObjectProtocol] = []
  func add(_ token: NSObjectProtocol) { tokens.append(token) }
  deinit { for token in tokens { NotificationCenter.default.removeObserver(token) } }
}
