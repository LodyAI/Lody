import Foundation

/// Online computers in words, for the workspace capsule's iPad detail and VoiceOver label.
struct InboxDevices {
  let summary: String

  init(catalog: SessionCatalog, presence: SettingsMachinePresence) {
    if presence.state == "live" {
      let online = catalog.machineIds.filter { presence.status(of: $0) == "online" }.count
      summary = String.localizedStringWithFormat(String(localized: "devices.summary", bundle: .lody), String(describing: online), String(describing: catalog.machineIds.count))
    } else {
      summary = String(localized: "devices.unknown", bundle: .lody)
    }
  }
}
