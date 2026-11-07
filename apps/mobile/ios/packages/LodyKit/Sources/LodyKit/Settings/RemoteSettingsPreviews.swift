import UIKit

@MainActor
enum RemoteSettingsPreviews {
  static func mcp() -> UIViewController {
    final class Fixture {
      var rows = [
        RemoteSetting(kind: "mcp", id: "docs", name: "Documentation", detail: "http", enabledByDefault: false, configured: true, updatedAt: 1),
        RemoteSetting(kind: "mcp", id: "search", name: "Search", detail: "stdio", enabledByDefault: false, configured: true, updatedAt: 1),
        RemoteSetting(kind: "mcp", id: "missing", name: "Needs setup", detail: "http", enabledByDefault: false, configured: false,
                      updatedAt: 1),
        RemoteSetting(kind: "mcp", id: "readonly", name: "Read only", readOnly: true, detail: "stdio", configured: true),
      ]
      var failSave = true
      var failDelete = true
    }
    let fixture = Fixture()
    let service: RemoteSettingsService = { request in
      if let edit = request.edit {
        let wanted = edit.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if fixture.rows.contains(where: { $0.id != edit.item.id && $0.name.lowercased() == wanted }) {
          throw SettingsError(RemoteSettingsSections.remote("duplicate"))
        }
        if fixture.failSave {
          fixture.failSave = false
          throw SettingsError(RemoteSettingsSections.remote("saveFailed"))
        }
        fixture.rows = fixture.rows.map { row in
          guard row.id == edit.item.id else { return row }
          var next = row
          next.name = edit.name.trimmingCharacters(in: .whitespacesAndNewlines)
          next.enabledByDefault = edit.enabledByDefault
          next.updatedAt = 2
          return next
        }
      }
      if let remove = request.remove {
        if fixture.failDelete {
          fixture.failDelete = false
          throw SettingsError(RemoteSettingsSections.remote("conflict"))
        }
        fixture.rows.removeAll { $0.id == remove.id }
      }
      return fixture.rows
    }
    return RemoteSettingsController(
      kind: "mcp", scope: SettingsActor(userId: "fixture", workspaceId: "offline-mcp"), service: service, cache: .memory(),
      context: { RemoteSettingsContext() }, refreshUsage: {}
    )
  }

  static func machine() -> UIViewController {
    final class Fixture {
      var items = [
        RemoteSetting(kind: "machine", id: machineOwner, name: "Studio Mac", detail: "macOS"),
        RemoteSetting(kind: "machine", id: "8b452c8d-7cf9-4b44-8b2b-331df59d6109", name: "Studio Mac", readOnly: true, detail: "macOS"),
      ]
      var failLoad = true
      var conflict = true
    }
    let fixture = Fixture()
    let workspace = "machine-settings-preview"
    let cache = RemoteSettingsCache.memory()
    cache.write("machine", SavedRemoteSettings(items: fixture.items, syncedAt: LodyRelativeTime.now() - 300_000))
    let service: RemoteSettingsService = { request in
      if fixture.failLoad {
        fixture.failLoad = false
        throw SettingsError(RemoteSettingsSections.remote("loadFailed"))
      }
      if let edit = request.edit {
        if edit.item.locked { throw SettingsError(RemoteSettingsSections.remote("readOnly")) }
        if fixture.conflict {
          fixture.conflict = false
          throw SettingsError(RemoteSettingsSections.remote("conflict"))
        }
        fixture.items = fixture.items.map { item in
          guard item.id == edit.item.id else { return item }
          var next = item
          next.name = edit.name.trimmingCharacters(in: .whitespacesAndNewlines)
          return next
        }
      }
      return fixture.items
    }
    let presence = SettingsMachinePresence(state: "live", onlineMachineIds: [machineOwner])
    return RemoteSettingsController(
      kind: "machine", scope: SettingsActor(userId: "fixture", workspaceId: workspace), service: service, cache: cache,
      context: { RemoteSettingsContext(presence: presence) }, refreshUsage: {}
    )
  }

  static func editor(_ params: [String: Any]) -> UIViewController {
    let kind = params["kind"] as? String ?? "machine"
    let item = RemoteSetting(kind: kind, id: "preview", name: "Studio", prompt: "Keep changes focused.", enabledByDefault: true)
    return RemoteSettingEditorController(item: item, workspaceId: "settings-forms-preview") { _ in [] }
  }
}

private let machineOwner = "7a341b7c-6be8-4a33-9a1a-220ce48c5098"
