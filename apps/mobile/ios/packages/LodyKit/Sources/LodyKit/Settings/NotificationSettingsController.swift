import UIKit

struct NotificationService {
  struct Push: Equatable {
    var configured: Bool
    var permission: String
  }

  var status: @MainActor () async throws -> Push
  var request: @MainActor () async throws -> Bool
  var settings: @MainActor () async throws -> Void

  struct OpenFailed: Error {}

  @MainActor static let live = NotificationService(
    status: {
      await withCheckedContinuation { continuation in
        PushNotifications.shared.status { value in
          continuation.resume(returning: Push(
            configured: value["configured"] as? Bool ?? false, permission: value["permission"] as? String ?? "denied"
          ))
        }
      }
    },
    request: {
      await withCheckedContinuation { continuation in
        PushNotifications.shared.request { continuation.resume(returning: $0) }
      }
    },
    settings: {
      guard let url = URL(string: UIApplication.openSettingsURLString), await UIApplication.shared.open(url) else {
        throw OpenFailed()
      }
    }
  )
}

@MainActor
final class NotificationSettingsController: UIViewController {
  private let list = LodyGroupedList(frame: .zero)
  private let service: NotificationService
  private let signedIn: @MainActor () -> Bool
  private var observers: [NSObjectProtocol] = []
  private var push: NotificationService.Push?
  private var busy = false

  init(service: NotificationService = .live, signedIn: @escaping @MainActor () -> Bool = { SettingsSource.live.state.account != nil }) {
    self.service = service
    self.signedIn = signedIn
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "settings.notifications.title", bundle: .lody)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit { observers.forEach(NotificationCenter.default.removeObserver) }

  override func viewDidLoad() {
    super.viewDidLoad()
    list.frame = view.bounds
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.accessibilityIdentifier = "notification-settings"
    list.forwarded = { [weak self] name, body in self?.event(name, body) }
    view.addSubview(list)
    observers.append(NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.refresh() }
    })
    for name in SettingsSource.live.changes {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.render() }
      })
    }
    render()
    refresh()
  }

  private func refresh() {
    Task { [weak self] in await self?.read() }
  }

  private func read() async {
    do {
      let push = try await service.status()
      self.push = push
    } catch {
      LodyToastOverlay.shared.show(message: text("notifications.readFailed"), kind: .error)
    }
    render()
  }

  private func event(_ name: String, _ body: [String: Any]) {
    guard let id = body["id"] as? String else { return }
    switch (name, id) {
    case ("rowPress", "notification-permission"): Task { await press() }
    default: break
    }
  }

  private func press() async {
    guard !busy, let push, push.configured, signedIn() else { return }
    busy = true
    render()
    do {
      if push.permission == "notDetermined" {
        _ = try await service.request()
      } else {
        try await service.settings()
      }
      await read()
    } catch {
      LodyToastOverlay.shared.show(message: text("notifications.changeFailed"), kind: .error)
    }
    busy = false
    render()
  }

  private func render() {
    guard isViewLoaded else { return }
    let signedIn = signedIn()
    let configured = push?.configured == true
    let permission = LodyListRow.item(
      "notification-permission", permissionTitle, subtitle: permissionHint(signedIn: signedIn), image: "bell",
      action: signedIn && configured && !busy, disclosure: signedIn && configured
    )
    list.setSections([
      .group("notifications", header: text("notifications.section.header"), footer: text("notifications.section.footer"), [
        permission,
      ]),
    ])
  }

  private var permissionTitle: String {
    if busy { return text("notifications.permission.busy") }
    if push?.permission == "notDetermined" { return text("notifications.permission.turnOn") }
    return text("notifications.permission.settings")
  }

  private func permissionHint(signedIn: Bool) -> String {
    guard signedIn else { return text("notifications.hint.signedOut") }
    guard let push else { return text("notifications.hint.loading") }
    guard push.configured else { return text("notifications.hint.unsupported") }
    switch push.permission {
    case "authorized": return text("notifications.hint.authorized")
    case "denied": return text("notifications.hint.denied")
    default: return text("notifications.hint.default")
    }
  }

  private func text(_ key: String) -> String { String(localized: String.LocalizationValue(key), bundle: .lody) }
}
