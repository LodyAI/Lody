import UIKit

@MainActor
final class LicensesController: UIViewController {
  private let list = LodyGroupedList(frame: .zero)

  init() {
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "settings.licenses.title", bundle: .lody)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    list.frame = view.bounds
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.forwarded = { [weak self] name, body in self?.event(name, body) }
    view.addSubview(list)
    list.setSections(Self.sections(), animated: false)
  }

  private func event(_ name: String, _ body: [String: Any]) {
    guard name == "rowPress", let id = body["id"] as? String, !id.isEmpty else { return }
    LodyShell.shared.pushNative(LicenseDetailController(name: id), title: id, from: self)
  }

  private static func sections() -> [LodyListSection] {
    let packages = LodyLicenses.packages
    var groups: [(id: String, header: String, rows: [LodyListRow])] = []
    if let own = packages.first(where: { $0.firstParty == true }) {
      groups.append(("app", String(localized: "settings.section.about", bundle: .lody), [row(own)]))
    }
    var byLetter: [String: [LodyListRow]] = [:]
    for entry in packages where entry.firstParty != true {
      byLetter[letter(entry.name), default: []].append(row(entry))
    }
    let letters = byLetter.keys.sorted { left, right in
      if left == "#" || right == "#" { return right == "#" && left != "#" }
      return left < right
    }
    groups += letters.map { ($0, $0, byLetter[$0] ?? []) }
    let footer = String(localized: "settings.licenses.footer", bundle: .lody)
    return groups.enumerated().map { index, group in
      .group(group.id, header: group.header, footer: index == groups.count - 1 ? footer : "", group.rows)
    }
  }

  private static func row(_ entry: LodyLicense) -> LodyListRow {
    .item(
      entry.name, entry.name, subtitle: entry.license, value: entry.version.map { "v\($0)" } ?? "",
      disclosure: true, navigates: true
    )
  }

  private static func letter(_ name: String) -> String {
    let bare = name.hasPrefix("@") ? name.split(separator: "/").dropFirst().first.map(String.init) ?? name : name
    let first = bare.prefix(1).uppercased()
    return first.count == 1 && first >= "A" && first <= "Z" ? first : "#"
  }
}
