import UIKit

@MainActor
final class SettingsPreviewController: UIViewController {
  private let list = LodyGroupedList(frame: .zero)
  private let fixture = SettingsPreviewFixture()

  override func viewDidLoad() {
    super.viewDidLoad()
    SettingsPage.host(list, in: self) { [weak self] name, body in
      guard name == "rowPress", let id = body["id"] as? String else { return }
      self?.open(String(id.dropFirst("settings-".count)))
    }
    var section = LodyListSection()
    section.id = "remote"
    section.rows = ["machine", "agent", "mcp"].map { kind in
      var row = LodyListRow()
      row.id = "settings-\(kind)"
      row.title = RemoteSettingsSections.remote(kind)
      row.disclosure = true
      row.action = true
      row.navigates = true
      return row
    }
    list.setSections([section])
  }

  private func open(_ kind: String) {
    guard ["machine", "agent", "mcp"].contains(kind) else { return }
    final class State {
      var offline = false
      var percent = 32.0
    }
    let state = State()
    let fixture = fixture
    let controller = RemoteSettingsController(
      kind: kind, scope: SettingsActor(userId: "fixture", workspaceId: "offline-settings"),
      service: { request in
        if state.offline { throw SettingsError(RemoteSettingsSections.remote("loadFailed")) }
        return try await fixture.request(request)
      },
      cache: .memory(),
      context: {
        RemoteSettingsContext(
          connected: !state.offline, presence: SettingsMachinePresence(state: "live", onlineMachineIds: ["m1", "m2"]),
          agentUsage: SettingsPreviewFixture.usage(percent: state.percent)
        )
      },
      refreshUsage: {
        if state.offline { state.percent = 72 }
        state.offline.toggle()
      }
    )
    LodyShell.shared.pushNative(controller, title: RemoteSettingsSections.remote(kind), from: self)
  }
}

@MainActor
private final class SettingsPreviewFixture {
  private var failLoad = true
  private var failSave = true
  private var rows = [
    RemoteSetting(kind: "machine", id: "m1", name: "Studio Mac", detail: "macOS"),
    RemoteSetting(kind: "agent", id: "a1", name: "Codex", machineId: "m1", machineName: "Studio Mac", detail: "codex",
                  prompt: "Keep changes focused."),
    RemoteSetting(kind: "agent", id: "a2", name: "Claude", machineId: "m1", machineName: "Studio Mac", readOnly: true,
                  detail: "claude"),
    RemoteSetting(kind: "agent", id: "a3", name: "Kimi", machineId: "m1", machineName: "Studio Mac", detail: "kimi"),
    RemoteSetting(kind: "agent", id: "a4", name: "Custom API", machineId: "m1", machineName: "Studio Mac", detail: "codex"),
    RemoteSetting(kind: "agent", id: "a5", name: "Codex Work", machineId: "m1", machineName: "Studio Mac", detail: "codex"),
    RemoteSetting(kind: "mcp", id: "c1", name: "Documentation", detail: "http", enabledByDefault: false),
    RemoteSetting(kind: "agent", id: "a1", name: "Codex", machineId: "m2", machineName: "Studio Mac", detail: "codex",
                  prompt: "Laptop instructions."),
  ]

  func request(_ request: RemoteSettingsRequest) async throws -> [RemoteSetting] {
    if failLoad {
      failLoad = false
      throw SettingsError(RemoteSettingsSections.remote("loadFailed"))
    }
    if let edit = request.edit {
      if request.kind == "agent", failSave {
        failSave = false
        throw SettingsError(RemoteSettingsSections.remote("saveFailed"))
      }
      rows = rows.map { row in
        guard row.settingId == edit.item.settingId else { return row }
        var next = row
        next.name = edit.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if request.kind == "agent" { next.prompt = edit.prompt }
        if request.kind == "mcp" { next.enabledByDefault = edit.enabledByDefault }
        return next
      }
    }
    return rows.filter { $0.kind == request.kind }
  }

  static func usage(percent: Double) -> [String: AgentUsage] {
    let now = (LodyRelativeTime.now() / 1000).rounded(.down)
    let configs = [("a1", "Codex", "codex", true), ("a2", "Claude", "claude", true), ("a3", "Kimi", "kimi", true),
                   ("a4", "Custom API", "codex", false), ("a5", "Codex Work", "codex", true)]
      .map { AgentUsageConfig(id: $0.0, name: $0.1, provider: $0.2, eligible: $0.3) }
    let quotas = [
      AgentQuota(id: "codex", provider: "codex", windows: [
        UsageWindow(usedPercent: percent, duration: 18000, resetsAt: now + 2 * 3600 + 14 * 60),
        UsageWindow(usedPercent: 61, duration: 604_800, resetsAt: now + 6 * 86400 + 6 * 3600),
      ]),
      AgentQuota(id: "codex_bengalfox", provider: "codex", name: "Codex Spark", windows: [
        UsageWindow(usedPercent: 8, duration: 604_800, resetsAt: nil),
      ]),
      AgentQuota(id: "claude", provider: "claude", windows: [
        UsageWindow(usedPercent: 100, duration: 18000, resetsAt: now + 65 * 60),
      ]),
    ]
    return [
      "m1": AgentUsage(configs: configs, quotas: quotas),
      "m2": AgentUsage(
        configs: [AgentUsageConfig(id: "a1", name: "Codex", provider: "codex", eligible: true)],
        quotas: [AgentQuota(id: "codex", provider: "codex", windows: [UsageWindow(usedPercent: 44, duration: 18000, resetsAt: nil)])]
      ),
    ]
  }
}
