import UIKit

@MainActor
final class AboutController: UIViewController {
  private let list = LodyGroupedList(frame: .zero)

  init() {
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "settings.section.about", bundle: .lody)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    list.frame = view.bounds
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.forwarded = { [weak self] name, body in self?.event(name, body) }
    view.addSubview(list)
    let info = Bundle.main.infoDictionary
    let version = info?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    let build = info?["CFBundleVersion"] as? String ?? "1"
    list.setSections([.group("about", [
      .item("app-version", "Lody for iOS", subtitle: "\(version) (\(build))", image: "info.circle", action: false),
      .item("licenses", String(localized: "settings.licenses.title", bundle: .lody), image: "doc.text", disclosure: true, navigates: true),
    ])])
  }

  private func event(_ name: String, _ body: [String: Any]) {
    guard name == "rowPress", body["id"] as? String == "licenses" else { return }
    LodyShell.shared.pushNative(LicensesController(), title: String(localized: "settings.licenses.title", bundle: .lody), from: self)
  }
}
