import UIKit

@MainActor
enum LodyNativePages {
  private static let factories: [String: ([String: Any]) -> UIViewController] = [
    "home": { _ in HomeController() },
    "debug": { _ in NativeDebugController() },
    "pull-request": { params in
      let repository = params["repository"] as! String
      let number = params["number"] as! Int
      let scope = SettingsActor.live(params)
      let store = PullRequestStore(repository: repository, number: number, scope: scope,
        service: .live(workspaceId: scope.workspaceId, repository: repository, number: number))
      let page = PullRequestController(store: store)
      page.investigate = { [weak page] text in
        guard let page else { throw PullRequestStore.failure("unavailable") }
        try await LodyShell.shared.callback(from: page, name: "onInvestigate", value: text)
      }
      return page
    },
    "pull-request-native-preview": { params in PullRequestPreviewController(params: params) },
    "files": { params in
      FilesController(params: .init(workspaceId: params["workspaceId"] as! String, sessionId: params["sessionId"] as! String,
        relativePath: params["path"] as! String, userId: params["userId"] as! String))
    },
    "files-fixture": { params in
      FilesFixtureController(params: .init(workspaceId: params["workspaceId"] as! String, sessionId: params["sessionId"] as! String,
        relativePath: params["path"] as! String, userId: params["userId"] as! String))
    },
    "file-content": { params in
      let sessionId = params["sessionId"] as! String
      return FileContentController(sessionId: sessionId, path: params["path"] as! String, line: params["line"] as? Int,
        preview: params["preview"] as? Bool ?? false, feedback: .live(sessionId: sessionId))
    },
    "file-content-fixture": { params in FileContentFixtureController(params: params) },
    "file-diff-fixture": { params in FileDiffFixtureController(params: params) },
    "file-diff": { params in
      let sessionId = params["sessionId"] as! String
      return FileDiffController(request: .init(sessionId: sessionId, entryId: params["entryId"] as? String, path: params["path"] as! String),
        feedback: .live(sessionId: sessionId))
    },
    "workspace-changes": { params in
      let sessionId = params["sessionId"] as! String
      return WorkspaceChangesController(sessionId: sessionId, feedback: .live(sessionId: sessionId))
    },
    "appearance-settings": { _ in AppearanceController() },
    "app-icon": { _ in AppIconController() },
    "about": { _ in AboutController() },
    "preferences": { _ in PreferencesController() },
    "ai-usage": { _ in AIUsageController() },
    "ai-usage-preview": { _ in AIUsagePreviewController() },
    "project-visibility": { _ in ProjectVisibilityController() },
    "project-visibility-preview": { _ in ProjectVisibilityPreviewController() },
    "github-settings": { _ in GitHubSettingsController() },
    "github-settings-preview": { _ in GitHubSettingsPreviewController() },
    "schedules": { _ in SchedulesController() },
    "prompt-shortcuts": { _ in PromptShortcutsController() },
    "prompt-shortcuts-preview": { _ in PromptShortcutsPreviewController() },
    "agent-roles": { _ in AgentRolesController() },
    "agent-roles-preview": { _ in AgentRolesPreviewController() },
    "settings": { _ in SettingsController() },
    "settings-baseline": { params in SettingsBaselineController(scenario: params["scenario"] as? String ?? "live") },
    "archived-sessions": { _ in ArchivedSessionsController() },
    "workspace-editor": { params in WorkspaceEditorController(params: params) },
    "archived-sessions-preview": { _ in ArchivedSessionsPreviewController() },
    "session": { params in SessionController(params: params) },
    "session-permission": { params in
      let sessionId = params["sessionId"] as! String
      return PermissionController(sessionId: sessionId, source: .live(sessionId: sessionId))
    },
    "permission-sheet-preview": { params in PermissionSheetPreviewController(scenario: params["scenario"] as! String) },
    "permission-native-preview": { params in PermissionPreviewController(waiting: params["waiting"] as? Bool == true) },
    "session-preview": { params in SessionPreviewController(scenario: params["scenario"] as? String ?? "live") },
    "send-preview": { params in SendPreviewController(params: params) },
    "agent-error-preview": { _ in AgentErrorPreviewController() },
    "memory-settings": { params in MemorySettingsController(scope: .live(params)) },
    "memory-preview": { _ in MemoryPreviewController() },
    "memory-states-preview": { _ in MemoryPreviewController(state: "not_installed") },
    "memory-state-catalog_denied": { _ in MemoryPreviewController(state: "catalog_denied") },
    "memory-state-not_installed": { _ in MemoryPreviewController(state: "not_installed") },
    "memory-state-not_running": { _ in MemoryPreviewController(state: "not_running") },
    "memory-state-unsupported": { _ in MemoryPreviewController(state: "unsupported") },
    "memory-state-error": { _ in MemoryPreviewController(state: "error") },
    "memory-state-forbidden": { _ in MemoryPreviewController(state: "forbidden") },
    "memory-state-unknown": { _ in MemoryPreviewController(state: "unknown") },
    "memory-state-cached": { _ in MemoryPreviewController(state: "cached") },
    "memory-state-empty": { _ in MemoryPreviewController(state: "empty") },
    "published-shares": { params in PublishedSharesController(scope: .live(params)) },
    "published-shares-preview": { _ in PublishedSharesPreviewController() },
    "published-shares-empty": { _ in PublishedSharesPreviewController(state: "empty") },
    "published-shares-denied": { _ in PublishedSharesPreviewController(state: "denied") },
    "published-shares-readonly": { _ in PublishedSharesPreviewController(state: "readonly") },
    "published-shares-readback-denied": { _ in PublishedSharesPreviewController(state: "readback-denied") },
    "remote-settings": { params in RemoteSettingsController(kind: params["kind"] as? String ?? "machine", scope: .live(params)) },
    "settings-preview": { _ in SettingsPreviewController() },
    "mcp-settings-preview": { _ in RemoteSettingsPreviews.mcp() },
    "machine-settings-preview": { _ in RemoteSettingsPreviews.machine() },
    "remote-setting-editor-preview": { params in RemoteSettingsPreviews.editor(params) },
    "diagnostics": { _ in DiagnosticsController() },
    "diagnostics-preview": { _ in DiagnosticsPreviewController() },
    "picker": { params in LodyNativePages.picker(params) },
    "project-history": { params in ProjectHistoryController(scope: .live(params)) },
    "project-history-preview": { _ in ProjectHistoryPreview.make() },
    "directory-preview": { _ in DirectoryPreviewController() },
    "project": { params in ProjectController(projectId: params["projectId"] as? String ?? "") },
    "project-preview": { params in
      ProjectPreviewController(projectId: params["projectId"] as? String ?? "preview-lody", connected: params["offline"] == nil)
    },
    "activity": { params in
      ActivityController(workspaceId: params["workspaceId"] as? String ?? "", userId: params["userId"] as? String ?? "")
    },
    "activity-preview": { params in ActivityPreviewController(scenario: params["scenario"] as? String ?? "live") },
    "session-share": { params in
      SessionShareController(workspaceId: params["workspaceId"] as? String ?? "", sessionId: params["sessionId"] as? String ?? "")
    },
    "session-share-preview": { _ in SessionSharePreviewController() },
    "agent-error": { params in AgentErrorController(params: params) },
    "edit-message": { params in
      EditMessageController(sessionId: params["sessionId"] as! String, entryId: params["entryId"] as! String)
    },
    "edit-message-preview": { params in EditMessagePreviewController(scenario: params["scenario"] as? String ?? "retry") },
    "message-details": { params in
      let entryId = params["entryId"] as! String
      let entries = try! JSONDecoder().decode([ChatEntry].self, from: Data((params["entriesJSON"] as! String).utf8))
      return MessageDetailsController(entryId: entryId, entry: entries.first { $0.id == entryId })
    },
    "session-item-detail": { params in
      ItemDetailController(sessionId: params["sessionId"] as! String, entryId: params["entryId"] as! String,
                           itemIds: params["itemIds"] as! [String], generation: params["generation"] as! Int)
    },
    "item-detail-preview": { params in ItemDetailPreviewController(scenario: params["scenario"] as! String) },
    "message-share": { params in MessageShareController(contentJSON: params["contentJSON"] as? String ?? "") },
    "notification-settings": { _ in NotificationSettingsController() },
    "notification-preview": { _ in NotificationPreviewController() },
    "onboarding": { _ in OnboardingController() },
    "onboarding-preview": { _ in OnboardingPreviewController() },
    "mention-picker": { params in MentionPickerController.page(params) },
    "create-session": { params in CreateSessionHostController(params: decode(CreateSessionHostParams.self, params) ?? CreateSessionHostParams()) },
    "create-session-preview": { params in CreateSessionPreviewController(scenario: params["scenario"] as? String ?? "create-parity") },
    "file-diff-preview": { _ in FileDiffPreviewController() },
    "workspace-changes-preview": { _ in WorkspaceChangesPreviewController() },
    "file-content-preview": { _ in FileContentPreviewController() },
  ]

  private static func picker(_ params: [String: Any]) -> UIViewController {
    let options = (params["options"] as? [[String: Any]] ?? []).map {
      (id: $0["id"] as? String ?? "", title: $0["title"] as? String ?? "", subtitle: $0["subtitle"] as? String ?? "")
    }
    let owner = WeakController()
    let picker = CreateChoiceController(
      title: params["title"] as? String ?? String(localized: "picker.title", bundle: .lody), header: params["header"] as? String ?? "",
      placeholder: params["placeholder"] as? String ?? String(localized: "picker.empty", bundle: .lody), options: options,
      selected: params["selectedId"] as? String, onPick: { id in LodyShell.shared.finish(from: owner.value, value: id) }
    )
    owner.value = picker
    return picker
  }

  private static func decode<Value: Decodable>(_ type: Value.Type, _ params: [String: Any]) -> Value? {
    guard let data = try? JSONSerialization.data(withJSONObject: params) else { return nil }
    return try? JSONDecoder().decode(type, from: data)
  }

  static func make(_ id: String, params: String?) -> UIViewController? {
    let object = params.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) } as? [String: Any]
    return factories[id]?(object ?? [:])
  }
}

private final class WeakController {
  weak var value: UIViewController?
}
