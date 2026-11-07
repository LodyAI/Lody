import UIKit

func texts(_ view: UIView) -> [String] {
  var result: [String] = []
  if let label = view as? UILabel, let text = label.text, !text.isEmpty {
    result.append(text)
  }
  if let button = view as? UIButton {
    if let title = button.configuration?.title, !title.isEmpty { result.append(title) }
    if let subtitle = button.configuration?.subtitle, !subtitle.isEmpty { result.append(subtitle) }
    if let attributed = button.configuration?.attributedSubtitle {
      let string = String(attributed.characters)
      if !string.isEmpty { result.append(string) }
    }
    if let label = button.titleLabel?.text, !label.isEmpty { result.append(label) }
  }
  for subview in view.subviews { result += texts(subview) }
  return result
}

func containsText(_ view: UIView, _ needle: String) -> Bool {
  texts(view).contains { $0.contains(needle) }
}

func subtitleText(_ button: UIButton) -> String {
  if let titleButton = button as? ChatNavigationTitleButton {
    return titleButton.captionLabel.attributedText?.string ?? ""
  }
  if let attributed = button.configuration?.attributedSubtitle {
    return String(attributed.characters)
  }
  return button.configuration?.subtitle ?? ""
}

func subtitleAttachments(_ button: UIButton) -> Int {
  let ns: NSAttributedString?
  if let titleButton = button as? ChatNavigationTitleButton {
    ns = titleButton.captionLabel.attributedText
  } else if let attributed = button.configuration?.attributedSubtitle {
    ns = NSAttributedString(attributed)
  } else {
    ns = nil
  }
  guard let ns else { return 0 }
  var count = 0
  ns.enumerateAttribute(.attachment, in: NSRange(location: 0, length: ns.length)) { value, _, _ in
    if value is NSTextAttachment { count += 1 }
  }
  return count
}

func titleSnapshot(_ host: UIView) -> Data {
  let size = CGSize(width: max(1, host.bounds.width), height: max(1, host.bounds.height))
  return UIGraphicsImageRenderer(size: size).image { context in
    UIColor.white.setFill()
    context.fill(CGRect(origin: .zero, size: size))
    host.layer.render(in: context.cgContext)
  }.pngData()!
}

precondition(
  ChatNavigationTitle.plainSubtitle(project: "Project name", machine: "Studio") == "Project name · Studio",
  "Plain subtitle joins project and computer names"
)
precondition(
  ChatNavigationTitle.plainSubtitle(project: "Project name", machine: "") == "Project name",
  "A missing computer name must not leave a dangling separator"
)

let button = ChatNavigationTitleButton()
button.accessibilityIdentifier = "chat-navigation-title"
ChatNavigationTitle.configureButton(button, title: "Session title", subtitle: "Project name", machine: "Studio")
precondition(button.displayedTitle == "Session title", "First line shows the session title")
precondition(button.configuration?.title == nil, "First line must not be a static configuration title")
precondition(button.titleHost.superview === button, "First line renders through the numeric-text host")
let item = UINavigationItem(title: "Session title")
ChatNavigationTitle.apply(title: "Session title", subtitle: "Project name · Studio", button: button, to: item)

precondition(item.style == .browser, "Browser style keeps the two-line title")
precondition(item.titleView === button, "Title stays tappable")
precondition(subtitleText(button).contains("Project name"), "Settled titleView shows the project name")
precondition(subtitleText(button).contains("Studio"), "Settled titleView shows the computer name")
precondition(subtitleAttachments(button) == 2, "Subtitle must show folder and computer symbols")
precondition(button.accessibilityLabel?.contains("Project name") == true)
precondition(button.accessibilityLabel?.contains("Studio") == true)
precondition(button.accessibilityLabel?.contains("m1") != true, "The title must not speak a machine id")

// Branch changes update the shared caption and accessibility without renaming the session.
ChatNavigationTitle.configureButton(button, title: "Session title", subtitle: "Project name", machine: "Studio", branch: "feature/chat")
precondition(subtitleText(button).contains("feature/chat"))
precondition(button.captionLabel.lineBreakMode == .byTruncatingTail, "Narrow headers preserve the leading branch indicator")
precondition(subtitleAttachments(button) == 3, "Branch has a symbol alongside project and machine")
precondition(button.accessibilityLabel?.contains("feature/chat") == true)
precondition(ChatNavigationTitle.plainSubtitle(project: "", machine: "", branch: "main") == "main")
ChatNavigationTitle.configureButton(button, title: "Session title", subtitle: "Project name", machine: "Studio", branch: "main")
precondition(!subtitleText(button).contains("feature/chat") && subtitleText(button).contains("main"))
ChatNavigationTitle.configureButton(button, title: "Session title", subtitle: "Project name", machine: "Studio")
precondition(!subtitleText(button).contains("main") && subtitleAttachments(button) == 2)

let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
let root = UIViewController()
root.title = "Inbox"
let nav = UINavigationController(rootViewController: root)
let session = UIViewController()
session.view.backgroundColor = .systemBackground
ChatNavigationTitle.configureButton(button, title: "Session title", subtitle: "Project name", machine: "Studio")
ChatNavigationTitle.apply(title: "Session title", subtitle: "Project name · Studio", button: button, to: session.navigationItem)
nav.pushViewController(session, animated: false)
window.rootViewController = nav
window.makeKeyAndVisible()
nav.view.setNeedsLayout()
nav.view.layoutIfNeeded()
session.view.layoutIfNeeded()

precondition(containsText(nav.navigationBar, "Project name"), "Nav bar must show the project name")
precondition(containsText(nav.navigationBar, "Studio"), "Nav bar must show the computer name")
precondition(subtitleAttachments(button) == 2, "Folder and computer symbols must survive layout")

ChatNavigationTitle.setDisappearing(true, on: session.navigationItem)
ChatNavigationTitle.preserveSubtitle("Project name · Studio", on: session.navigationItem)
session.navigationItem.titleView = nil
session.navigationItem.title = "Session title"
nav.view.setNeedsLayout()
nav.view.layoutIfNeeded()
precondition(session.navigationItem.titleView == nil, "A disappearing page must let screens keep the slot for the pop transition")
precondition(
  session.navigationItem.subtitle == "Project name · Studio",
  "A screens header update that nils titleView must keep UINavigationItem.subtitle"
)
precondition(
  containsText(nav.navigationBar, "Project name"),
  "Project name must stay visible after titleView is cleared"
)
precondition(
  containsText(nav.navigationBar, "Studio"),
  "Computer name must stay visible after titleView is cleared"
)

ChatNavigationTitle.setDisappearing(false, on: session.navigationItem)
precondition(session.navigationItem.titleView === button, "Cancelled return must restore the tappable title")
ChatNavigationTitle.apply(title: "Session title", subtitle: "Project name · Studio", button: button, to: session.navigationItem)
precondition(session.navigationItem.subtitle == nil, "Restoring titleView must drop the native subtitle so the button stays visible")

ChatNavigationTitle.detach(button: button, from: session.navigationItem)
precondition(session.navigationItem.titleView !== button)
session.navigationItem.title = "Static route title"
precondition(session.navigationItem.title == "Static route title", "A detached header must not own the route title")
ChatNavigationTitle.apply(title: "Session title", subtitle: "Project name · Studio", button: button, to: session.navigationItem)
precondition(session.navigationItem.titleView === button)
precondition(session.navigationItem.title == "Session title", "Attaching takes the title back from the static route title")

// A full-screen preview preserves the fallback without removing our titleView.
ChatNavigationTitle.preserveSubtitle("Project name · Studio", on: session.navigationItem)
ChatNavigationTitle.apply(title: "Session title", subtitle: "Project name · Studio", button: button, to: session.navigationItem)
nav.view.layoutIfNeeded()
precondition(session.navigationItem.subtitle == nil, "Preview return must not show a second subtitle alongside the retained titleView")
precondition(session.navigationItem.titleView === button)

button.layoutIfNeeded()

func transitionFrames(_ change: () -> Void) -> (settled: Data, mid: [Data], final: Data) {
  let settled = titleSnapshot(button.titleHost)
  change()
  precondition(session.navigationItem.titleView === button, "A screens header reset must not take the title away from native")
  nav.view.layoutIfNeeded()
  button.layoutIfNeeded()
  var mid: [Data] = []
  for _ in 0..<6 {
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    mid.append(titleSnapshot(button.titleHost))
  }
  RunLoop.main.run(until: Date().addingTimeInterval(0.8))
  return (settled, mid, titleSnapshot(button.titleHost))
}

func screensHeaderReset(title: String) {
  session.navigationItem.titleView = nil
  session.navigationItem.title = title
  session.navigationItem.rightBarButtonItems = nil
}

let first = transitionFrames {
  ChatNavigationTitle.configureButton(button, title: "Brand new heading", subtitle: "Project name", machine: "Studio")
  ChatNavigationTitle.apply(title: "Brand new heading", subtitle: "Project name · Studio", button: button, to: session.navigationItem)
  screensHeaderReset(title: "Static route title")
}
precondition(button.displayedTitle == "Brand new heading", "Title updates keep the numeric-text host in sync")
precondition(session.navigationItem.title == "Brand new heading", "The owner keeps the session title over the static route title")
precondition(first.final != first.settled, "Snapshot must reflect the new title")
if !UIAccessibility.isReduceMotionEnabled {
  precondition(
    first.mid.contains { $0 != first.settled && $0 != first.final },
    "Title change followed by a screens header reset must still run the numeric text transition"
  )
}

let second = transitionFrames {
  screensHeaderReset(title: "Static route title")
  ChatNavigationTitle.configureButton(button, title: "Third heading", subtitle: "Project name", machine: "Studio")
  ChatNavigationTitle.apply(title: "Third heading", subtitle: "Project name · Studio", button: button, to: session.navigationItem)
}
precondition(button.displayedTitle == "Third heading")
if !UIAccessibility.isReduceMotionEnabled {
  precondition(
    second.mid.contains { $0 != second.settled && $0 != second.final },
    "Screens header reset followed by a title change must still run the numeric text transition"
  )
}

var actions: [String] = []
let itemsJSON = """
[
  {"id":"r0","type":"button","title":"PR #31","accessibilityLabel":"PR #31，1 项检查失败","badge":"!"},
  {"type":"spacing","spacing":8},
  {"id":"r2","type":"menu","icon":"ellipsis","accessibilityLabel":"更多","menu":{"items":[
    {"id":"r2.0","type":"action","title":"Merged"},
    {"id":"r2.1","type":"action","title":"Hidden","hidden":true},
    {"type":"submenu","inline":true,"items":[{"id":"r2.2.0","type":"action","title":"Files","icon":"folder","disabled":true}]}
  ]}}
]
"""
let items = LodyNavigationHeaderItems.decode(itemsJSON) { actions.append($0) }
precondition(items.count == 3, "Decoded one item per spec entry")
precondition(items[0].badge != nil, "PR button carries its attention badge")
precondition(items[0].accessibilityLabel == "PR #31，1 项检查失败", "Button keeps its VoiceOver label")
precondition(items[0].title == "PR #31")
precondition(items[1].width == 8, "Spacing becomes a fixed space")
precondition(items[2].image != nil && items[2].menu != nil, "Menu item shows its symbol and menu")
precondition(items[2].accessibilityLabel == "更多")
let children = items[2].menu?.children ?? []
precondition(children.count == 2, "Hidden actions are dropped: \(children.count)")
precondition((children[0] as? UIAction)?.title == "Merged")
let inline = children[1] as? UIMenu
precondition(inline?.options.contains(.displayInline) == true, "Submenu keeps displayInline")
let nested = inline?.children.first as? UIAction
precondition(nested?.title == "Files" && nested?.attributes.contains(.disabled) == true && nested?.image != nil)
nested?.performWithSender(nil, target: nil)
items[0].primaryAction?.performWithSender(nil, target: nil)
precondition(actions == ["r2.2.0", "r0"], "Actions report their ids: \(actions)")

let header = LodyNavigationHeader.of(session.navigationItem)
header.rightItems = items
precondition(session.navigationItem.rightBarButtonItems == items, "Owned right items are applied")
session.navigationItem.rightBarButtonItems = nil
precondition(session.navigationItem.rightBarButtonItems == items, "A screens reset of right items is restored synchronously")
session.navigationItem.rightBarButtonItems = [UIBarButtonItem(systemItem: .done)]
precondition(session.navigationItem.rightBarButtonItems == items, "Foreign right items are replaced by the owned ones")
precondition(session.navigationItem.titleView === button && session.navigationItem.title == "Third heading")
header.rightItems = nil
session.navigationItem.rightBarButtonItems = nil
precondition(session.navigationItem.rightBarButtonItems?.isEmpty != false, "Releasing the slot lets screens own it again")

func inkRows(_ image: UIImage) -> (first: Int, last: Int) {
  guard let cgImage = image.cgImage else { return (-1, -1) }
  let width = cgImage.width
  let height = cgImage.height
  var pixels = [UInt8](repeating: 0, count: width * height * 4)
  guard let ctx = CGContext(
    data: &pixels,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: width * 4,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else { return (-1, -1) }
  ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
  var first = -1
  var last = -1
  for row in 0..<height {
    for column in 0..<width {
      let i = (row * width + column) * 4
      if Int(pixels[i]) + Int(pixels[i + 1]) + Int(pixels[i + 2]) < 720 {
        if first < 0 { first = row }
        last = row
        break
      }
    }
  }
  return (first, last)
}

func lowestInkRow(_ image: UIImage) -> Int { inkRows(image).last }

func snapshotImage(_ view: UIView) -> UIImage {
  let size = CGSize(width: max(1, view.bounds.width), height: max(1, view.bounds.height))
  return UIGraphicsImageRenderer(size: size).image { context in
    UIColor.white.setFill()
    context.fill(CGRect(origin: .zero, size: size))
    view.layer.render(in: context.cgContext)
  }
}

ChatNavigationTitle.configureButton(button, title: "lody", subtitle: "", machine: "")
nav.view.layoutIfNeeded()
button.layoutIfNeeded()
RunLoop.main.run(until: Date().addingTimeInterval(0.3))
let titleY = snapshotImage(button.titleHost)
ChatNavigationTitle.configureButton(button, title: "lodx", subtitle: "", machine: "")
nav.view.layoutIfNeeded()
button.layoutIfNeeded()
RunLoop.main.run(until: Date().addingTimeInterval(0.3))
let titleX = snapshotImage(button.titleHost)
let titleYInk = lowestInkRow(titleY)
let titleXInk = lowestInkRow(titleX)
precondition(
  titleYInk >= titleXInk + Int(titleY.scale * 2),
  "The title descender of y must not be clipped (y=\(titleYInk) x=\(titleXInk) h=\(button.titleHost.bounds.height))"
)

ChatNavigationTitle.configureButton(button, title: "Title", subtitle: "lody", machine: "")
nav.view.layoutIfNeeded()
button.layoutIfNeeded()
let subtitleY = snapshotImage(button.captionLabel)
ChatNavigationTitle.configureButton(button, title: "Title", subtitle: "lodx", machine: "")
nav.view.layoutIfNeeded()
button.layoutIfNeeded()
let subtitleYInk = lowestInkRow(subtitleY)
let subtitleXInk = lowestInkRow(snapshotImage(button.captionLabel))
precondition(
  subtitleYInk >= subtitleXInk + Int(subtitleY.scale * 2),
  "The subtitle descender of y in lody must not be clipped (y=\(subtitleYInk) x=\(subtitleXInk) h=\(button.captionLabel.bounds.height))"
)

ChatNavigationTitle.configureButton(button, title: "原生聊天预览", subtitle: "lody-ios", machine: "Studio")
nav.view.layoutIfNeeded()
button.layoutIfNeeded()
RunLoop.main.run(until: Date().addingTimeInterval(0.4))
let titleImage = snapshotImage(button.titleHost)
let subtitleImage = snapshotImage(button.captionLabel)
let titleInk = inkRows(titleImage)
let subtitleInk = inkRows(subtitleImage)
let scale = titleImage.scale
let titleBottom = button.titleHost.frame.minY + CGFloat(titleInk.last) / scale
let subtitleTop = button.captionLabel.frame.minY + CGFloat(subtitleInk.first) / scale
let gap = subtitleTop - titleBottom
precondition(
  gap >= 6 && gap <= 12,
  "Title-to-subtitle ink gap must leave a small gap (gap=\(gap) titleBottom=\(titleBottom) subtitleTop=\(subtitleTop))"
)

ChatNavigationTitle.configureButton(button, title: "Payg", subtitle: "lody-ios", machine: "Studio")
nav.view.layoutIfNeeded()
button.layoutIfNeeded()
RunLoop.main.run(until: Date().addingTimeInterval(0.4))
let descenderTitle = inkRows(snapshotImage(button.titleHost))
let descenderSubtitle = inkRows(snapshotImage(button.captionLabel))
let descenderBottom = button.titleHost.frame.minY + CGFloat(descenderTitle.last) / scale
let descenderTop = button.captionLabel.frame.minY + CGFloat(descenderSubtitle.first) / scale
let descenderGap = descenderTop - descenderBottom
precondition(
  descenderGap >= -1,
  "Title descenders must not collide with the subtitle (gap=\(descenderGap))"
)

// Device liveness stays with the computer, preserving the existing caption order.
ChatNavigationTitle.configureButton(button, title: "Session", subtitle: "Project", machine: "Studio", branch: "feature/a-very-long-branch-name", machineState: "online")
let onlineSubtitle = subtitleText(button)
precondition(onlineSubtitle.range(of: "Studio")!.lowerBound > onlineSubtitle.range(of: "feature/")!.lowerBound,
  "Device status must not reorder the conversation context")
precondition(button.captionLabel.lineBreakMode == .byTruncatingMiddle,
  "A long branch still leaves the trailing device state visible")
precondition(button.accessibilityLabel!.contains(String(localized: "devices.online", bundle: .lody)), "VoiceOver states device liveness")
ChatNavigationTitle.configureButton(button, title: "Session", subtitle: "Project", machine: "Studio", branch: "feature/a-very-long-branch-name", machineState: "offline")
precondition(subtitleText(button).contains(String(localized: "devices.offline", bundle: .lody)), "Offline is visible text, not color alone")
precondition(!button.accessibilityLabel!.contains(String(localized: "devices.online", bundle: .lody)), "VoiceOver does not retain the previous state")
precondition(button.sizeThatFits(CGSize(width: 220, height: 44)).height == 44, "Device status adds no navigation row")
print("PASS: chat navigation subtitle shows project and computer names")
