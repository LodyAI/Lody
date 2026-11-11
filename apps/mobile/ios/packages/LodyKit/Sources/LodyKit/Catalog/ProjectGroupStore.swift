import Foundation
import LodyCore

/// The workspace's Project groups (multi-repository projects, runtime `projectGroups`) for the
/// project lists and Settings. Groups live in the workspace Flock document rather than the
/// session catalog, so a group without conversations never reaches `catalog.projects` on its own.
/// Reads are fresh one-shot reads, started when the workspace changes, when the catalog names a
/// group the last read did not, or on request; the last accepted list per account and workspace
/// is restored first. Cached rows only display.
@MainActor
final class ProjectGroupStore {
  static let shared = ProjectGroupStore()

  typealias Group = RuntimeContract.ProjectGroupItem

  private(set) var scope = ""
  private(set) var groups: [Group] = []
  /// True once a live read for the current scope has been accepted.
  private(set) var live = false
  private var loading: Task<Void, Never>?
  private var failedAt: Date?

  /// A fresh runtime read; none without a runtime for this workspace (or under UI Verify).
  private func fetch(_ workspaceId: String) async throws -> [Group] {
    guard !LodyUIVerify.enabled, let runtime = DataRuntime.current, runtime.workspace == workspaceId else {
      throw CancellationError()
    }
    return try await runtime.workspaceCall(RuntimeContract.Calls.ProjectGroups.self) { workspace, userId in
      RuntimeContract.ProjectGroupsParams(workspaceId: workspace, userId: userId)
    }.groups
  }

  /// Groups a conversation can run in: the new-chat picker's rule (more than one member, members
  /// on one computer). The others only appear in Settings.
  nonisolated static func runnable(_ group: Group) -> Bool { !group.conflict && group.members.count > 1 }

  /// Starts a read when this scope has none yet, or when the catalog names an unknown group.
  func ensure(userId: String, workspaceId: String, catalog: SessionCatalog? = nil) {
    guard !userId.isEmpty, !workspaceId.isEmpty else { return }
    let next = "\(userId):\(workspaceId)"
    if next != scope {
      scope = next
      groups = []
      live = false
      failedAt = nil
      loading?.cancel()
      loading = nil
      restore(userId: userId, workspaceId: workspaceId, scope: next)
      load(userId: userId, workspaceId: workspaceId)
      return
    }
    let known = Set(groups.map { "group:" + $0.id })
    let unknown = catalog?.projects.contains { $0.id.hasPrefix("group:") && !known.contains($0.id) } ?? false
    // A failed read retries on a later catalog change, at most every 10 s.
    let retry = failedAt.map { Date().timeIntervalSince($0) > 10 } ?? true
    if loading == nil, (!live && retry) || (unknown && retry) { load(userId: userId, workspaceId: workspaceId) }
  }

  /// A fresh read, such as when Settings › Projects opens.
  func refresh(userId: String, workspaceId: String) {
    ensure(userId: userId, workspaceId: workspaceId)
    guard loading == nil else { return }
    load(userId: userId, workspaceId: workspaceId)
  }

  private func snapshot(userId: String, workspaceId: String) -> SettingsSnapshotStore<[Group]> {
    SettingsSnapshotStore(kind: "projectGroups", userId: userId, workspaceId: workspaceId)
  }

  private func restore(userId: String, workspaceId: String, scope: String) {
    let store = snapshot(userId: userId, workspaceId: workspaceId)
    Task { [weak self] in
      guard let saved = await store.read() else { return }
      guard let self, self.scope == scope, !self.live else { return }
      self.groups = saved
      self.publish()
    }
  }

  private func load(userId: String, workspaceId: String) {
    let scope = self.scope
    let store = snapshot(userId: userId, workspaceId: workspaceId)
    loading = Task { [weak self] in
      do {
        guard let next = try await self?.fetch(workspaceId) else { return }
        guard let self, self.scope == scope, !Task.isCancelled else { return }
        self.loading = nil
        self.failedAt = nil
        self.live = true
        store.write(next)
        guard next != self.groups else { return }
        self.groups = next
        self.publish()
      } catch {
        guard let self, self.scope == scope else { return }
        self.loading = nil
        self.failedAt = Date()
      }
    }
  }

  private func publish() {
    NotificationCenter.default.post(name: .lodyProjectGroupsDidChange, object: nil)
  }

  /// The catalog with every runnable group listed as a `group:<id>` project, so a group without
  /// conversations still shows; groups already present gain their member count.
  func merged(_ catalog: SessionCatalog) -> SessionCatalog {
    Self.merged(catalog, groups: groups)
  }

  nonisolated static func merged(_ catalog: SessionCatalog, groups: [Group]) -> SessionCatalog {
    guard !groups.isEmpty else { return catalog }
    var next = catalog
    let counts = Dictionary(groups.map { ("group:" + $0.id, $0.members.count) }, uniquingKeysWith: { first, _ in first })
    next.projects = catalog.projects.map { project in
      var project = project
      if let count = counts[project.id] { project.memberCount = count }
      return project
    }
    let present = Set(catalog.projects.map(\.id))
    for group in groups where runnable(group) && !present.contains("group:" + group.id) {
      var project = SessionProject(id: "group:" + group.id, name: group.name)
      project.machineId = group.machineId ?? ""
      project.memberCount = group.members.count
      next.projects.append(project)
    }
    return next
  }
}

extension Notification.Name {
  static let lodyProjectGroupsDidChange = Notification.Name("LodyProjectGroupsDidChange")
}
