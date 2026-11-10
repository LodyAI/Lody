import CoreGraphics
import Foundation

enum ChatImagePreviewGeometry {
  struct Size: Equatable {
    var width: CGFloat
    var height: CGFloat
    static let zero = Size(width: 0, height: 0)
  }

  struct Rect: Equatable {
    var x: CGFloat
    var y: CGFloat
    var width: CGFloat
    var height: CGFloat
    var size: Size { Size(width: width, height: height) }
    var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
  }

  static let inset: CGFloat = 16
  static let cornerRadius: CGFloat = 16
  static let pageGap: CGFloat = 16
  static let maxScale: CGFloat = 4
  static let doubleTapScale: CGFloat = 2.5
  static let rubberBand: CGFloat = 0.55

  static func clamp(_ value: CGFloat, min: CGFloat, max: CGFloat) -> CGFloat {
    Swift.min(Swift.max(value, min), max)
  }

  static func box(viewport: Size, safeTop: CGFloat, safeBottom: CGFloat, inset: CGFloat = inset) -> Rect {
    let vertical = Swift.max(safeTop, safeBottom) + inset
    return Rect(
      x: inset,
      y: vertical,
      width: Swift.max(viewport.width - inset * 2, 1),
      height: Swift.max(viewport.height - vertical * 2, 1)
    )
  }

  static func fitContain(_ image: Size, in box: Size) -> Rect {
    if image.width <= 0 || image.height <= 0 {
      return Rect(x: 0, y: 0, width: box.width, height: box.height)
    }
    let scale = Swift.min(box.width / image.width, box.height / image.height)
    let width = image.width * scale
    let height = image.height * scale
    return Rect(x: (box.width - width) / 2, y: (box.height - height) / 2, width: width, height: height)
  }

  static func fitWithin(_ image: Size, in box: Rect) -> Rect {
    let fitted = fitContain(image, in: box.size)
    return Rect(x: box.x + fitted.x, y: box.y + fitted.y, width: fitted.width, height: fitted.height)
  }

  static func rubberBand(_ overshoot: CGFloat, dimension: CGFloat, coefficient: CGFloat = rubberBand) -> CGFloat {
    if dimension <= 0 { return 0 }
    return (1 - 1 / ((overshoot * coefficient) / dimension + 1)) * dimension
  }

  static func rubberBandClamp(
    _ value: CGFloat, min: CGFloat, max: CGFloat, dimension: CGFloat, coefficient: CGFloat = rubberBand
  ) -> CGFloat {
    let clamped = clamp(value, min: min, max: max)
    let overshoot = abs(value - clamped)
    if overshoot == 0 { return clamped }
    let sign: CGFloat = value < clamped ? -1 : 1
    return clamped + sign * rubberBand(overshoot, dimension: dimension, coefficient: coefficient)
  }

  static func snapPage(
    offset: CGFloat, velocity: CGFloat, current: Int, count: Int, pageWidth: CGFloat
  ) -> Int {
    if count <= 1 || pageWidth <= 0 { return 0 }
    let projected = -(offset + velocity * 0.25) / pageWidth
    let target = Int(projected.rounded())
    let neighbor = clamp(CGFloat(target), min: CGFloat(current - 1), max: CGFloat(current + 1))
    return Int(clamp(neighbor, min: 0, max: CGFloat(count - 1)))
  }

  static func hits(_ point: CGPoint, rect: Rect, scale: CGFloat, translation: CGPoint) -> Bool {
    let cx = rect.x + rect.width / 2 + translation.x
    let cy = rect.y + rect.height / 2 + translation.y
    return abs(point.x - cx) <= (rect.width * scale) / 2 && abs(point.y - cy) <= (rect.height * scale) / 2
  }

  static func panBound(fitted: CGFloat, scale: CGFloat, viewport: CGFloat) -> CGFloat {
    max(0, (fitted * scale - viewport) / 2)
  }

  static func shouldPage(zoomScale: CGFloat, velocity: CGPoint, count: Int) -> Bool {
    count > 1 && zoomScale <= 1.01 && abs(velocity.x) > abs(velocity.y)
  }
}
