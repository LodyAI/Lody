import ChatKitCore
import ChatKit
import UIKit

// A downstream consumer: no @testable import, app models or services.
let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 500))
let controller = UIViewController()
window.rootViewController = controller
window.isHidden = false
let strip = CKAttachmentStrip()
strip.frame = CGRect(x: 0, y: 0, width: 360, height: 50)
controller.view.addSubview(strip)
let other = CKAttachmentStrip()
other.frame = CGRect(x: 0, y: 60, width: 360, height: 50)
controller.view.addSubview(other)
let first = CKAttachmentItem(id: "first", name: "First.txt")
let second = CKAttachmentItem(id: "second", name: "Second.txt")
strip.render([first, second], animatedInsertion: false)
other.render([first], animatedInsertion: false)
window.layoutIfNeeded()
assert(strip.attachmentFrame(id: "first")!.minX < strip.attachmentFrame(id: "second")!.minX)
strip.render([second, first], animatedInsertion: false)
window.layoutIfNeeded()
assert(strip.attachmentFrame(id: "second")!.minX < strip.attachmentFrame(id: "first")!.minX,
       "Reordering stable IDs must reorder the displayed pills")

let otherWidth = other.attachmentFrame(id: "first")!.width
var custom = strip.style
custom.theme.textColor = .systemIndigo
custom.font = .systemFont(ofSize: 20, weight: .bold)
custom.cornerRadius = 8
custom.maximumWidth = 260
strip.style = custom
window.layoutIfNeeded()
assert(other.attachmentFrame(id: "first")!.width == otherWidth, "Styles must be instance-local")
assert(strip.attachmentFrame(id: "first")!.width > otherWidth, "Font changes must remeasure content")

@MainActor func buttons(in view: UIView) -> [UIButton] {
  view.subviews.flatMap { child -> [UIButton] in
    if let button = child as? UIButton { return [button] }
    return buttons(in: child)
  }
}
var previewed: String?
var removed: String?
strip.onPreview = { previewed = $0 }
strip.onRemove = { removed = $0 }
buttons(in: strip).first { $0.accessibilityLabel == "Preview First.txt" }!.sendActions(for: .touchUpInside)
buttons(in: strip).first { $0.accessibilityLabel == "Remove First.txt" }!.sendActions(for: .touchUpInside)
assert(previewed == "first" && removed == "first", "Restyling must preserve action identity")
strip.render([second], animatedRemoval: false, animatedInsertion: false)
assert(strip.attachmentFrame(id: "first") == nil)
assert(strip.hasVisiblePills && other.hasVisiblePills)
strip.render([], animatedRemoval: false)
assert(!strip.hasVisiblePills && other.hasVisiblePills)

var stream = CKTextReveal()
stream.receive("👩🏽‍💻 Reply", animate: true, at: 1)
stream.advance(at: 1.02)
assert("👩🏽‍💻 Reply".hasPrefix(stream.shown))
stream.receive("Corrected reply", animate: true, at: 1.03)
stream.advance(at: 2)
assert(stream.shown == "Corrected reply" && !stream.hasPending)
let text = CKTextView(frame: CGRect(x: 0, y: 120, width: 200, height: 100))
controller.view.addSubview(text)
text.setText(NSAttributedString(string: stream.shown, attributes: [.font: UIFont.systemFont(ofSize: 17)]))
assert(text.attributedTextValue.string == "Corrected reply")
assert(text.sizeThatFits(CGSize(width: 200, height: 1000)).height > 0)
print("ChatKit downstream behavior passed: reorder, styles, callbacks, removal, stream correction and text layout")
