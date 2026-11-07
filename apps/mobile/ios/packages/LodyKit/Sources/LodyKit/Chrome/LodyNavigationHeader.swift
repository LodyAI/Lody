import ObjectiveC
import UIKit

@MainActor
final class LodyNavigationHeader: NSObject {
  private nonisolated(unsafe) static var associationKey: UInt8 = 0

  static func of(_ item: UINavigationItem) -> LodyNavigationHeader {
    if let existing = objc_getAssociatedObject(item, &associationKey) as? LodyNavigationHeader {
      return existing
    }
    let header = LodyNavigationHeader(item: item)
    objc_setAssociatedObject(item, &associationKey, header, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    return header
  }

  private(set) weak var item: UINavigationItem?
  private var observations: [NSKeyValueObservation] = []
  private var applying = false

  var title: String? { didSet { apply() } }
  var titleView: UIView? { didSet { apply() } }
  var rightItems: [UIBarButtonItem]? { didSet { apply() } }
  var leftItems: [UIBarButtonItem]? { didSet { apply() } }
  var search: LodyNavigationSearch? {
    didSet {
      if search == nil, let item, item.searchController === oldValue?.controller { item.searchController = nil }
      apply()
    }
  }
  var suspended = false {
    didSet { if !suspended { apply() } }
  }

  func refresh() { apply() }

  private init(item: UINavigationItem) {
    self.item = item
    super.init()
    // screens rewrites every slot on each header prop update and on appear;
    // the write-back must be synchronous because UIKit removes a replaced
    // titleView from the window immediately and only re-adds it on layout.
    observations = [
      item.observe(\.title) { [weak self] _, _ in self?.restore() },
      item.observe(\.titleView) { [weak self] _, _ in self?.restore() },
      item.observe(\.rightBarButtonItems) { [weak self] _, _ in self?.restore() },
      item.observe(\.leftBarButtonItems) { [weak self] _, _ in self?.restore() },
      item.observe(\.searchController) { [weak self] _, _ in self?.restore() },
    ]
  }

  private nonisolated func restore() {
    MainActor.assumeIsolated {
      guard !applying else { return }
      apply()
    }
  }

  private func apply() {
    guard !suspended, !applying, let item else { return }
    applying = true
    defer { applying = false }
    if let title, item.title != title { item.title = title }
    if let titleView, item.titleView !== titleView { item.titleView = titleView }
    if let rightItems, item.rightBarButtonItems ?? [] != rightItems { item.rightBarButtonItems = rightItems }
    if let leftItems, item.leftBarButtonItems ?? [] != leftItems { item.leftBarButtonItems = leftItems }
    if let search {
      if item.preferredSearchBarPlacement != search.placement { item.preferredSearchBarPlacement = search.placement }
      if item.hidesSearchBarWhenScrolling != search.hidesWhenScrolling {
        item.hidesSearchBarWhenScrolling = search.hidesWhenScrolling
      }
      if item.searchBarPlacementAllowsToolbarIntegration != search.allowsToolbarIntegration {
        item.searchBarPlacementAllowsToolbarIntegration = search.allowsToolbarIntegration
      }
      if item.searchController !== search.controller { item.searchController = search.controller }
    }
  }
}

@MainActor
enum LodyNavigationHeaderItems {
  typealias Action = @MainActor (String) -> Void

  struct Slots {
    var view: (Int, CGSize) -> UIView? = { _, _ in nil }
    var search: () -> UIBarButtonItem? = { nil }
  }

  static func decode(_ json: String, slots: Slots = Slots(), action: @escaping Action) -> [UIBarButtonItem] {
    guard let data = json.data(using: .utf8),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    else { return [] }
    return raw.compactMap { barItem($0, slots: slots, action: action) }
  }

  private static func barItem(_ spec: [String: Any], slots: Slots, action: @escaping Action) -> UIBarButtonItem? {
    let type = spec["type"] as? String ?? "button"
    switch type {
    case "spacing": return .fixedSpace(CGFloat(spec["spacing"] as? Double ?? 0))
    case "flexibleSpacing": return .flexibleSpace()
    case "searchSlot": return slots.search()
    default: break
    }
    let id = spec["id"] as? String ?? ""
    let title = spec["title"] as? String
    let image = symbol(spec["icon"])
    let item: UIBarButtonItem
    if type == "view" {
      let size = CGSize(width: spec["width"] as? Double ?? 0, height: spec["height"] as? Double ?? 0)
      guard let view = slots.view(spec["slot"] as? Int ?? -1, size) else { return nil }
      item = UIBarButtonItem(customView: view)
    } else if type == "menu", let entries = (spec["menu"] as? [String: Any])?["items"] as? [[String: Any]] {
      item = UIBarButtonItem(
        title: title,
        image: image,
        primaryAction: nil,
        menu: menu(entries, title: "", inline: false, action: action)
      )
    } else if spec["systemItem"] as? String == "close" {
      item = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { _ in action(id) })
    } else {
      item = UIBarButtonItem(primaryAction: UIAction(title: title ?? "", image: image) { _ in action(id) })
    }
    item.isEnabled = spec["disabled"] as? Bool != true
    item.accessibilityLabel = spec["accessibilityLabel"] as? String ?? title
    item.accessibilityHint = spec["accessibilityHint"] as? String
    item.accessibilityIdentifier = spec["identifier"] as? String
    if let badge = spec["badge"] as? String, !badge.isEmpty {
      item.badge = .string(badge)
    }
    if let tint = (spec["tintColor"] as? String).flatMap(lodyTint) { item.tintColor = tint }
    if let hides = spec["hidesSharedBackground"] as? Bool { item.hidesSharedBackground = hides }
    if let shares = spec["sharesBackground"] as? Bool { item.sharesBackground = shares }
    if type != "view", let width = spec["width"] as? Double { item.width = CGFloat(width) }
    let styles: [String: UIBarButtonItem.Style] = ["done": .prominent, "prominent": .prominent]
    if let style = styles[spec["variant"] as? String ?? ""] { item.style = style }
    return item
  }

  private static func menu(
    _ entries: [[String: Any]],
    title: String,
    inline: Bool,
    action: @escaping Action
  ) -> UIMenu {
    UIMenu(
      title: title,
      options: inline ? .displayInline : [],
      children: entries.compactMap { element($0, action: action) }
    )
  }

  private static func element(_ spec: [String: Any], action: @escaping Action) -> UIMenuElement? {
    let title = spec["title"] as? String ?? ""
    let image = symbol(spec["icon"])
    if spec["type"] as? String == "submenu" {
      let entries = spec["items"] as? [[String: Any]] ?? []
      return menu(entries, title: title, inline: spec["inline"] as? Bool == true, action: action)
    }
    if spec["hidden"] as? Bool == true { return nil }
    let id = spec["id"] as? String ?? ""
    var attributes: UIMenuElement.Attributes = []
    if spec["disabled"] as? Bool == true { attributes.insert(.disabled) }
    if spec["destructive"] as? Bool == true { attributes.insert(.destructive) }
    let states: [String: UIMenuElement.State] = ["on": .on, "mixed": .mixed]
    return UIAction(
      title: title,
      subtitle: spec["subtitle"] as? String,
      image: image,
      attributes: attributes,
      state: states[spec["state"] as? String ?? ""] ?? .off
    ) { _ in action(id) }
  }

  private static func symbol(_ value: Any?) -> UIImage? {
    guard let name = value as? String, !name.isEmpty else { return nil }
    return UIImage(systemName: name)
  }
}
