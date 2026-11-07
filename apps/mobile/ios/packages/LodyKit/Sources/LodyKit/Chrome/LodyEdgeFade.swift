import UIKit

final class LodyEdgeFade: UIView {
  enum Edge { case top, bottom }

  static let overlap: CGFloat = 20
  static let topExtent: CGFloat = 34
  static let opacity: CGFloat = 0.85
  static let bottomMask = mask(fadeHeight: 60, solidEdge: .bottom)
  static let topMask = mask(fadeHeight: 80, solidEdge: .top)

  private static func mask(fadeHeight: CGFloat, solidEdge: Edge) -> UIImage {
    let steps = 24
    let colors = (0...steps).map { step -> CGColor in
      let progress = CGFloat(step) / CGFloat(steps)
      return UIColor(white: 0, alpha: (1 - cos(.pi * progress)) / 2).cgColor
    }
    let gradient = CGGradient(colorsSpace: nil, colors: colors as CFArray, locations: nil)!
    let size = CGSize(width: 1, height: fadeHeight + 1)
    let image = UIGraphicsImageRenderer(size: size).image { context in
      UIColor.black.setFill()
      if solidEdge == .bottom {
        context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: fadeHeight), options: [])
        context.fill(CGRect(x: 0, y: fadeHeight, width: 1, height: 1))
      } else {
        context.cgContext.drawLinearGradient(gradient, start: CGPoint(x: 0, y: size.height), end: CGPoint(x: 0, y: 1), options: [])
        context.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
      }
    }
    let caps = solidEdge == .bottom
      ? UIEdgeInsets(top: fadeHeight, left: 0, bottom: 0, right: 0)
      : UIEdgeInsets(top: 0, left: 0, bottom: fadeHeight, right: 0)
    return image.resizableImage(withCapInsets: caps, resizingMode: .stretch)
  }

  var color: UIColor = .lodyBackground { didSet { fill.backgroundColor = color } }
  private let fill = UIView()
  private let fillMask: UIImageView

  init(edge: Edge = .bottom) {
    fillMask = UIImageView(image: edge == .bottom ? Self.bottomMask : Self.topMask)
    super.init(frame: .zero)
    isUserInteractionEnabled = false
    fill.alpha = Self.opacity
    fill.mask = fillMask
    fill.backgroundColor = color
    addSubview(fill)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    fill.frame = bounds
    fillMask.frame = bounds
  }
}
