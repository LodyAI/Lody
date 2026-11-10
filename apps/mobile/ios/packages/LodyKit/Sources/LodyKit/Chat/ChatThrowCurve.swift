import UIKit

// Tuned in verification/kit/chat/throw-tuner.html; keep both in sync.
enum ChatThrowCurve {
  static let duration: CFTimeInterval = 0.300
  static let positionTiming: (Float, Float, Float, Float) = (0.49, 0.09, 0.41, 0.91)
  static let arcRatio: CGFloat = 0.24
  static let arcApex: CGFloat = 0.44
  static let springResponse: CFTimeInterval = 0.32
  static let springDampingRatio: CGFloat = 0.62
  static let settleVelocityCarry: CGFloat = 0.55
  static let settleKick: CGFloat = 90
  static let squash: (scale: CGFloat, at: Float) = (0.86, 0.43)
  static let landing: (scale: CGFloat, at: Float) = (1.005, 0.71)
  static let boundsSpeed: Float = 2.0
  static let sampleRate = 120.0

  struct PositionTrack {
    let points: [CGPoint]
    let times: [CFTimeInterval]
    let duration: CFTimeInterval
  }

  static var timingFunction: CAMediaTimingFunction {
    let (x1, y1, x2, y2) = positionTiming
    return CAMediaTimingFunction(controlPoints: x1, y1, x2, y2)
  }

  static func positionTrack(from source: CGPoint, to destination: CGPoint) -> PositionTrack {
    let dx = destination.x - source.x, dy = destination.y - source.y
    let length = max(hypot(dx, dy), 1)
    let normal = CGPoint(x: dy / length, y: -dx / length)
    let arc = arcRatio * length
    let control = CGPoint(x: source.x + dx * arcApex + normal.x * arc, y: source.y + dy * arcApex + normal.y * arc)
    let tangent = CGPoint(x: destination.x - control.x, y: destination.y - control.y)
    let tangentLength = max(hypot(tangent.x, tangent.y), 1)
    let unit = CGPoint(x: tangent.x / tangentLength, y: tangent.y / tangentLength)
    let (x1, y1, x2, y2) = positionTiming
    let endSlope = Double((1 - y2) / max(1 - x2, 0.02))
    let arrival = endSlope * Double(2 * tangentLength) / duration
    let velocity = arrival * settleVelocityCarry + settleKick
    let omega = 2 * Double.pi / springResponse
    let zeta = min(springDampingRatio, 0.999)
    let damped = omega * (1 - zeta * zeta).squareRoot()
    let amplitude = abs(velocity) / damped
    let tail = amplitude < 0.3 ? 0 : min(log(amplitude / 0.3) / (zeta * omega), 1.2)
    let total = duration + tail
    let count = Int((total * sampleRate).rounded(.up))
    var points: [CGPoint] = []
    var times: [CFTimeInterval] = []
    for index in 0...count {
      let t = min(Double(index) / sampleRate, total)
      if t <= duration {
        points.append(quad(source, control, destination, CGFloat(cubicBezier(x1, y1, x2, y2, at: t / duration))))
      } else {
        let tau = t - duration
        let offset = CGFloat(velocity / damped * exp(-zeta * omega * tau) * sin(damped * tau))
        points.append(CGPoint(x: destination.x + unit.x * offset, y: destination.y + unit.y * offset))
      }
      times.append(t)
    }
    points[points.count - 1] = destination
    return PositionTrack(points: points, times: times, duration: total)
  }

  /// Steered queue messages travel straight: same easing and duration, no arc, squash or settle.
  static func straightTrack(from source: CGPoint, to destination: CGPoint) -> PositionTrack {
    let (x1, y1, x2, y2) = positionTiming
    let count = Int((duration * sampleRate).rounded(.up))
    var points: [CGPoint] = []
    var times: [CFTimeInterval] = []
    for index in 0...count {
      let t = min(Double(index) / sampleRate, duration)
      let progress = CGFloat(cubicBezier(x1, y1, x2, y2, at: t / duration))
      points.append(CGPoint(x: source.x + (destination.x - source.x) * progress,
                            y: source.y + (destination.y - source.y) * progress))
      times.append(t)
    }
    points[points.count - 1] = destination
    return PositionTrack(points: points, times: times, duration: duration)
  }

  static func positionAnimation(_ track: PositionTrack) -> CAKeyframeAnimation {
    let position = CAKeyframeAnimation(keyPath: "position")
    position.values = track.points.map { NSValue(cgPoint: $0) }
    position.keyTimes = track.times.map { NSNumber(value: $0 / track.duration) }
    position.calculationMode = .linear
    position.duration = track.duration
    return position
  }

  static func scaleAnimation() -> CAKeyframeAnimation {
    let scale = CAKeyframeAnimation(keyPath: "transform.scale")
    scale.values = [Float(1), Float(squash.scale), Float(landing.scale), 1]
    scale.keyTimes = [0, NSNumber(value: squash.at), NSNumber(value: landing.at), 1]
    scale.timingFunctions = [
      CAMediaTimingFunction(controlPoints: 0.66, 0, 1, 1),
      CAMediaTimingFunction(controlPoints: 0, 0, 0.62268293, 0.92987806),
      CAMediaTimingFunction(controlPoints: 0.45, 0, 0.55, 1),
    ]
    scale.duration = duration
    return scale
  }

  private static func cubicBezier(_ x1: Float, _ y1: Float, _ x2: Float, _ y2: Float, at x: Double) -> Double {
    if x <= 0 { return 0 }
    if x >= 1 { return 1 }
    func curve(_ a: Float, _ b: Float, _ t: Double) -> Double {
      3 * Double(a) * (1 - t) * (1 - t) * t + 3 * Double(b) * (1 - t) * t * t + t * t * t
    }
    var low = 0.0, high = 1.0, t = x
    for _ in 0..<24 {
      let value = curve(x1, x2, t)
      if abs(value - x) < 1e-5 { break }
      if value < x { low = t } else { high = t }
      t = (low + high) / 2
    }
    return curve(y1, y2, t)
  }

  private static func quad(_ a: CGPoint, _ control: CGPoint, _ b: CGPoint, _ p: CGFloat) -> CGPoint {
    let q = 1 - p
    return CGPoint(x: q * q * a.x + 2 * q * p * control.x + p * p * b.x,
                   y: q * q * a.y + 2 * q * p * control.y + p * p * b.y)
  }
}
