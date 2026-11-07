import UIKit

@MainActor func descendants(_ view: UIView) -> [UIView] {
  [view] + view.subviews.flatMap(descendants)
}

let host = UIView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
let composer = UIView(frame: .zero)
composer.translatesAutoresizingMaskIntoConstraints = false
let overlay = ChatOverlay()
overlay.translatesAutoresizingMaskIntoConstraints = false
host.addSubview(composer)
host.addSubview(overlay)
NSLayoutConstraint.activate([
  composer.leadingAnchor.constraint(equalTo: host.leadingAnchor),
  composer.trailingAnchor.constraint(equalTo: host.trailingAnchor),
  composer.bottomAnchor.constraint(equalTo: host.bottomAnchor),
  composer.heightAnchor.constraint(equalToConstant: 64),
  overlay.leadingAnchor.constraint(equalTo: composer.leadingAnchor, constant: 16),
  overlay.trailingAnchor.constraint(equalTo: composer.trailingAnchor, constant: -16),
  overlay.bottomAnchor.constraint(equalTo: composer.topAnchor, constant: -8),
  overlay.heightAnchor.constraint(equalToConstant: ChatOverlay.controlSize),
])
let window = UIWindow(frame: host.bounds)
window.addSubview(host)
window.isHidden = false
host.layoutIfNeeded()

@MainActor func statusControl() -> UIButton {
  descendants(overlay).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "chat-overlay-status" }!
}

@MainActor func scrollControl() -> UIButton {
  descendants(overlay).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "chat-scroll-to-bottom" }!
}

@MainActor func frame(_ view: UIView) -> CGRect {
  view.convert(view.bounds, to: host)
}

@MainActor func shown(_ view: UIView) -> Bool {
  var current: UIView? = view
  while let node = current {
    if node.isHidden { return false }
    current = node.superview
  }
  return true
}

@MainActor func show(_ slot: ChatOverlay.Slot, scroll: Bool) {
  UIView.performWithoutAnimation {
    overlay.slot = slot
    overlay.scrollVisible = scroll
    host.layoutIfNeeded()
  }
}

precondition(ChatOverlay.slot(connection: "connecting") == .connecting)
precondition(ChatOverlay.slot(connection: "paused") == .paused)
precondition(ChatOverlay.slot(connection: "") == .idle)

show(.connecting, scroll: false)
precondition(!overlay.isHidden, "Connecting overlay must be visible")
precondition(!shown(scrollControl()), "Connecting alone must not show scroll-to-bottom")
let connecting = statusControl()
precondition(connecting.accessibilityLabel == String(localized: "native.chat.connection.connecting", bundle: .lody))
precondition(!connecting.accessibilityTraits.contains(.button), "Connecting is status, not an action")
precondition(abs(frame(connecting).midX - 195) < 1, "A single overlay item sits on the composer center")
let lineHeight = connecting.titleLabel!.font.lineHeight
precondition(abs(frame(connecting).height - lineHeight - 12) < 1,
  "Status height \(frame(connecting).height) follows line \(lineHeight) with six-point vertical padding")
precondition(abs(frame(connecting).maxY + 8 - composer.frame.minY) < 0.6, "Overlay shares the current scroll-button baseline")

var reconnected = false
overlay.onReconnect = { reconnected = true }
connecting.sendActions(for: .touchUpInside)
precondition(!reconnected, "Connecting must not invoke reconnect")

show(.connecting, scroll: true)
let statusBoth = frame(statusControl())
let scrollBoth = frame(scrollControl())
let sendSlotMaxX = composer.frame.maxX - 18
let sendSlotCenterX = sendSlotMaxX - ChatOverlay.controlSize / 2
precondition(shown(scrollControl()))
precondition(abs(scrollBoth.width - ChatOverlay.visualSize) < 0.5)
precondition(abs(scrollBoth.height - ChatOverlay.visualSize) < 0.5)
precondition(abs(scrollBoth.midX - sendSlotCenterX) < 0.5,
  "Scroll visual shares the send control center")
precondition(abs(statusBoth.maxY - scrollBoth.maxY) < 0.5, "Paired glasses share one baseline")
let expectedSymbol = UIImage(
  systemName: "arrow.down",
  withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .bold, scale: .medium)
)!
let sendSymbol = UIImage(
  systemName: "arrow.up",
  withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .bold, scale: .medium)
)!
precondition(abs(expectedSymbol.size.width - sendSymbol.size.width) < 0.5)
precondition(abs(expectedSymbol.size.height - sendSymbol.size.height) < 0.5)
let glyphs = descendants(scrollControl()).compactMap { $0 as? UIImageView }.filter { $0.image != nil }
precondition(glyphs.count == 1, "Scroll must draw one arrow image")
let glyph = glyphs[0]
precondition(
  abs((glyph.image?.size.width ?? 0) - expectedSymbol.size.width) < 0.5
    && abs((glyph.image?.size.height ?? 0) - expectedSymbol.size.height) < 0.5,
  "Scroll glyph image \(glyph.image?.size as Optional) must match send's 14 pt bold \(expectedSymbol.size)"
)
let fillsVisual = abs(glyph.bounds.width - ChatOverlay.visualSize) < 0.5
  && abs(glyph.bounds.height - ChatOverlay.visualSize) < 0.5
  && glyph.contentMode == .center
let sizedToSymbol = abs(glyph.bounds.width - expectedSymbol.size.width) < 1
  && abs(glyph.bounds.height - expectedSymbol.size.height) < 1
precondition(
  fillsVisual || sizedToSymbol,
  "Scroll glyph layout \(glyph.bounds.size) is not the 14 pt send size"
)
precondition(abs(statusBoth.midX - 195) < 1,
  "Showing scroll must not move the overlay status")
let inside = overlay.convert(CGPoint(x: scrollBoth.midX + 21, y: scrollBoth.midY), from: host)
precondition(
  overlay.hitTest(inside, with: nil) === scrollControl(),
  "Compact scroll glass retains a 44-point touch target"
)
let gap = overlay.convert(CGPoint(x: (statusBoth.maxX + scrollBoth.minX) / 2, y: scrollBoth.midY), from: host)
precondition(overlay.hitTest(gap, with: nil) == nil, "Empty overlay space passes touches to the transcript")
var scrolled = false
overlay.onScrollToBottom = { scrolled = true }
scrollControl().sendActions(for: .touchUpInside)
precondition(scrolled, "Scroll action reaches the transcript owner")

show(.paused, scroll: true)
let paused = statusControl()
precondition(paused.accessibilityLabel == String(localized: "native.chat.connection.paused", bundle: .lody))
precondition(paused.accessibilityTraits.contains(.button))
let pausedEdge = overlay.convert(CGPoint(x: frame(paused).midX, y: frame(paused).midY + 21), from: host)
precondition(overlay.hitTest(pausedEdge, with: nil) === paused,
  "Compact reconnect glass retains a 44-point touch target")
paused.sendActions(for: .touchUpInside)
precondition(reconnected, "Paused overlay must reconnect")

show(.paused, scroll: false)
precondition(!shown(scrollControl()))
precondition(abs(frame(statusControl()).midX - 195) < 1, "Dropping scroll returns status to center")

show(.idle, scroll: false)
precondition(overlay.isHidden, "Overlay must collapse when both states are gone")

show(.idle, scroll: true)
precondition(!overlay.isHidden)
precondition(!shown(statusControl()))
precondition(frame(scrollControl()) == scrollBoth, "Hiding status must not move the scroll action")

show(.idle, scroll: true)
host.frame.size = CGSize(width: 760, height: 520)
host.layoutIfNeeded()
let resized = frame(scrollControl())
precondition(abs(resized.midX - (composer.frame.maxX - 18 - ChatOverlay.controlSize / 2)) < 0.5)
precondition(abs(resized.maxY + 8 - composer.frame.minY) < 0.5,
  "Resizing the host preserves the composer baseline")
print("Chat overlay: 30-point scroll visual aligned with send, 44-point target, independent status, touch passthrough and resize passed")
