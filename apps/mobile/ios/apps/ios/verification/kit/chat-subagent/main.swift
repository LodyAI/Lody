import UIKit

struct LodyListRow {
  var parent = false
  var imageTint = ""
  var unread = false
}

@MainActor func descendants(_ view: UIView) -> [UIView] {
  view.subviews.flatMap { [$0] + descendants($0) }
}

func sameColor(_ actual: UIColor?, _ expected: UIColor, traits: UITraitCollection) -> Bool {
  actual?.resolvedColor(with: traits) == expected.resolvedColor(with: traits)
}

let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 400))
window.isHidden = false
let width: CGFloat = 358
let traits = window.traitCollection
var row = ChatRow(
  id: "reply:subagent", entryID: "reply", kind: "subagent_task", text: "",
  actionable: true,
  subagent: ChatSubagentCard(actor: "Researcher", description: "Inspect routing", status: "in_progress", detail: "", background: false),
  treeChild: true,
  treeLast: true
)
let cell = ChatSubagentCell(frame: CGRect(x: 0, y: 0, width: width, height: 40))
window.addSubview(cell)

@MainActor func render(_ value: ChatRow) {
  cell.frame.size.height = ChatSubagentCell.height(value, width: width, traits: traits)
  cell.configure(value)
  cell.setNeedsLayout()
  cell.layoutIfNeeded()
}

@MainActor func treePath() -> CGPath? {
  cell.contentView.layer.sublayers?.compactMap { $0 as? CAShapeLayer }.first { !$0.isHidden }?.path
}

render(row)
let views = descendants(cell.contentView)
precondition(views.contains { $0 is LodyStatusGlyphView }, "Sub-agent rows must render a native rail glyph")
let glyph = views.compactMap { $0 as? LodyStatusGlyphView }.first!
precondition(abs(glyph.frame.midX - (46 - 16)) < 0.01, "Child glyphs must align with the child rail")
precondition(glyph.kind == .live, "Running tasks must show the live glyph")
let labels = views.compactMap { $0 as? UILabel }
let title = labels.first { $0.attributedText?.string == "Inspect routing · Researcher" }!
precondition(abs(title.frame.minX - (62 - 16)) < 0.01, "Child titles must align with the child text column")
let attributed = title.attributedText!
let titleFont = attributed.attribute(.font, at: 0, effectiveRange: nil) as! UIFont
precondition(abs(titleFont.pointSize - LodyDesign.font(.subheadline, size: 14, compatibleWith: traits).pointSize) < 0.01)
precondition(sameColor(attributed.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? UIColor, .lodyInk, traits: traits))
precondition(sameColor(attributed.attribute(.foregroundColor, at: attributed.length - 1, effectiveRange: nil) as? UIColor, .lodySecondary, traits: traits))
precondition(title.numberOfLines == 1 && title.lineBreakMode == .byTruncatingTail)
precondition(cell.bounds.height == 44, "Rows without detail keep the 44 pt touch target")
let lastPath = treePath()!
precondition(abs(lastPath.boundingBoxOfPath.minX - (24 - 16)) < 0.01, "The child tree must continue the process trunk")
precondition(lastPath.boundingBoxOfPath.minY == 0, "The tree must connect to the preceding row")
precondition(abs(lastPath.boundingBoxOfPath.maxY - glyph.frame.midY) < 0.01, "The last child's tree must stop at its elbow")
precondition(abs(lastPath.boundingBoxOfPath.maxX - (glyph.frame.minX - 1)) < 0.01, "The elbow must reach the glyph with the Home tree spacing")
precondition(cell.accessibilityIdentifier == row.id && cell.accessibilityTraits == .button)
precondition(cell.accessibilityLabel == "Researcher, Inspect routing", "The row must preserve its accessibility label")
precondition(cell.accessibilityValue == String(localized: "native.chat.subagent.running", bundle: .lody))
for view in views {
  let alpha = view.backgroundColor?.resolvedColor(with: traits).cgColor.alpha ?? 0
  precondition(alpha == 0 && view.layer.cornerRadius == 0, "Rail rows must have no card backgrounds or rounded subviews")
}
let lineOneY = glyph.frame.midY
row.treeLast = false
render(row)
precondition(abs(treePath()!.boundingBoxOfPath.maxY - cell.bounds.height) < 0.01, "Non-last children must continue the trunk to the next row")

row.subagent?.detail = "Read the routing implementation and report the result. " + String(repeating: "Details ", count: 20)
row.subagent?.status = "completed"
render(row)
precondition(cell.bounds.height > 44 && abs(cell.bounds.height - 52) <= 4, "Detail rows must grow to about 52 pt, got \(cell.bounds.height)")
precondition(glyph.frame.midY == lineOneY, "Detail must not move the elbow away from line one")
let detail = labels.first { $0.text == row.subagent?.detail }!
precondition(detail.numberOfLines == 1 && detail.lineBreakMode == .byTruncatingTail, "Detail must occupy one tail-truncated line")
precondition(detail.frame.minX == title.frame.minX && detail.frame.minY >= title.frame.maxY)
precondition(detail.frame.maxY <= cell.bounds.height, "The second line must fit within the measured row")
precondition(sameColor(detail.textColor, .lodySecondary, traits: traits))
precondition(abs(detail.font.pointSize - LodyDesign.font(.footnote, size: 12.5, compatibleWith: traits).pointSize) < 0.01)

row.treeChild = false
render(row)
precondition(abs(glyph.frame.midX - (24 - 16)) < 0.01, "Top-level glyphs must use the primary rail")
precondition(abs(title.frame.minX - (46 - 16)) < 0.01, "Top-level titles must use the primary text column")
precondition(treePath() == nil, "Reusing a child as a top-level row must clear the tree")

row.subagent?.status = "failed"
row.subagent?.background = true
render(row)
precondition(glyph.kind == .failed)
let status = labels.first {
  $0.text == String(localized: "native.chat.subagent.failed", bundle: .lody) + " · " + String(localized: "native.chat.subagent.background", bundle: .lody)
}!
precondition(sameColor(status.textColor, .lodyFailure, traits: traits))
precondition(abs(status.font.pointSize - LodyDesign.mono(11.5, compatibleWith: traits).pointSize) < 0.01)
precondition(status.frame.minX >= title.frame.maxX && status.frame.maxX <= cell.bounds.width, "Trailing status must not overlap the title")
precondition(sameColor(detail.textColor, .lodySecondary, traits: traits), "Failure details retain the secondary text color")
row.subagent?.status = "completed"
row.subagent?.detail = ""
row.subagent?.background = false
row.actionable = false
cell.prepareForReuse()
render(row)
precondition(glyph.kind == .done && cell.bounds.height == 44 && detail.isHidden)
precondition(sameColor(status.textColor, .lodyTertiary, traits: traits))
precondition(cell.accessibilityTraits == .staticText)
row.subagent?.status = "pending"
render(row)
precondition(glyph.kind == .live, "Pending tasks retain the existing active-state treatment")
row.subagent?.status = "in_progress"
row.subagent?.detail = String.localizedStringWithFormat(String(localized: "native.chat.subagent.runningTool", bundle: .lody), "bash")
render(row)
precondition(status.text == row.subagent?.detail, "Running tool activity must appear in the trailing status")
precondition(detail.isHidden && cell.bounds.height == 44, "Running tool activity must not repeat as a second line")
print("Chat subagent: rail geometry, tree continuity, status, detail, reuse and accessibility passed")
