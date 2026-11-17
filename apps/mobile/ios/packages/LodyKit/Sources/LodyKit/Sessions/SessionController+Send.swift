import LodyCore
import LodyDesignSystem
import SwiftUI
import UIKit

@MainActor
struct SessionSendEnvironment {
  var store: @MainActor (_ userId: String, _ workspaceId: String) -> OutboxStore?
  var services: @MainActor () -> OutboxServices
  var inflight: OutboxInflight
  var serverCreated: @MainActor (_ sessionId: String) -> Bool
  var foreground: @MainActor (_ sessionId: String, _ active: Bool) -> Void
  var control: SessionControl.Request
  var composer: SessionComposerService
  var turn: @MainActor (_ payload: String) async throws -> String = { payload in
    guard let runtime = DataRuntime.current else { throw OutboxError.scopeExpired }
    return try await withCheckedThrowingContinuation { runtime.sendTurn(payload, sink: .continuation($0)) }
  }
  var readEdit: @MainActor (_ payload: String) async throws -> String = { payload in
    guard let runtime = DataRuntime.current else { throw OutboxError.scopeExpired }
    return try await withCheckedThrowingContinuation {
      runtime.dispatchTurn(payload, sink: .continuation($0), billing: nil, edit: true)
    }
  }

  static let live = SessionSendEnvironment(
    store: { OutboxSession.shared.outboxStore(user: $0, workspace: $1) },
    services: { OutboxSession.shared.services },
    inflight: OutboxSession.published.inflight,
    serverCreated: { OutboxSession.shared.serverCreated($0) },
    foreground: { id, active in
      if active { OutboxSession.shared.setForeground(id) } else { OutboxSession.shared.leaveForeground(id) }
    },
    control: SessionControl.live,
    composer: .live
  )
}

extension SessionController {
  func startSender(_ state: SessionListState) {
    guard sender == nil else { return }
    let sender = SessionSender(
      sessionId: sessionId, store: environment.store(state.userId, state.workspaceId),
      services: environment.services(), inflight: environment.inflight
    )
    sender.changed = { [weak self] in self?.renderComposer() }
    sender.clearDraft = { [weak self] in self?.chat.clearDraft(token: $0) }
    sender.restoreDraft = { [weak self] in self?.chat.restoreDraft(token: $0) }
    composerModel.changed = { [weak self] in self?.renderComposer() }
    control.changed = { [weak self] in self?.renderComposer() }
    self.sender = sender
    environment.foreground(sessionId, true)
    if persistsDraft { chat.setDraftKey("draft:\(state.userId):\(state.workspaceId):\(sessionId)") }
  }

  func wireSendEvents() {
    chat.onSend = { [weak self] body in
      guard let self, !SessionActions.isDeleting(self.source.state.workspaceId, self.sessionId), !self.planDecision.pending
      else { return }
      self.sender?.submit(body, choice: self.composerModel.sendChoice, role: self.composerModel.sendRole)
    }
    chat.onRetrySend = { [weak self] body in
      if body["forget"] as? Bool == true { self?.confirmForgetPendingInput(body["id"] as? String) }
      else if body["retryPending"] as? Bool == true, let id = body["id"] as? String { self?.retryPendingInput(id) }
      else { self?.sender?.retry() }
    }
    chat.onComposerOptionChange = { [weak self] body in self?.composerModel.change(body) }
    // The conversation composer is the new-chat composer (web's mobile session page): a card
    // with +, the run-config chip and Send, no @ button; the chip opens the run-config sheet.
    chat.composer.cardStyle = true
    // At rest one line (+, prompt, agent mark ⌄, Send); the card opens while editing.
    chat.composer.restsCollapsed = true
    chat.composer.onRunConfig = { [weak self] in self?.presentRunConfig() }
    chat.onStop = { [weak self] _ in self?.controlTurn("stop") }
    chat.onSteer = { [weak self] body in self?.controlTurn("steer", messageId: body["id"] as? String) }
  }

  private func retryPendingInput(_ id: String) {
    let workspace = source.state.workspaceId, user = source.state.userId
    Task { @MainActor [weak self] in
      guard let self, let runtime = DataRuntime.current, runtime.workspace == workspace, runtime.userId == user else { return }
      do {
        _ = try await runtime.workspaceCall(RuntimeContract.Calls.RetryPendingInput.self) { _, _ in
          RuntimeContract.ForgetPendingInputParams(sessionId: self.sessionId, inputId: id)
        }
      } catch {
        LodyToastOverlay.shared.show(message: String(localized: "native.chat.error.retryFailed", bundle: .lody), kind: .error)
      }
    }
  }

  private func confirmForgetPendingInput(_ selectedId: String?) {
    guard let inputId = selectedId ?? sender?.record?.sendId, !inputId.isEmpty else { return }
    let workspace = source.state.workspaceId, user = source.state.userId
    SettingsPage.confirm(from: self, title: String(localized: "send.forget.title", bundle: .lody),
      message: String(localized: "send.forget.message", bundle: .lody), action: String(localized: "send.forget.action", bundle: .lody), destructive: true) { [weak self] in
      Task { @MainActor [weak self] in
        guard let self, let runtime = DataRuntime.current else { return }
        guard runtime.workspace == workspace, runtime.userId == user else { return }
        do {
          _ = try await runtime.workspaceCall(RuntimeContract.Calls.ForgetPendingInput.self) { _, _ in
            RuntimeContract.ForgetPendingInputParams(sessionId: self.sessionId, inputId: inputId)
          }
          try await self.sender?.discardPending(inputId)
        } catch {
          LodyToastOverlay.shared.show(message: String(localized: "send.forget.failed", bundle: .lody), kind: .error)
        }
      }
    }
  }

  private func controlTurn(_ action: String, messageId: String? = nil) {
    guard let session = source.state.catalog.session(sessionId), let state = feed?.state else { return }
    control.act(
      action, messageId: messageId, session: session, transcript: state.transcript, live: state.status == "live",
      overflow: state.overflow, steerable: composerModel.steerable
    )
  }

  func renderComposer() {
    guard isViewLoaded, let session = source.state.catalog.session(sessionId) else { return }
    renderComposer(session, feed?.state ?? SessionFeedState())
  }

  func renderComposer(_ session: SessionItem, _ feed: SessionFeedState) {
    let state = source.state, live = feed.status == "live"
    composerModel.hydrate(
      pending: sender?.record, ready: sender?.ready == true,
      snapshot: feed.composerJSON.flatMap { CreateJSON.decode(ModelChoice.self, $0) },
      role: Self.composerRole(feed.composerJSON)
    )
    let project = state.catalog.projects.first { $0.id == session.projectId }
    // A multi-repository project's session reads workspace-wide options, as a plain chat.
    let optionsProject = project?.id.hasPrefix(CreateSessionSelection.groupPrefix) == true ? nil : project?.id
    composerModel.load(workspaceId: state.workspaceId, projectId: optionsProject, session: session)
    let billable = live ? feed.billableTurnCount : nil
    composerModel.watchTier(workspaceId: state.workspaceId, userId: state.userId, watch: (billable ?? 0) >= 25)
    let locked = SessionQuota.locked(count: billable, tier: composerModel.tier)
    announceQuota(live: live, locked: locked)
    let steerable = composerModel.steerable
    let behavior = queuedMessageBehavior
    let context = OutboxForeground(
      live: live, overflow: feed.overflow, serverCreated: environment.serverCreated(sessionId), steerable: steerable,
      promptBusy: OutboxDispatcher.busy.contains(session.status), queuedMessageBehavior: behavior, transcript: feed.transcript
    )
    let inputs = SessionSender.Inputs(
      userId: state.userId, connected: state.connected && !state.loading, session: session, context: context
    )
    if let sender, sender.inputs != inputs { sender.update(inputs) }
    let control = self.control.state(
      session: session, transcript: feed.transcript, live: live, overflow: feed.overflow, steerable: steerable
    )
    let deleting = SessionActions.isDeleting(state.workspaceId, sessionId)
    var composer: [String: Any] = [
      "editable": !session.archived && !deleting && !locked,
      "canSend": sender?.canSend == true && !deleting && !locked && !planDecision.pending && !errorRetry.pending,
      "sending": sender?.sending == true,
      "running": control.running || sender?.awaitingReply == true,
      "canStop": control.canStop, "stopping": control.stopping, "controlling": control.controlling,
      "steerID": control.steerID, "steerInterrupts": control.steerInterrupts,
      "queuedMessageBehavior": behavior,
      "notice": feed.overflow ? String(localized: "chat.notice.syncStopped", bundle: .lody) : "",
      "quotaNotice": locked ? "" : quotaNotice(feed.billableTurnCount, live: live),
      "quotaLocked": locked,
      "reconnect": feed.overflow,
      "connection": connection(feed),
      "placeholder": placeholder(session, locked: locked),
    ]
    let busy = control.running || sender?.awaitingReply == true || sender?.sending == true || OutboxDispatcher.busy.contains(session.status)
    composer["actionBar"] = actionBarState(session, busy: busy)
    composer["usage"] = sessionUsage(session, feed: feed)
    adjustComposer(&composer)
    apply("composer", Self.json(composer), chat.setComposerState)
    apply("options", composerModel.optionsJSON, chat.setComposerOptions)
    apply("pending", sender?.pendingSendJSON ?? "", chat.setPendingSendJSON)
    renderDecisions(feed)
    renderEditable(feed, enabled: live && state.connected && !state.loading && !session.archived && sender?.sending != true
      && !control.controlling && !feed.overflow && !deleting && !locked)
  }

  private func sessionUsage(_ session: SessionItem, feed: SessionFeedState) -> [String: Any]? {
    var usage = feed.usageJSON.flatMap { CreateJSON.decode(ChatSessionUsage.self, $0) } ?? ChatSessionUsage()
    let model = composerModel.active.modelId
    let catalog = RemoteSettingsContext.current().agentUsage[session.machineId]
    if catalog != nil || (model != nil && model != usage.modelId) { usage.quota = nil }
    if let quota = SessionUsageSelection.quota(catalog, configId: session.agentConfigId, provider: session.agentType, model: model) {
      usage.quota = .init(name: quota.name, windows: quota.windows.map {
        .init(label: $0.label, usedPercent: $0.usedPercent, duration: $0.duration, resetsAt: $0.resetsAt)
      })
    }
    let previousLabel = model == usage.modelId ? usage.modelLabel : nil
    usage.modelLabel = composerModel.capability?.models.first { $0.id == model }?.name ?? previousLabel ?? model
    usage.quotaEligible = usage.quota != nil
    guard usage.visible, let data = try? JSONEncoder().encode(usage) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }

  func apply(_ key: String, _ value: String, _ set: (String) -> Void) {
    guard rendered[key] != value else { return }
    rendered[key] = value
    set(value)
  }

  private func connection(_ feed: SessionFeedState) -> String {
    if feed.overflow { return "" }
    if ["offline", "failed", "stopped"].contains(feed.status) { return "paused" }
    return feed.status == "live" ? "" : "connecting"
  }

  private func placeholder(_ session: SessionItem, locked: Bool) -> String {
    if session.archived { return String(localized: "chat.composer.archived", bundle: .lody) }
    if locked { return "" }
    // Web: "Work with <assistant>" — the Agent Role when one is, else the conversation's agent.
    guard let name = composerModel.activeRole?.role.name ?? composerModel.agentName, !name.isEmpty else {
      return String(localized: "chat.composer.placeholder", bundle: .lody)
    }
    return String.localizedStringWithFormat(String(localized: "create.composer.placeholderAgent", bundle: .lody), name)
  }

  /// The Role the latest turn ran as, from the runtime's composer projection: absent is unknown,
  /// null an explicit None.
  static func composerRole(_ json: String?) -> String?? {
    guard let data = json?.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let value = object["agentRoleId"] else { return nil }
    if let id = value as? String, !id.isEmpty { return .some(id) }
    return value is NSNull ? .some(nil) : nil
  }

  /// Web's mobile run-config sheet from the composer chip, the same sheet as a new chat.
  func presentRunConfig() {
    guard presentedViewController == nil else { return }
    let rows = composerModel.runConfig
    guard !rows.isEmpty else { return }
    chat.endEditing(true)
    let state = CreatePanelState()
    state.runConfig = rows
    state.onPick = { [weak self, weak state] row, option in
      guard let self else { return }
      self.composerModel.pick(row, option)
      state?.runConfig = self.composerModel.runConfig
    }
    let sheet = UIHostingController(rootView: CreateRunConfigSheet(state: state))
    var contentHeight = CGFloat(rows.count) * (LodySize.controlMd + LodySpacing.xs * 2)
      + LodySpacing.xl + LodySize.controlMd + LodySpacing.lg
    sheet.rootView = CreateRunConfigSheet(state: state, onHeightChange: { [weak sheet] height in
      guard height > 0, abs(contentHeight - height) > 1 else { return }
      contentHeight = height
      sheet?.sheetPresentationController?.animateChanges {
        sheet?.sheetPresentationController?.invalidateDetents()
      }
    })
    if let presentation = sheet.sheetPresentationController {
      presentation.detents = [.custom(identifier: .init("runConfigContent")) { context in
        min(contentHeight, context.maximumDetentValue)
      }]
      presentation.prefersGrabberVisible = true
    }
    sheet.view.accessibilityIdentifier = "session-run-config"
    present(sheet, animated: true)
  }

  private func quotaNotice(_ count: Int?, live: Bool) -> String {
    guard live, let remaining = SessionQuota.remaining(count: count, tier: composerModel.tier) else { return "" }
    if remaining == 0 { return String(localized: "chat.composer.freeTurnLimit", bundle: .lody) }
    return String.localizedStringWithFormat(String(localized: "chat.composer.freeTurnsRemaining", bundle: .lody), remaining)
  }

  private func announceQuota(live: Bool, locked: Bool) {
    guard live, composerModel.tier != nil, quotaEntry == "pending" else { return }
    quotaEntry = locked ? "closed" : "open"
    guard locked else { return }
    let alert = UIAlertController(
      title: String(localized: "chat.composer.freeTurnLimitTitle", bundle: .lody),
      message: String(localized: "chat.composer.freeTurnLimitBody", bundle: .lody), preferredStyle: .alert
    )
    alert.addAction(UIAlertAction(title: String(localized: "common.ok", bundle: .lody), style: .default))
    present(alert, animated: true)
  }
}
