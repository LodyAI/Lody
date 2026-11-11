import LodyCore
import UIKit

/// A Project group's read-only page from Settings › Projects: its computer, creator and members.
/// It follows the workspace's group list, so a group edited on desktop updates here.
@MainActor
final class ProjectGroupController: UIViewController {
  private let list = LodyGroupedList(frame: .zero)
  private let groupId: String
  private let scope: String
  private var group: RuntimeContract.ProjectGroupItem
  private var owner: String?
  private var observer: NSObjectProtocol?
  private var memberTask: Task<Void, Never>?

  init(group: RuntimeContract.ProjectGroupItem, scope: String) {
    groupId = group.id
    self.group = group
    self.scope = scope
    super.init(nibName: nil, bundle: nil)
    title = group.name
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit {
    memberTask?.cancel()
    if let observer { NotificationCenter.default.removeObserver(observer) }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    list.frame = view.bounds
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(list)
    observer = NotificationCenter.default.addObserver(forName: .lodyProjectGroupsDidChange, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.follow() }
    }
    let workspace = SettingsWorkspace.current
    if group.ownerUserId != workspace.userId, !LodyUIVerify.enabled, !workspace.key.isEmpty {
      memberTask = Task { [weak self, ownerId = group.ownerUserId] in
        await WorkspaceMembers.load(userId: workspace.userId, workspaceId: workspace.workspaceId) { [weak self] members in
          guard let self, let name = members[ownerId]?.name, !name.isEmpty else { return }
          self.owner = name
          self.render()
        }
      }
    }
    render()
  }

  private func follow() {
    let store = ProjectGroupStore.shared
    guard store.scope == scope, let next = store.groups.first(where: { $0.id == groupId }), next != group else { return }
    group = next
    title = next.name
    parent?.title = next.name
    render()
  }

  private func render() {
    let workspace = SettingsWorkspace.current
    list.setSections(ProjectGroupSections.detail(
      group, userId: workspace.userId, owner: owner, machineNames: workspace.catalog.machineNames
    ))
  }
}
