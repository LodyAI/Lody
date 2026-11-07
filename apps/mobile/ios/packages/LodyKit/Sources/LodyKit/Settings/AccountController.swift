import UIKit

@MainActor
final class AccountController: UIViewController {
  private let list = LodyGroupedList(frame: .zero)
  private let source: SettingsSource
  private var observers: [NSObjectProtocol] = []

  init(source: SettingsSource = .live) {
    self.source = source
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "account.title", bundle: .lody)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit { observers.forEach(NotificationCenter.default.removeObserver) }

  override func viewDidLoad() {
    super.viewDidLoad()
    list.frame = view.bounds
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.setPlaceholder(String(localized: "account.placeholder", bundle: .lody))
    list.forwarded = { [weak self] name, body in
      guard name == "rowPress", body["id"] as? String == "logout" else { return }
      self?.confirmLogout()
    }
    view.addSubview(list)
    for name in source.changes {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.render() }
      })
    }
    render()
  }

  private func render() {
    let state = source.state
    guard let account = state.account else {
      list.setSections([])
      let page = parent ?? self
      if let navigation = page.navigationController, let index = navigation.viewControllers.firstIndex(of: page), index > 0 {
        navigation.popToViewController(navigation.viewControllers[index - 1], animated: true)
      }
      return
    }
    var user = LodyListRow()
    user.id = "name"
    user.title = account.user.name
    user.subtitle = account.user.email
    user.image = account.user.image ?? "person.crop.circle"
    var logout = LodyListRow()
    logout.id = "logout"
    logout.title = String(localized: String.LocalizationValue(state.busy ? "account.signingOut" : "account.signOut"), bundle: .lody)
    logout.destructive = true
    logout.action = !state.busy
    var profile = LodyListSection()
    profile.id = "account"
    profile.rows = [user]
    var actions = LodyListSection()
    actions.id = "logout"
    actions.footer = state.error ?? ""
    actions.rows = [logout]
    list.setSections([profile, actions])
  }

  private func confirmLogout() {
    let alert = UIAlertController(
      title: String(localized: "account.signOutConfirm.title", bundle: .lody), message: String(localized: "account.signOutConfirm.message", bundle: .lody),
      preferredStyle: .alert
    )
    alert.addAction(UIAlertAction(title: String(localized: "common.cancel", bundle: .lody), style: .cancel))
    alert.addAction(UIAlertAction(title: String(localized: "account.signOut", bundle: .lody), style: .destructive) { [weak self] _ in
      guard let self else { return }
      Task { await self.source.logout() }
    })
    present(alert, animated: true)
  }
}
