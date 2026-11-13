import UIKit
import SwiftUI
import LodyDesignSystem

/// Compact conversation row geometry shared by operation receipts and the relations sheet.
/// Branches use Home's one-point rail and curved turn; decoration never owns touches.
final class ConversationTreeRow: UIView {
  let selectionBackground = UIView()
  var isCurrent = false
  let titleLabel = UILabel()
  let detailLabel = UILabel()
  let statusLabel = UILabel()
  let agentView = UIImageView()
  let glyph = LodyStatusGlyphView(kind: .none)
  private let branch = CAShapeLayer()
  private var working: UIView?
  var depth = 0
  var continues = false
  var ancestorRails: [Int] = []
  var showsAgent = true
  /// Horizontal room inside the row so the current-target capsule clears its content.
  var padding: CGFloat = 0

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    selectionBackground.backgroundColor = .tertiarySystemFill
    selectionBackground.isHidden = true
    addSubview(selectionBackground)
    layer.addSublayer(branch)
    branch.fillColor = nil
    branch.lineWidth = 1
    branch.lineCap = .round
    branch.lineJoin = .round
    for view in [agentView, titleLabel, detailLabel, statusLabel, glyph] { addSubview(view) }
    agentView.contentMode = .scaleAspectFit
    agentView.tintColor = LodyUIColor.textSecondary
    titleLabel.textColor = LodyUIColor.textPrimary
    detailLabel.textColor = LodyUIColor.textSecondary
    statusLabel.textColor = LodyUIColor.textTertiary
    for label in [titleLabel, detailLabel, statusLabel] { label.numberOfLines = 1 }
    registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self, UITraitPreferredContentSizeCategory.self]) { (view: ConversationTreeRow, _) in view.setNeedsLayout() }
  }
  required init?(coder: NSCoder) { fatalError() }

  func setAgent(cliType: String?, agentType: String?) {
    switch LodyAgentIcon.mark(cliType: cliType, agentType: agentType) {
    case .asset(let name): agentView.image = UIImage(named: name, in: .main, compatibleWith: traitCollection) ?? UIImage(named: name, in: .lody, compatibleWith: traitCollection)
    case .terminal: agentView.image = UIImage(systemName: "terminal")
    case .generic: agentView.image = UIImage(systemName: "sparkles")
    }
  }

  static func height(detail: Bool, traits: UITraitCollection) -> CGFloat {
    let title = LodyDesign.font(.callout, size: 16, compatibleWith: traits).lineHeight
    let footnote = LodyDesign.font(.footnote, size: 12, compatibleWith: traits).lineHeight
    return max(44, ceil(title) + (detail ? ceil(footnote) + LodySpacing.xs : 0) + LodySpacing.lg)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    titleLabel.font = LodyDesign.font(.callout, size: 16, compatibleWith: traitCollection)
    detailLabel.font = LodyDesign.font(.footnote, size: 12, compatibleWith: traitCollection)
    statusLabel.font = detailLabel.font
    let step: CGFloat = 24
    let indent = CGFloat(depth) * step + padding
    selectionBackground.isHidden = !isCurrent
    // Padded rows (the relations sheet) get a full capsule; flush receipt rows keep the small radius.
    selectionBackground.cornerConfiguration = padding > 0 ? .capsule() : .corners(radius: .fixed(6))
    selectionBackground.frame = CGRect(x: indent - padding, y: 2, width: max(0, bounds.width - indent + padding), height: max(0, bounds.height - 4))
    let trailing = bounds.width - padding
    let textX = indent + (showsAgent ? LodyIconSize.sm + LodySpacing.sm : 0)
    let titleHeight = ceil(titleLabel.font.lineHeight)
    let hasDetail = detailLabel.text?.isEmpty == false
    let contentHeight = titleHeight + (hasDetail ? ceil(detailLabel.font.lineHeight) + LodySpacing.xs : 0)
    let top = max(LodySpacing.sm, (bounds.height - contentHeight) / 2)
    let mid = top + titleHeight / 2
    let glyphWidth: CGFloat = glyph.kind == .none ? 0 : LodyIconSize.sm
    glyph.frame = CGRect(x: trailing - glyphWidth, y: mid - 8, width: glyphWidth, height: 16)
    glyph.isHidden = glyph.kind == .live
    if glyph.kind == .live {
      if working == nil {
        let grid = UIHostingConfiguration { LodyWorkingGrid(size: 16, color: LodyColor.accentDefault) }.margins(.all, 0).makeContentView()
        grid.isUserInteractionEnabled = false
        addSubview(grid)
        working = grid
      }
      working?.frame = glyph.frame
    } else {
      working?.removeFromSuperview()
      working = nil
    }
    let statusWidth = min(bounds.width * 0.27, ceil(statusLabel.sizeThatFits(bounds.size).width))
    statusLabel.frame = CGRect(x: glyph.frame.minX - (glyphWidth > 0 ? LodySpacing.xs : 0) - statusWidth, y: top, width: statusWidth, height: titleHeight)
    titleLabel.frame = CGRect(x: textX, y: top, width: max(0, statusLabel.frame.minX - LodySpacing.sm - textX), height: titleHeight)
    agentView.isHidden = !showsAgent
    agentView.frame = CGRect(x: indent, y: mid - 8, width: 16, height: 16)
    detailLabel.frame = CGRect(x: textX, y: top + titleHeight + LodySpacing.xs, width: max(0, trailing - textX), height: hasDetail ? ceil(detailLabel.font.lineHeight) : 0)
    let path = UIBezierPath()
    for level in ancestorRails {
      let x = CGFloat(level) * step + 6
      path.move(to: CGPoint(x: x, y: 0)); path.addLine(to: CGPoint(x: x, y: bounds.height))
    }
    if depth > 0 {
      let x = indent - padding - step + 6
      let fork = max(0, mid - LodySpacing.md)
      path.move(to: CGPoint(x: x, y: 0)); path.addLine(to: CGPoint(x: x, y: fork))
      path.addCurve(to: CGPoint(x: indent - padding - LodySpacing.xs, y: mid), controlPoint1: CGPoint(x: x, y: mid - LodyRadius.sm), controlPoint2: CGPoint(x: x + LodySpacing.xs, y: mid))
      if continues { path.move(to: CGPoint(x: x, y: fork)); path.addLine(to: CGPoint(x: x, y: bounds.height)) }
    }
    branch.path = path.cgPath
    branch.strokeColor = LodyUIColor.borderDefault.resolvedColor(with: traitCollection).cgColor
  }
}
