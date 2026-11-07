import UIKit

@MainActor
final class SettingsBaselineController: SettingsController {
  private let fixture: SettingsBaselineFixture
  private let probe = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))

  init(scenario: String) {
    let fixture = SettingsBaselineFixture(scenario: scenario)
    self.fixture = fixture
    super.init(source: SettingsSource(
      changes: [SettingsBaselineFixture.change], read: { fixture.state }, refresh: { fixture.refresh() },
      logout: { fixture.logout() }
    ))
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    probe.isAccessibilityElement = true
    probe.accessibilityIdentifier = "settings-baseline-ready"
    super.viewDidLoad()
    view.addSubview(probe)
  }

  override func render() {
    super.render()
    probe.accessibilityLabel = "\(fixture.scenario):refreshes=\(fixture.refreshes)"
  }
}

@MainActor
private final class SettingsBaselineFixture {
  static let change = Notification.Name("LodySettingsBaselineFixture")
  private static let workspace = AuthWorkspace(id: "settings-baseline", name: "Baseline Workspace", slug: nil, image: nil)
  private(set) var scenario: String
  private(set) var refreshes = 0
  private var connection: SettingsConnection

  init(scenario: String) {
    self.scenario = scenario
    let cached = scenario == "cached" || scenario == "live"
    let states = ["live": "live", "syncing": "syncing"]
    connection = SettingsConnection(
      state: states[scenario] ?? "offline", machines: cached ? 2 : 0,
      syncedAt: cached ? LodyRelativeTime.now() - 60_000 : nil
    )
  }

  var state: SettingsState {
    let signedIn = scenario != "signed-out"
    let hasWorkspace = signedIn && scenario != "no-workspace"
    let user = AuthUser(id: "settings-baseline-user", name: "Settings Preview", email: "baseline@example.test", image: nil)
    return SettingsState(
      account: signedIn ? AuthAccount(user: user, workspaces: hasWorkspace ? [Self.workspace] : []) : nil,
      workspace: hasWorkspace ? Self.workspace : nil,
      connection: connection
    )
  }

  func refresh() {
    scenario = "syncing"
    refreshes += 1
    connection.state = "syncing"
    NotificationCenter.default.post(name: Self.change, object: nil)
  }

  func logout() {
    scenario = "signed-out"
    connection = SettingsConnection(state: "offline", machines: 0)
    NotificationCenter.default.post(name: Self.change, object: nil)
  }
}
