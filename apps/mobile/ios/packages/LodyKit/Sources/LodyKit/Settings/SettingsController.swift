import UIKit

@MainActor
class SettingsController: UIViewController {
  let list = LodyGroupedList(frame: .zero)
  let source: SettingsSource
  private var state = SettingsState()
  private var observers: [NSObjectProtocol] = []

  init(source: SettingsSource = .live) {
    self.source = source
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "tabs.settings", bundle: .lody)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit { observers.forEach(NotificationCenter.default.removeObserver) }

  override func viewDidLoad() {
    super.viewDidLoad()
    list.frame = view.bounds
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.setPlaceholder("")
    list.forwarded = { [weak self] name, body in
      guard name == "rowPress", let id = body["id"] as? String else { return }
      self?.open(id)
    }
    view.addSubview(list)
    for name in source.changes + [UIApplication.didBecomeActiveNotification] {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.render() }
      })
    }
    render()
  }

  func render() {
    state = source.state
    #if DEBUG
      let developer = true
    #else
      let developer = LodyUIVerify.enabled
    #endif
    list.setSections(SettingsSections.make(state, developer: developer))
  }

  private func open(_ id: String) {
    let workspace = state.account == nil ? nil : state.workspace
    let native = [
      "preferences": "preferences", "appearance": "appearance-settings", "about": "about",
    ]
    let workspacePages = [
      "agent-roles": "agent-roles", "prompt-shortcuts": "prompt-shortcuts", "project-visibility": "project-visibility",
      "github-settings": "github-settings", "ai-usage": "ai-usage", "memory-settings": "memory-settings",
      "published-shares": "published-shares",
    ]
    let remote = ["remote-machine": "machine", "remote-agent": "agent", "remote-mcp": "mcp"]
    if let page = native[id] {
      push(page, title: title(id))
    } else if let page = workspacePages[id], workspace != nil {
      push(page, title: title(id), params: state.scope)
    } else if let kind = remote[id], workspace != nil {
      push("remote-settings", title: text("remote.\(kind)"), params: state.scope.merging(["kind": kind]) { _, new in new })
    } else if id == "workspace-general", let workspace {
      var params: [String: Any] = [
        "workspaceId": workspace.id, "name": workspace.name, "color": LodyAccentChoice.hex(.lodyAccent.resolvedColor(with: traitCollection)),
      ]
      params["image"] = workspace.image
      LodyShell.shared.presentNative(
        WorkspaceEditorController(params: params), title: text("workspace.general"), detents: [0.5]
      )
    } else if id == "account", state.account != nil {
      LodyShell.shared.pushNative(AccountController(source: source), title: String(localized: "account.title", bundle: .lody), from: self)
    } else if id == "archived", workspace != nil {
      push("archived-sessions", title: String(localized: "settings.archived.title", bundle: .lody))
    } else if id == "project-history", workspace != nil {
      push("project-history", title: text("history.title"), params: state.scope)
    } else if id == "diagnostics" {
      push("diagnostics", title: String(localized: "diagnostics.title", bundle: .lody))
    } else if id == "connection", workspace != nil, state.connection.state == "offline" {
      source.refresh()
    } else if id == "debug-open" {
      let sheet = navigationController
      sheet?.presentingViewController?.dismiss(animated: true) {
        LodyShell.shared.openPage("debug", from: nil)
      }
    }
  }

  private func push(_ page: String, title: String, params: [String: Any] = [:]) {
    LodyShell.shared.pushNative(page, title: title, params: params, from: self)
  }

  private func title(_ id: String) -> String {
    let keys = [
      "preferences": "preferences.title", "appearance": "appearance.title", "about": "section.about",
      "agent-roles": "roles.title", "prompt-shortcuts": "shortcuts.title", "project-visibility": "projects.title",
      "github-settings": "github.title", "ai-usage": "aiUsage.title", "memory-settings": "memory.title",
      "published-shares": "shares.title",
    ]
    return keys[id].map(text) ?? ""
  }

  private func text(_ key: String) -> String { SettingsSections.text(key) }
}
