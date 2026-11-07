import LodyCore
import UIKit

extension SessionController {
  func wireDecisionEvents() {
    planDecision.changed = { [weak self] in self?.renderComposer() }
    errorRetry.changed = { [weak self] in self?.renderComposer() }
    chat.onPlanDecision = { [weak self] body in
      guard let self else { return }
      let (entryId, itemId) = (body["entryId"] as? String ?? "", body["itemId"] as? String ?? "")
      let action = body["action"] as? String ?? "", id = body["id"] as? String ?? ""
      let target = feed?.state.transcript.proposedPlan, enabled = decisionsEnabled.plan
      let choice = SessionDecision.planExecutionChoice(composerModel.active, composerModel.capability)
      Task {
        await self.planDecision.decide(
          target: target, enabled: enabled, entryId: entryId, itemId: itemId, action: action, id: id
        ) { [weak self] _, id in
          try await self?.turn(id: id, text: String(localized: "native.chat.proposedPlan.executePrompt", bundle: .lody), choice: choice) ?? ""
        }
      }
    }
    chat.onEditMessage = { [weak self] body in
      guard let self, let entryId = body["entryId"] as? String, !entryId.isEmpty, entryId == chat.editableMessageID else { return }
      let editor = EditMessageController(sessionId: sessionId, entryId: entryId)
      editor.onFinish = { [weak self] id in self?.chat.editedMessageID = id }
      LodyShell.shared.presentNative(editor, title: String(localized: "chat.edit.title", bundle: .lody), dismissible: false, style: "fullScreen")
    }
    chat.onErrorRetry = { [weak self] body in
      guard let self else { return }
      let target = feed?.state.transcript.retryableError, enabled = decisionsEnabled.retry
      let choice = composerModel.active
      Task {
        await self.errorRetry.decide(
          target: target, enabled: enabled, entryId: body["entryId"] as? String ?? "", itemId: body["itemId"] as? String ?? "",
          id: body["id"] as? String ?? ""
        ) { [weak self] target, id in
          let text = target.detail == "acp_provider_overloaded"
            ? SessionDecision.capacityContinuation : SessionDecision.errorContinuation
          return try await self?.turn(id: id, text: text, choice: choice) ?? ""
        }
      }
    }
  }

  var decisionsEnabled: (plan: Bool, retry: Bool) {
    guard let session = source.state.catalog.session(sessionId), let feed = feed?.state, let sender else { return (false, false) }
    let state = source.state
    let control = control.state(
      session: session, transcript: feed.transcript, live: feed.status == "live", overflow: feed.overflow,
      steerable: composerModel.steerable
    )
    let billable = feed.status == "live" ? feed.billableTurnCount : nil
    let ready = feed.status == "live" && state.connected && !state.loading && sender.canSend && !sender.sending
      && !sender.awaitingReply && !control.running && !control.controlling && !feed.overflow && !session.archived
      && !state.userId.isEmpty
    let retry = ready
    let plan = ready && session.agentType == "codex" && session.status == "idle" && !errorRetry.pending
      && !SessionActions.isDeleting(state.workspaceId, sessionId) && !SessionQuota.locked(count: billable, tier: composerModel.tier)
    return (plan, retry)
  }

  func renderDecisions(_ feed: SessionFeedState) {
    let enabled = decisionsEnabled
    let plan = planDecision.state(target: feed.transcript.proposedPlan, enabled: enabled.plan, answered: feed.transcript.answered)
    let retry = errorRetry.state(target: feed.transcript.retryableError, enabled: enabled.retry, answered: feed.transcript.answered)
    apply("plan", Self.json(plan), chat.setPlanDecisionState)
    apply("retry", Self.json(retry), chat.setErrorRetryState)
  }

  func renderEditable(_ feed: SessionFeedState, enabled: Bool) {
    let latest = feed.transcript.editableUserId ?? ""
    let check = enabled && !latest.isEmpty ? "\(feed.transcript.editEligibility):\(self.feed?.generation ?? 0)" : ""
    if check != editCheck {
      editCheck = check
      editable = ""
      if !check.isEmpty { readEditable(latest, check: check) }
    }
    let value = enabled && editable == latest ? editable : ""
    if chat.editableMessageID != value { chat.editableMessageID = value }
  }

  private func readEditable(_ id: String, check: String) {
    let payload = Self.json(["action": "read", "sessionId": sessionId, "expectedUserTurnId": id])
    Task { [weak self] in
      guard let self, let result = try? await environment.readEdit(payload) else { return }
      let reply = try? JSONSerialization.jsonObject(with: Data(result.utf8)) as? [String: Any]
      guard editCheck == check, reply?["state"] as? String == "ready" else { return }
      editable = id
      renderComposer()
    }
  }

  private func turn(id: String, text: String, choice: ModelChoice) async throws -> String {
    guard let session = source.state.catalog.session(sessionId) else { throw OutboxError.scopeExpired }
    let capability = composerModel.capability
    var payload: [String: Any] = [
      "id": id, "sessionId": sessionId, "machineId": session.machineId, "userId": source.state.userId,
      "cliType": session.cliType, "agentType": session.agentType, "text": text, "attachments": [Any](),
      "queue": false, "guide": false,
    ]
    payload["resume"] = session.resume
    payload["modeId"] = choice.modeId
    payload["reasoningEffortConfigId"] = capability?.reasoningEffortConfigId
    for (key, value) in [("modelId", choice.modelId), ("reasoningEffort", choice.effort)] {
      if let value { payload[key] = value } else if capability != nil { payload[key] = NSNull() }
    }
    if let values = choice.configOptionValues {
      payload["configOptionValues"] = values.mapValues { value -> Any in
        switch value {
        case .string(let text): text
        case .bool(let flag): flag
        }
      }
    }
    return try await environment.turn(Self.json(payload))
  }
}
