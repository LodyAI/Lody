import LodyCore
import UIKit

@MainActor
final class AgentRolesPreviewController: AgentRolesController {
  private let fixture: AgentRolesFixture
  private let switched = UILabel()

  init() {
    let fixture = AgentRolesFixture()
    self.fixture = fixture
    super.init(
      scope: SettingsScope(change: AgentRolesFixture.change) { fixture.workspace },
      service: { try await fixture.request($0) }
    )
    title = "Agent Roles"
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    switched.text = "Account changed"
    switched.font = .preferredFont(forTextStyle: .body)
    switched.textAlignment = .center
    switched.accessibilityIdentifier = "role-scope-switched"
    switched.backgroundColor = .lodyGroupedBackground
    switched.frame = view.bounds
    switched.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    switched.isHidden = true
    view.addSubview(switched)
  }

  override func sync(force: Bool = false) {
    super.sync(force: force)
    switched.isHidden = !fixture.switched
    list.isHidden = fixture.switched
  }
}

@MainActor
private final class AgentRolesFixture {
  static let change = Notification.Name("LodyAgentRolesFixtureScope")
  private(set) var switched = false
  private var failList = true
  private var failSave = true
  private var failDelete = true
  private static let target = RuntimeContract.AgentRoleItemTargetsItem(
    machineId: "m1", agentConfigId: "a1", machineName: "Studio", agentName: "Coder", state: .configured
  )
  private var data = AgentRoleSnapshot(
    roles: [
      AgentRolesFixture.role("review", "Reviewer"),
      AgentRolesFixture.role("search", "Search", owner: "other", visibility: .workspace),
      AgentRolesFixture.role("missing", "Needs setup", targets: [
        .init(machineId: "m1", agentConfigId: "missing", machineName: "Studio", agentName: "Missing agent", state: .agentUnavailable),
      ]),
      AgentRolesFixture.role("multi", "Everywhere", targets: [
        AgentRolesFixture.target, .init(machineId: "m2", agentConfigId: "a2", machineName: "Laptop", agentName: "Coder", state: .configured),
      ]),
    ],
    agents: [
      .init(id: "a1", name: "Coder", machineId: "m1", machineName: "Studio"),
      .init(id: "a2", name: "Reviewer", machineId: "m2", machineName: "Laptop"),
    ]
  )

  var workspace: SettingsWorkspace {
    SettingsWorkspace(userId: switched ? "settings-baseline-user" : "me", workspaceId: "offline-roles")
  }

  func request(_ request: AgentRoleRequest) async throws -> AgentRoleSnapshot {
    switch request {
    case .list:
      if failList {
        failList = false
        throw CocoaError(.fileReadUnknown)
      }
    case .save(let id, let base, let fields, let target):
      if fields.name == "Switch" {
        switched = true
        NotificationCenter.default.post(name: Self.change, object: nil)
        try await Task.sleep(for: .seconds(3600))
      }
      if data.roles.contains(where: { $0.id != id && $0.name == fields.name.trimmingCharacters(in: .whitespacesAndNewlines) }) {
        throw Self.failure("role_duplicate")
      }
      if base != nil, failSave {
        failSave = false
        throw Self.failure("role_conflict")
      }
      if base != nil {
        data.roles = data.roles.map { role in
          guard role.id == id else { return role }
          var next = role
          next.name = fields.name
          next.description = fields.description
          next.promptPrefix = fields.promptPrefix
          next.visibility = fields.visibility == .workspace ? .workspace : .private
          next.revision += 1
          next.updatedAt = 2
          return next
        }
      } else if let agent = data.agents.first(where: { $0.id == target?.agentConfigId }) {
        let placed = RuntimeContract.AgentRoleItemTargetsItem(
          machineId: agent.machineId, agentConfigId: agent.id, machineName: agent.machineName, agentName: agent.name,
          state: .configured
        )
        data.roles.append(AgentRole(
          id: id, ownerUserId: "me", visibility: fields.visibility == .workspace ? .workspace : .private, name: fields.name,
          description: fields.description, promptPrefix: fields.promptPrefix, revision: 1, updatedAt: 1, targets: [placed]
        ))
      }
    case .delete(let base):
      data.roles.removeAll { $0.id == base.id }
      if failDelete {
        failDelete = false
        throw Self.failure("role_write_unknown")
      }
    }
    return data
  }

  private static func failure(_ code: String) -> NSError {
    NSError(domain: "LodyKit.AgentRolesFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: code])
  }

  private static func role(
    _ id: String, _ name: String, owner: String = "me", visibility: RuntimeContract.AgentRoleItemVisibility = .private,
    targets: [RuntimeContract.AgentRoleItemTargetsItem] = [AgentRolesFixture.target]
  ) -> AgentRole {
    AgentRole(
      id: id, ownerUserId: owner, visibility: visibility, name: name, description: "Review changes",
      promptPrefix: "Keep changes focused.", revision: 1, updatedAt: 1, targets: targets
    )
  }
}
