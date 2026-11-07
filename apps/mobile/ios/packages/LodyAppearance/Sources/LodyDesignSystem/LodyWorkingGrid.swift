// Hand-written runtime component. Android counterpart: runtime/android/LodyWorkingGrid.kt.

import SwiftUI

/// The web "working" mark (`ui/working-grid.tsx`): a 3×3 grid of rounded tiles rising and
/// sinking in a diagonal wave. Geometry follows the web defaults: tile gap 0.18 and corner
/// radius 0.4 of a tile edge, scale 0.9 → 0.3, opacity 1 → 0.25. Reduce Motion holds it still.
public struct LodyWorkingGrid: View {
    public static let period: Double = 1.6
    private static let gap: CGFloat = 0.18
    private static let corner: CGFloat = 0.4
    /// Phase step per tile along the diagonal, in turns.
    private static let step: Double = 0.12

    private let size: CGFloat
    private let color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(size: CGFloat = LodyIconSize.xs, color: Color = LodyColor.accentDefault) {
        self.size = size
        self.color = color
    }

    public var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            Canvas { graphics, canvas in
                let time = context.date.timeIntervalSinceReferenceDate / Self.period
                let tile = canvas.width / (3 + 2 * Self.gap)
                for row in 0..<3 {
                    for column in 0..<3 {
                        let height = reduceMotion ? 1 : 0.5 + 0.5 * cos(2 * .pi * (time - Double(row + column) * Self.step))
                        let scale = 0.3 + 0.6 * height
                        let edge = tile * scale
                        let center = CGPoint(
                            x: CGFloat(column) * tile * (1 + Self.gap) + tile / 2,
                            y: CGFloat(row) * tile * (1 + Self.gap) + tile / 2
                        )
                        let rect = CGRect(x: center.x - edge / 2, y: center.y - edge / 2, width: edge, height: edge)
                        var layer = graphics
                        layer.opacity = 0.25 + 0.75 * height
                        layer.fill(Path(roundedRect: rect, cornerRadius: edge * Self.corner, style: .continuous), with: .color(color))
                    }
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
