import UserNotifications
import OneSignalExtension

final class NotificationService: UNNotificationServiceExtension {
  private var handler: ((UNNotificationContent) -> Void)?
  private var request: UNNotificationRequest?
  private var content: UNMutableNotificationContent?
  private var diagnosticFields: [String: String] = [:]

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    self.request = request
    handler = contentHandler
    let custom = request.content.userInfo["custom"] as? [String: Any]
    diagnosticFields = ["message": custom?["i"] as? String ?? ""]
    DiagnosticsStore.shared.record("notification", "extension_received", fields: diagnosticFields)
    DiagnosticsStore.shared.flush()
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      DiagnosticsStore.shared.record("notification", "extension_fallback", fields: diagnosticFields)
      DiagnosticsStore.shared.flush()
      contentHandler(request.content)
      return
    }
    self.content = content
    let fields = diagnosticFields
    OneSignalExtension.didReceiveNotificationExtensionRequest(request, with: content, withContentHandler: { content in
      DiagnosticsStore.shared.record("notification", "extension_completed", fields: fields)
      DiagnosticsStore.shared.flush()
      contentHandler(content)
    })
  }

  override func serviceExtensionTimeWillExpire() {
    guard let request, let content, let handler else { return }
    DiagnosticsStore.shared.record("notification", "extension_expiring", fields: diagnosticFields)
    DiagnosticsStore.shared.flush()
    OneSignalExtension.serviceExtensionTimeWillExpireRequest(request, with: content)
    handler(content)
  }
}
