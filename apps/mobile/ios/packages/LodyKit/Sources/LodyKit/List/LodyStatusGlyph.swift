import UIKit

enum LodyStatusGlyph {
  enum Kind { case attention, live, unread, failed, done, project, none }

  static func kind(for row: LodyListRow) -> Kind {
    if row.parent { return .project }
    switch row.imageTint {
    case "warning": return .attention
    case "danger": return .failed
    case "blue": return .live
    default: return row.unread ? .unread : .done
    }
  }
}

final class LodyStatusGlyphView: UIView {
  private static let spinKey = "lody.spin"
  private let base = CAShapeLayer()
  private let arc = CAShapeLayer()

  var kind: LodyStatusGlyph.Kind {
    didSet {
      guard kind != oldValue else { return }
      setNeedsLayout()
      refreshSpin()
    }
  }

  init(kind: LodyStatusGlyph.Kind) {
    self.kind = kind
    super.init(frame: .zero)
    isAccessibilityElement = false
    isUserInteractionEnabled = false
    for shape in [base, arc] {
      shape.lineCap = .round
      shape.lineJoin = .round
      layer.addSublayer(shape)
    }
    registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self]) { (view: Self, _) in
      view.setNeedsLayout()
    }
    NotificationCenter.default.addObserver(
      self, selector: #selector(reduceMotionChanged), name: UIAccessibility.reduceMotionStatusDidChangeNotification, object: nil
    )
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { nil }

  override var intrinsicContentSize: CGSize { CGSize(width: LodyDesign.Rail.glyph, height: LodyDesign.Rail.glyph) }

  static func rotates(kind: LodyStatusGlyph.Kind, reduceMotion: Bool, inWindow: Bool) -> Bool {
    kind == .live && !reduceMotion && inWindow
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    refreshSpin()
  }

  @objc private func reduceMotionChanged() { refreshSpin() }

  private func refreshSpin() {
    let spins = Self.rotates(kind: kind, reduceMotion: UIAccessibility.isReduceMotionEnabled, inWindow: window != nil)
    guard spins != (arc.animation(forKey: Self.spinKey) != nil) else { return }
    guard spins else {
      arc.removeAnimation(forKey: Self.spinKey)
      return
    }
    let spin = CABasicAnimation(keyPath: "transform.rotation.z")
    spin.fromValue = 0
    spin.toValue = CGFloat.pi * 2
    spin.duration = 1.6
    spin.repeatCount = .infinity
    spin.isRemovedOnCompletion = false
    arc.add(spin, forKey: Self.spinKey)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let scale = min(bounds.width, bounds.height) / LodyDesign.Rail.glyph
    let center = CGPoint(x: bounds.midX, y: bounds.midY)
    base.frame = bounds
    arc.frame = bounds
    base.fillRule = .nonZero
    arc.isHidden = true
    func color(_ value: UIColor) -> CGColor { value.resolvedColor(with: traitCollection).cgColor }
    func circle(_ radius: CGFloat) -> UIBezierPath {
      UIBezierPath(arcCenter: center, radius: radius * scale, startAngle: 0, endAngle: .pi * 2, clockwise: true)
    }
    func stroke(_ path: UIBezierPath, _ tint: UIColor, width: CGFloat) {
      base.path = path.cgPath
      base.fillColor = nil
      base.strokeColor = color(tint)
      base.lineWidth = width * scale
    }
    switch kind {
    case .attention:
      let path = circle(7)
      path.append(UIBezierPath(
        roundedRect: CGRect(x: center.x - 0.85 * scale, y: center.y - 4.2 * scale, width: 1.7 * scale, height: 5.2 * scale),
        cornerRadius: 0.85 * scale
      ))
      path.append(UIBezierPath(ovalIn: CGRect(x: center.x - scale, y: center.y + 2.6 * scale, width: 2 * scale, height: 2 * scale)))
      base.path = path.cgPath
      base.fillRule = .evenOdd
      base.fillColor = color(.lodyAttention)
      base.strokeColor = nil
    case .live:
      stroke(circle(6), .lodyLine2, width: 2)
      arc.isHidden = false
      arc.path = UIBezierPath(arcCenter: center, radius: 6 * scale, startAngle: -.pi / 2, endAngle: 0, clockwise: true).cgPath
      arc.fillColor = nil
      arc.strokeColor = color(.lodySecondary)
      arc.lineWidth = 2 * scale
    case .unread:
      base.path = circle(4.5).cgPath
      base.fillColor = color(.lodyInk)
      base.strokeColor = nil
    case .failed:
      let path = circle(6)
      path.move(to: CGPoint(x: center.x - 2 * scale, y: center.y - 2 * scale))
      path.addLine(to: CGPoint(x: center.x + 2 * scale, y: center.y + 2 * scale))
      path.move(to: CGPoint(x: center.x + 2 * scale, y: center.y - 2 * scale))
      path.addLine(to: CGPoint(x: center.x - 2 * scale, y: center.y + 2 * scale))
      stroke(path, .lodyFailure, width: 1.8)
    case .done:
      let path = circle(6)
      path.move(to: CGPoint(x: center.x - 2.4 * scale, y: center.y + 0.2 * scale))
      path.addLine(to: CGPoint(x: center.x - 0.7 * scale, y: center.y + 1.9 * scale))
      path.addLine(to: CGPoint(x: center.x + 2.5 * scale, y: center.y - 1.5 * scale))
      stroke(path, .lodyTertiary, width: 1.6)
    case .project:
      let folder = UIBezierPath()
      let origin = CGPoint(x: center.x - 7 * scale, y: center.y - 7 * scale)
      func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: origin.x + x * scale, y: origin.y + y * scale) }
      folder.move(to: point(1.5, 3.6))
      folder.addLine(to: point(5.4, 3.6))
      folder.addLine(to: point(6.8, 5))
      folder.addLine(to: point(12.5, 5))
      folder.addLine(to: point(12.5, 11.4))
      folder.addLine(to: point(1.5, 11.4))
      folder.close()
      stroke(folder, .lodySecondary, width: 1.4)
    case .none:
      base.path = nil
    }
  }
}
