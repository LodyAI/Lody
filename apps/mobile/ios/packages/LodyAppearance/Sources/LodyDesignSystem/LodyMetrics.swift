// Imported from Lody Mobile; maintained as platform-owned appearance code.

import SwiftUI

public enum LodySpacing {
    public static let none: CGFloat = 0
    public static let xxs: CGFloat = 2
    public static let xs: CGFloat = 4
    public static let sm: CGFloat = 8
    public static let md: CGFloat = 12
    public static let lg: CGFloat = 16
    public static let xl: CGFloat = 20
    public static let xxl: CGFloat = 24
    public static let xxxl: CGFloat = 32
    public static let huge: CGFloat = 48

    public static let all: [(name: String, value: CGFloat)] = [
        ("none", none),
        ("xxs", xxs),
        ("xs", xs),
        ("sm", sm),
        ("md", md),
        ("lg", lg),
        ("xl", xl),
        ("xxl", xxl),
        ("xxxl", xxxl),
        ("huge", huge),
    ]
}

public enum LodyRadius {
    public static let none: CGFloat = 0
    /// Inline code, small badges, checkboxes.
    public static let xs: CGFloat = 4
    /// Chips, labels, segmented items.
    public static let sm: CGFloat = 6
    /// Buttons, text fields, code blocks, menus.
    public static let md: CGFloat = 8
    /// Cards, grouped list sections.
    public static let lg: CGFloat = 12
    /// Composer, custom sheets.
    public static let xl: CGFloat = 18
    /// Pills, avatars, dots. Use the platform capsule / circle shape.
    public static let full: CGFloat = 9999

    public static let all: [(name: String, value: CGFloat)] = [
        ("none", none),
        ("xs", xs),
        ("sm", sm),
        ("md", md),
        ("lg", lg),
        ("xl", xl),
        ("full", full),
    ]
}

public enum LodyIconSize {
    public static let xs: CGFloat = 12
    /// Inline with footnote / caption text, in chips and small buttons.
    public static let sm: CGFloat = 16
    /// Default: list rows, toolbars.
    public static let md: CGFloat = 20
    /// Tab bar, prominent actions.
    public static let lg: CGFloat = 24
    /// Empty states.
    public static let xl: CGFloat = 28

    public static let all: [(name: String, value: CGFloat)] = [
        ("xs", xs),
        ("sm", sm),
        ("md", md),
        ("lg", lg),
        ("xl", xl),
    ]
}

public enum LodyStroke {
    /// Outlines. List separators use the platform hairline instead.
    public static let `default`: CGFloat = 1
    /// Selected outlines, checkbox rings.
    public static let strong: CGFloat = 1.5
    public static let focus: CGFloat = 2
    /// Icon stroke on the 24pt grid; baked into generated icons.
    public static let icon: CGFloat = 1.75

    public static let all: [(name: String, value: CGFloat)] = [
        ("default", `default`),
        ("strong", strong),
        ("focus", focus),
        ("icon", icon),
    ]
}

public enum LodySize {
    /// Minimum hit area. Android Material reserves 48dp; keep 44 visually and let Compose pad the hit area.
    public static let touchTarget: CGFloat = 44
    /// Inline icon buttons inside rows.
    public static let controlXs: CGFloat = 24
    /// Compact buttons, the composer send button.
    public static let controlSm: CGFloat = 32
    /// Default buttons and text fields.
    public static let controlMd: CGFloat = 40
    /// Full-width primary actions.
    public static let controlLg: CGFloat = 48
    /// Filter chips.
    public static let chip: CGFloat = 28
    /// Labels and status badges.
    public static let chipSm: CGFloat = 22
    /// Unread / count badge height (min width).
    public static let badge: CGFloat = 18
    /// Unread and presence dots.
    public static let dot: CGFloat = 8
    /// Linear progress track height.
    public static let progress: CGFloat = 4
    /// Single-line row minimum height.
    public static let listRow: CGFloat = 44
    /// Title + subtitle row minimum height.
    public static let listRowTwoLine: CGFloat = 60
    public static let sectionHeader: CGFloat = 36
    public static let avatarXs: CGFloat = 16
    public static let avatarSm: CGFloat = 20
    public static let avatarMd: CGFloat = 28
    public static let avatarLg: CGFloat = 40
    public static let avatarXl: CGFloat = 56
    public static let composerMin: CGFloat = 48

    public static let all: [(name: String, value: CGFloat)] = [
        ("touchTarget", touchTarget),
        ("controlXs", controlXs),
        ("controlSm", controlSm),
        ("controlMd", controlMd),
        ("controlLg", controlLg),
        ("chip", chip),
        ("chipSm", chipSm),
        ("badge", badge),
        ("dot", dot),
        ("progress", progress),
        ("listRow", listRow),
        ("listRowTwoLine", listRowTwoLine),
        ("sectionHeader", sectionHeader),
        ("avatarXs", avatarXs),
        ("avatarSm", avatarSm),
        ("avatarMd", avatarMd),
        ("avatarLg", avatarLg),
        ("avatarXl", avatarXl),
        ("composerMin", composerMin),
    ]
}

public enum LodyLayout {
    /// Horizontal content inset on phones.
    public static let screenPaddingX: CGFloat = 16
    /// Horizontal inset of the Chats and Schedules lists: a little wider than `screenPaddingX` so titles and status marks breathe.
    public static let listEdgeX: CGFloat = 20
    public static let listRowPaddingX: CGFloat = 16
    public static let listRowPaddingY: CGFloat = 10
    /// Leading icon to title.
    public static let listRowGap: CGFloat = 12
    /// Leading inset of rows nested under a group header, so their text aligns with the header title (screenPaddingX + iconSize.md + listRowGap). The gutter holds status glyphs.
    public static let childIndent: CGFloat = 48
    /// Between grouped sections / cards.
    public static let sectionGap: CGFloat = 24
    /// Max width of trailing metadata in a row (e.g. a chat's project name); the title keeps the rest.
    public static let trailingMetaMaxWidth: CGFloat = 128
    /// Between controls inside a card.
    public static let stackGap: CGFloat = 12
    /// Max text column width on tablets / foldables.
    public static let readableMaxWidth: CGFloat = 680

    public static let all: [(name: String, value: CGFloat)] = [
        ("screenPaddingX", screenPaddingX),
        ("listEdgeX", listEdgeX),
        ("listRowPaddingX", listRowPaddingX),
        ("listRowPaddingY", listRowPaddingY),
        ("listRowGap", listRowGap),
        ("childIndent", childIndent),
        ("sectionGap", sectionGap),
        ("trailingMetaMaxWidth", trailingMetaMaxWidth),
        ("stackGap", stackGap),
        ("readableMaxWidth", readableMaxWidth),
    ]
}

public enum LodyBreakpoint {
    /// Two-pane layouts become possible (foldables, iPad split view).
    public static let medium: CGFloat = 600
    /// Persistent sidebar.
    public static let expanded: CGFloat = 840

    public static let all: [(name: String, value: CGFloat)] = [
        ("medium", medium),
        ("expanded", expanded),
    ]
}

public enum LodyOpacity {
    /// Icon-only buttons while pressed (iOS).
    public static let pressed: Double = 0.7
    /// De-emphasized media, archived rows.
    public static let muted: Double = 0.6
}

public enum LodyMotion {
    /// Color / opacity feedback.
    public static let instant: TimeInterval = 0.08
    /// Press feedback, toggles.
    public static let fast: TimeInterval = 0.12
    /// Expand / collapse, fades.
    public static let base: TimeInterval = 0.2
    /// Large content changes.
    public static let slow: TimeInterval = 0.32
    /// Full-screen transitions of custom views.
    public static let slower: TimeInterval = 0.48

    public static func standard(duration: TimeInterval = LodyMotion.base) -> Animation {
        .timingCurve(0.2, 0, 0, 1, duration: duration)
    }

    public static func emphasized(duration: TimeInterval = LodyMotion.base) -> Animation {
        .timingCurve(0.3, 0, 0, 1, duration: duration)
    }

    public static func decelerate(duration: TimeInterval = LodyMotion.base) -> Animation {
        .timingCurve(0, 0, 0, 1, duration: duration)
    }

    public static func accelerate(duration: TimeInterval = LodyMotion.base) -> Animation {
        .timingCurve(0.3, 0, 1, 1, duration: duration)
    }
}

/// Springs in SwiftUI's duration / bounce terms; Android uses the equivalent stiffness and damping.
public enum LodySpring {
    /// Default for interactive movement.
    public static var smooth: Animation { .spring(duration: 0.4, bounce: 0) }
    /// Small controls, selection changes.
    public static var snappy: Animation { .spring(duration: 0.3, bounce: 0.12) }
    /// Playful confirmations. Use sparingly.
    public static var bouncy: Animation { .spring(duration: 0.5, bounce: 0.3) }
}
