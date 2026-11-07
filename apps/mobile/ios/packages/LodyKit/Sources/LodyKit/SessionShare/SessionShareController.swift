import LodyCore
import SwiftUI
import UIKit

typealias ShareState = RuntimeContract.SessionSharingResultState
typealias ShareAction = RuntimeContract.SessionSharingParamsAction
typealias ShareProgress = RuntimeContract.ShareProgressEvent

extension Notification.Name {
  static let lodyShareProgress = Notification.Name("LodyShareProgress")
}

@MainActor
struct SessionShareService {
  var request: (RuntimeContract.SessionSharingParams) async throws -> ShareState?
  var subscribe: (@escaping @MainActor (ShareProgress) -> Void) -> () -> Void

  static var live: SessionShareService {
    SessionShareService(
      request: { params in
        try await DataRuntime.settingsCall(RuntimeContract.Calls.SessionSharing.self, params, as: ShareState?.self) { result -> any Encodable in
          switch result {
          case .closed: return RuntimeContract.JSONValue.null
          case .state(let state): return state
          }
        }
      },
      subscribe: { listener in
        let observer = NotificationCenter.default.addObserver(forName: .lodyShareProgress, object: nil, queue: .main) { note in
          guard let progress = note.object as? ShareProgress else { return }
          MainActor.assumeIsolated { listener(progress) }
        }
        return { NotificationCenter.default.removeObserver(observer) }
      }
    )
  }
}

@MainActor
final class SessionShareController: UIViewController {
  private static var editors = 0
  private let workspaceId: String
  private let sessionId: String
  private let service: SessionShareService
  private let editorId: String
  private let hosting = UIHostingController(rootView: SessionShareForm(configuration: nil, action: { _, _ in }))
  private var data: ShareState?
  private var selected: [String]
  private var busy = true
  private var error = false
  private var notice = ""
  private var progress: ShareProgress?
  private var running = false
  private var retryAction = ShareAction.read
  private var alive = true
  private var unsubscribe: (() -> Void)?
  private lazy var doneItem = LodyFormController.barButton(title: String(localized: "common.done", bundle: .lody), label: String(localized: "common.done", bundle: .lody)) {
    [weak self] in self?.dismiss(animated: true)
  }

  init(workspaceId: String, sessionId: String, service: SessionShareService = .live) {
    self.workspaceId = workspaceId
    self.sessionId = sessionId
    self.service = service
    selected = [sessionId]
    Self.editors += 1
    editorId = "ios-share-\(Int(Date().timeIntervalSince1970 * 1000))-\(Self.editors)"
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "share.title", bundle: .lody)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemGroupedBackground
    hosting.view.backgroundColor = .systemGroupedBackground
    addChild(hosting)
    hosting.view.frame = view.bounds
    hosting.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(hosting.view)
    hosting.didMove(toParent: self)
    unsubscribe = service.subscribe { [weak self] value in
      guard let self, self.alive, value.editorId == self.editorId else { return }
      self.progress = value
      self.render()
    }
    run(.read)
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    parent?.navigationItem.rightBarButtonItems = [doneItem]
    render()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    guard let scroll = Self.findScroll(in: hosting.view) else { return }
    LodyScrollEdges.navigation(scroll)
    LodyScrollEdges.bind(scroll, to: self)
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    guard alive, SettingsPage.leaving(self) else { return }
    alive = false
    unsubscribe?()
    let close = params(.close, selection: nil)
    Task { [service] in _ = try? await service.request(close) }
  }

  private func params(_ action: ShareAction, selection: [String]?) -> RuntimeContract.SessionSharingParams {
    RuntimeContract.SessionSharingParams(
      workspaceId: workspaceId, sessionId: sessionId, editorId: editorId, action: action, selected: selection,
      omissionText: selection == nil ? nil : String(localized: "share.fileOmitted", bundle: .lody)
    )
  }

  private func run(_ action: ShareAction) {
    guard !running else { return }
    running = true
    retryAction = action
    busy = true
    error = false
    notice = ""
    render()
    Task {
      do {
        let next = try await service.request(params(action, selection: selected))
        guard alive else { return }
        if action == .publish, next?.entry?.status != .active { throw SettingsError("share_not_published") }
        data = next
        if let next { selected = next.selected }
        switch action {
        case .publish:
          notice = String(localized: "share.published", bundle: .lody)
          if let url = next?.url {
            UIPasteboard.general.string = url
            notice = String(localized: "share.publishedCopied", bundle: .lody)
          }
        case .reset: notice = String(localized: "share.resetDone", bundle: .lody)
        case .revoke: notice = String(localized: "share.revoked", bundle: .lody)
        default: break
        }
      } catch {
        if alive { self.error = true }
        // A failed response may follow a successful commit, so query before offering a retry.
        if action != .read, let next = try? await service.request(params(.read, selection: selected)), alive {
          data = next
          if next.pending { selected = next.selected }
        }
      }
      running = false
      if alive {
        busy = false
        progress = nil
      }
      render()
    }
  }

  private func handle(_ name: String, _ value: Bool?) {
    guard !busy else { return }
    switch name {
    case "includeChildren":
      guard data?.pending != true else { return }
      selected = value == true ? [sessionId] + children().prefix(31).map(\.id) : [sessionId]
      render()
    case "retry":
      run(retryAction)
    case "publish", "discard", "reset", "revoke":
      if let action = ShareAction(rawValue: name) { run(action) }
    case "copy":
      guard let url = data?.url else { return }
      UIPasteboard.general.string = url
      notice = String(localized: "share.copied", bundle: .lody)
      render()
    case "share":
      guard let link = data?.url, let url = URL(string: link) else { return }
      let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
      share.popoverPresentationController?.sourceView = view
      present(share, animated: true)
    default:
      break
    }
  }

  private func children() -> [RuntimeContract.SessionSharingResultStateCandidatesItem] {
    data?.candidates.filter { $0.id != sessionId } ?? []
  }

  private func render() {
    let entry = data?.entry
    let others = children()
    let available = Set(data?.candidates.map(\.id) ?? [])
    var progressText = String(localized: "share.loading", bundle: .lody)
    if let progress {
      progressText = String.localizedStringWithFormat(String(localized: String.LocalizationValue("share." + progress.phase.rawValue), bundle: .lody), String(describing: progress.percent ?? 0))
    }
    var strings = Dictionary(uniqueKeysWithValues: Self.keys.map { ($0, String(localized: String.LocalizationValue("share." + $0), bundle: .lody)) })
    strings["children"] = String.localizedStringWithFormat(String(localized: "share.children", bundle: .lody), String(describing: min(others.count, 31)))
    strings["retry"] = String(localized: "common.retry", bundle: .lody)
    strings["cancel"] = String(localized: "common.cancel", bundle: .lody)
    let title = data?.candidates.first { $0.id == sessionId }?.title ?? ""
    let configuration = SessionShareForm.Configuration(
      title: title.isEmpty ? String(localized: "share.title", bundle: .lody) : title,
      loaded: data != nil,
      active: entry?.status == .active,
      canPublish: data != nil && (entry == nil || entry?.status == .revoked || entry?.canManage == true),
      canReset: entry?.canManage == true,
      canRevoke: entry?.canRevoke == true,
      hasLink: data?.url != nil,
      childrenCount: others.count,
      includeChildren: selected.count > 1,
      selectionAvailable: selected.allSatisfy(available.contains),
      pending: data?.pending == true,
      busy: busy,
      error: error,
      notice: notice,
      progressText: progressText,
      percent: progress?.phase == .uploading ? progress?.percent.map(Double.init) : nil,
      strings: strings
    )
    hosting.rootView = SessionShareForm(configuration: configuration) { [weak self] name, value in self?.handle(name, value) }
    doneItem.isEnabled = !(busy && data != nil)
    parent?.navigationController?.isModalInPresentation = busy && data != nil
  }

  private static let keys = [
    "shared", "private", "publicNotice", "snapshotNotice", "attachments", "limit", "copy", "send", "keyMissing", "publish",
    "update", "updateNotice", "sourceUnavailable", "discard", "reset", "revoke", "resetConfirm", "revokeConfirm", "failed",
    "keepOpen", "content", "manage",
  ]

  private static func findScroll(in view: UIView) -> UIScrollView? {
    if let scroll = view as? UIScrollView { return scroll }
    for child in view.subviews {
      if let scroll = findScroll(in: child) { return scroll }
    }
    return nil
  }
}
