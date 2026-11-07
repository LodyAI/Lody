// Imported from Lody Mobile; maintained as platform-owned appearance code.

import SwiftUI

/// Shadow for custom floating surfaces. Apply with `.lodyElevation(_:)`.
public struct LodyElevation: Sendable {
    public let color: Color
    /// Figma / CSS blur; SwiftUI's shadow radius is half of it.
    public let blur: CGFloat
    public let y: CGFloat
}

public extension LodyElevation {
    /// Floating chips, the composer when content scrolls under it.
    static let sm = LodyElevation(color: LodyColor.shadowSm, blur: 3, y: 1)
    /// Menus, popovers, toasts.
    static let md = LodyElevation(color: LodyColor.shadowMd, blur: 16, y: 4)
    /// Custom sheets and dialogs.
    static let lg = LodyElevation(color: LodyColor.shadowLg, blur: 32, y: 12)
}
