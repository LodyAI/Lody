// Hand-written runtime for the generated LodyElevation.swift. Edit freely.

import SwiftUI

public extension View {
    /// Drop shadow for custom floating surfaces (menus, toasts). Content stays flat.
    func lodyElevation(_ elevation: LodyElevation) -> some View {
        // SwiftUI's radius is roughly half the Figma / CSS blur.
        shadow(color: elevation.color, radius: elevation.blur / 2, x: 0, y: elevation.y)
    }
}
