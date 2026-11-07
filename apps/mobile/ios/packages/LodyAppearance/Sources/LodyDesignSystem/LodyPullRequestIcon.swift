import SwiftUI

/// Native port of Web SessionPrIcon / MaskedPrCiIcon (sidebar-row-shared.tsx).
/// Lucide base: 14/16, stroke 2.25. Verdict: 10/16, stroke 3, transparent cutout.
public struct LodyPullRequestIcon: View {
  public let status: String
  public let ci: String?
  public var size: CGFloat

  public init(status: String, ci: String? = nil, size: CGFloat = LodyIconSize.sm) {
    self.status = status
    self.ci = ci
    self.size = size
  }

  private var verdict: String {
    switch ci {
    case "s", "pass": "pass"
    case "f", "e", "fail": "fail"
    case "p", "pending": "pending"
    case "x", "expected": "expected"
    default: ""
    }
  }

  private var icon: LodyIcon {
    switch status {
    case "merged": .merge
    case "closed": .pullRequestClosed
    case "draft": .pullRequestDraft
    default: .pullRequest
    }
  }

  private var color: Color {
    switch status {
    case "merged": LodyColor.prMerged
    case "closed": LodyColor.prClosed
    case "draft": LodyColor.prDraft
    default: LodyColor.prOpen
    }
  }

  public var body: some View {
    let unit = size / 16
    ZStack(alignment: .topLeading) {
      icon.image.resizable().renderingMode(.template)
        .foregroundStyle(color).frame(width: 14 * unit, height: 14 * unit)
        .frame(width: size, height: size, alignment: .topLeading)
        .mask {
          Rectangle().overlay(alignment: .topLeading) {
            if !verdict.isEmpty {
              let radius = (verdict == "pending" ? 3.75 : 5) * unit
              Circle().frame(width: radius * 2, height: radius * 2)
                .offset(x: 12 * unit - radius, y: 12 * unit - radius)
                .blendMode(.destinationOut)
            }
          }.compositingGroup()
        }
      Canvas { context, _ in
        let center = CGPoint(x: 12 * unit, y: 12 * unit)
        func circle(_ radius: CGFloat) -> Path {
          Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
        }
        let stroke = StrokeStyle(lineWidth: 3 * 10 / 24 * unit, lineCap: .round, lineJoin: .round)
        switch verdict {
        case "pending": context.fill(circle(2.5 * unit), with: .color(LodyColor.warningDefault))
        case "expected":
          context.stroke(circle(10 * 10 / 24 * unit), with: .color(LodyColor.warningDefault), style: stroke)
          context.stroke(circle(10 / 24 * unit), with: .color(LodyColor.warningDefault), style: stroke)
        case "pass", "fail":
          func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: (7 + x * 10 / 24) * unit, y: (7 + y * 10 / 24) * unit)
          }
          var path = Path()
          if verdict == "pass" {
            path.move(to: point(20, 6)); path.addLine(to: point(9, 17)); path.addLine(to: point(4, 12))
          } else {
            path.move(to: point(18, 6)); path.addLine(to: point(6, 18))
            path.move(to: point(6, 6)); path.addLine(to: point(18, 18))
          }
          context.stroke(path, with: .color(verdict == "pass" ? LodyColor.successDefault : LodyColor.dangerDefault), style: stroke)
        default: break
        }
      }
      // The verdict slot reaches past the 16-unit layout box. Preserve its round edge.
      .frame(width: 18 * unit, height: 18 * unit)
      .frame(width: size, height: size, alignment: .topLeading)
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}
