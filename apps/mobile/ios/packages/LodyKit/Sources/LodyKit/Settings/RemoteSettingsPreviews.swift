import UIKit

@MainActor
enum RemoteSettingsPreviews {
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
    let item = RemoteSetting(kind: kind, id: "preview", name: "Studio", prompt: "Keep changes focused.")
    return RemoteSettingEditorController(item: item, workspaceId: "settings-forms-preview") { _ in [] }
  }
}

private let machineOwner = "7a341b7c-6be8-4a33-9a1a-220ce48c5098"
