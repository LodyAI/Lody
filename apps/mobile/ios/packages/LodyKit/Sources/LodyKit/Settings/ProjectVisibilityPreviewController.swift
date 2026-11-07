import UIKit

@MainActor
final class ProjectVisibilityPreviewController: ProjectVisibilityController {
  init() {
    let fixture = ProjectVisibilityFixture()
    let catalog = SettingsCatalog(
      projects: [
        SettingsProject(id: "m1:local:same", machineId: "m1", name: "Studio", rootPath: "/Users/owner/Studio"),
        SettingsProject(id: "m2:local:same", machineId: "m2", name: "Studio", rootPath: "/Users/teammate/Studio"),
        SettingsProject(id: "m1:local:unregistered", machineId: "m1", name: "Draft", rootPath: "/Users/owner/Draft"),
      ],
      machineNames: ["m1": "Studio Mac", "m2": "Studio Mac"]
    )
    super.init(
      workspace: SettingsWorkspace(userId: "fixture", workspaceId: "visibility-fixture", catalog: catalog),
      service: { try await fixture.request($0) },
      changed: {}
    )
    title = "Projects"
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
}

@MainActor
private final class ProjectVisibilityFixture {
  private var fail = true
  private var snapshot = VisibilitySnapshot(userId: "owner", rows: [
    VisibilityRow(machineId: "m1", localProjectId: "same", ownerUserId: "owner", sharedWithTeam: false, updatedAt: 1),
    VisibilityRow(machineId: "m2", localProjectId: "same", ownerUserId: "teammate", sharedWithTeam: true, updatedAt: 1),
  ])

  func request(_ request: VisibilityRequest) async throws -> VisibilitySnapshot {
    if request.action == "set", let shared = request.sharedWithTeam {
      if fail {
        fail = false
        throw CocoaError(.fileWriteUnknown)
      }
      snapshot.rows[0].sharedWithTeam = shared
    }
    return snapshot
  }
}
