import LodyCore
import UIKit

/// Runtime reads behind the More menu's Copy submenu; preview fixtures script them.
@MainActor
struct SessionCopyService {
  var workspacePath: (_ workspaceId: String, _ sessionId: String) async throws -> String?
  var markdown: (_ params: RuntimeContract.ConversationMarkdownParams) async throws -> RuntimeContract.ConversationMarkdownResult

  static var live: SessionCopyService {
    SessionCopyService(
      workspacePath: { workspaceId, sessionId in
        try await scoped(workspaceId).workspaceCall(RuntimeContract.Calls.SessionWorkspacePath.self) { workspace, _ in
          .init(workspaceId: workspace, sessionId: sessionId)
        }.path
      },
      markdown: { params in
        try await scoped(params.workspaceId).perform(RuntimeContract.Calls.ConversationMarkdown.self, params)
      }
    )
  }

  private static func scoped(_ workspaceId: String) throws -> DataRuntime {
    guard let runtime = DataRuntime.current, runtime.workspace == workspaceId else {
      throw DataRuntime.failure("not_ready", String(localized: "native.runtime.sessionNotSynced", bundle: .lody))
    }
    return runtime
  }
}

/// The conversation More menu's session actions, as web `SessionHeaderMenu`: Rename,
/// Change owner (multi-member workspaces) and the Copy submenu (base branch when it
/// differs from the current one, path, Markdown, URL, deeplink).
extension SessionController {
  /// Web share origin for app session URLs (`VITE_SITE_URL`, official Lody Cloud).
  static let appShareOrigin = "https://lody.ai"

  func sessionMenuItems(_ session: SessionItem) -> [UIMenuElement] {
    var items: [UIMenuElement] = []
    if !session.archived {
      items.append(UIAction(title: text("session.action.rename"), image: UIImage(systemName: "pencil")) { [weak self] _ in
        self?.perform("rename")
      })
      if let owner = ownerMenu(session) { items.append(owner) }
    }
    items.append(copyMenu(session))
    return items
  }

  /// Every workspace member with the current owner checked; a departed owner checks nobody.
  private func ownerMenu(_ session: SessionItem) -> UIMenu? {
    let members = chat.members.values.sorted {
      $0.name.localizedStandardCompare($1.name) == .orderedAscending
    }
    guard members.count > 1 else { return nil }
    let pending = pendingOwner?.sessionId == sessionId ? pendingOwner?.userId : nil
    let rows = members.map { member in
      UIAction(
        title: member.name,
        subtitle: member.id == pending ? text("session.owner.changing") : nil,
        image: ownerAvatar(member),
        attributes: pending == nil ? [] : .disabled,
        state: member.id == session.userId ? .on : .off
      ) { [weak self] _ in self?.changeOwner(to: member, from: session) }
    }
    return UIMenu(title: text("session.owner.change"), image: UIImage(systemName: "person.crop.circle.badge.checkmark"), children: rows)
  }

  private func ownerAvatar(_ member: WorkspaceMember) -> UIImage {
    if let image = member.image.flatMap(LodyListPhoto.url).flatMap({ LodyListPhoto.cached($0) }) { return image }
    return LodyListPhoto.monogram(String(member.name.prefix(1)).uppercased(), side: 24)
  }

  private func changeOwner(to member: WorkspaceMember, from session: SessionItem) {
    // The menu can be rebuilt while the write is in flight; guard here, not only via `.disabled`.
    guard member.id != session.userId, pendingOwner == nil else { return }
    let workspace = source.state.workspaceId
    let target = (sessionId: sessionId, userId: member.id)
    pendingOwner = target
    render()
    Task { [weak self] in
      guard let self else { return }
      do {
        try await self.source.write(workspace, self.sessionId, .owner(member.id))
        LodyToastOverlay.shared.show(message: String(format: self.text("session.owner.changed"), member.name), kind: .neutral)
      } catch {
        LodyToastOverlay.shared.show(message: self.text("session.owner.changeFailed"), kind: .error)
      }
      if let current = self.pendingOwner, current == target { self.pendingOwner = nil }
      self.render()
    }
  }

  private func copyMenu(_ session: SessionItem) -> UIMenu {
    var groups: [UIMenuElement] = []
    let current = session.branchName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let base = session.baseBranch?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !current.isEmpty, !base.isEmpty, current != base {
      groups.append(UIMenu(options: .displayInline, children: [
        UIAction(title: text("session.copy.baseBranch"), subtitle: base, image: UIImage(systemName: "arrow.triangle.branch")) { _ in
          Self.copy(base, toast: "session.copy.baseBranchCopied")
        },
      ]))
    }
    groups.append(UIMenu(options: .displayInline, children: [
      UIAction(title: text("session.copy.path"), image: UIImage(systemName: "folder")) { [weak self] _ in self?.copyPath() },
      UIAction(title: text("session.copy.markdown"), image: UIImage(systemName: "doc.plaintext")) { [weak self] _ in self?.copyMarkdown() },
      UIAction(title: text("session.copy.url"), image: UIImage(systemName: "link")) { [weak self] _ in self?.copyLink(deeplink: false) },
      UIAction(title: text("session.copy.deeplink"), image: UIImage(systemName: "link")) { [weak self] _ in self?.copyLink(deeplink: true) },
    ]))
    return UIMenu(title: text("session.copy.title"), image: UIImage(systemName: "doc.on.doc"), children: groups)
  }

  /// Web `buildAppSessionUrl` / `buildSessionLink`: the HTTPS app page or the `lody://` resource link.
  static func sessionLink(sessionId: String, workspaceId: String, slug: String?, deeplink: Bool) -> String? {
    let safe = { (value: String) in !value.isEmpty && value.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") } }
    if deeplink {
      guard safe(sessionId), safe(workspaceId) else { return nil }
      return "lody://session/\(sessionId)?workspace=\(workspaceId)"
    }
    let trimmed = slug?.trimmingCharacters(in: CharacterSet(charactersIn: "/").union(.whitespaces)) ?? ""
    guard !trimmed.isEmpty, !sessionId.isEmpty,
      let encoded = trimmed.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return nil }
    return "\(appShareOrigin)/\(encoded)/sessions/\(sessionId)"
  }

  private func copyLink(deeplink: Bool) {
    let state = source.state
    guard let link = Self.sessionLink(sessionId: sessionId, workspaceId: state.workspaceId, slug: state.workspace?.slug, deeplink: deeplink) else {
      LodyToastOverlay.shared.show(message: text("session.copy.linkFailed"), kind: .error)
      return
    }
    Self.copy(link, toast: "session.copy.urlCopied")
  }

  private func copyPath() {
    let workspace = source.state.workspaceId
    let id = sessionId
    Task { [weak self] in
      guard let self else { return }
      do {
        let path = try await self.copyService.workspacePath(workspace, id)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard self.source.state.workspaceId == workspace else { return }
        if path.isEmpty {
          LodyToastOverlay.shared.show(message: self.text("session.copy.pathUnavailable"), kind: .neutral)
        } else {
          Self.copy(path, toast: "session.copy.pathCopied")
        }
      } catch {
        LodyToastOverlay.shared.show(message: self.text("session.copy.pathFailed"), kind: .error)
      }
    }
  }

  private func copyMarkdown() {
    let state = source.state
    let participants = chat.members.mapValues(\.name)
    let params = RuntimeContract.ConversationMarkdownParams(
      workspaceId: state.workspaceId, sessionId: sessionId, participants: participants,
      incompleteNotice: text("session.copy.markdownIncomplete")
    )
    Task { [weak self] in
      guard let self else { return }
      do {
        let result = try await self.copyService.markdown(params)
        guard self.source.state.workspaceId == params.workspaceId else { return }
        switch result {
        case .empty:
          LodyToastOverlay.shared.show(message: self.text("session.copy.markdownEmpty"), kind: .neutral)
        case .ready(let ready):
          UIPasteboard.general.string = ready.markdown
          LodyToastOverlay.shared.show(message: Self.describeMarkdown(ready), kind: .neutral)
        }
      } catch {
        LodyToastOverlay.shared.show(message: self.text("session.copy.markdownFailed"), kind: .error)
      }
    }
  }

  /// Web `describeCopiedConversation`: every omission is named in the confirmation.
  static func describeMarkdown(_ result: RuntimeContract.ConversationMarkdownResultReady) -> String {
    func text(_ key: String) -> String { String(localized: String.LocalizationValue(key), bundle: .lody) }
    if result.overBudget {
      return String(format: text("session.copy.markdownOverBudget"), Int((result.estimatedTokens / 1000).rounded()))
    }
    var trimmed: [String] = []
    if result.toolCallsCollapsed { trimmed.append(text("session.copy.trim.toolCalls")) }
    if result.thinkingTruncated { trimmed.append(text("session.copy.trim.thinking")) }
    if result.terminalTrimmed { trimmed.append(text("session.copy.trim.terminal")) }
    if result.toolResultsTruncated > 0 {
      trimmed.append(String(format: text("session.copy.trim.toolResults"), Int(result.toolResultsTruncated)))
    }
    if trimmed.isEmpty { return text("session.copy.markdownCopied") }
    return String(format: text("session.copy.markdownTrimmed"), ListFormatter.localizedString(byJoining: trimmed))
  }

  private static func copy(_ value: String, toast key: String) {
    UIPasteboard.general.string = value
    LodyToastOverlay.shared.show(message: String(localized: String.LocalizationValue(key), bundle: .lody), kind: .neutral)
  }

  private func text(_ key: String) -> String {
    String(localized: String.LocalizationValue(key), bundle: .lody)
  }
}
