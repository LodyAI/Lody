// Imported from Lody Mobile; maintained as platform-owned appearance code.

import CoreGraphics

public extension LodyTextStyle {
    /// Onboarding and empty-screen hero titles.
    static let display = LodyTextStyle(weight: .bold, size: 34, lineHeight: 40, tracking: -0.74, dynamicType: .largeTitle)
    /// Root screen titles ("Sessions", "My issues").
    static let largeTitle = LodyTextStyle(weight: .bold, size: 28, lineHeight: 34, tracking: -0.59, dynamicType: .largeTitle)
    /// Detail screen headers, empty-state titles.
    static let title = LodyTextStyle(weight: .semibold, size: 22, lineHeight: 28, tracking: -0.4, dynamicType: .title2)
    /// Navigation bar titles, sheet titles, card titles.
    static let headline = LodyTextStyle(weight: .semibold, size: 17, lineHeight: 22, tracking: -0.22, dynamicType: .headline)
    /// Compact conversation navigation title.
    static let conversationTitle = LodyTextStyle(weight: .semibold, size: 16, lineHeight: 22, tracking: -0.18, dynamicType: .headline)
    /// List row titles, form values.
    static let body = LodyTextStyle(weight: .regular, size: 16, lineHeight: 22, tracking: -0.18, dynamicType: .body)
    /// Unread rows, emphasized values.
    static let bodyEmphasis = LodyTextStyle(weight: .medium, size: 16, lineHeight: 22, tracking: -0.18, dynamicType: .body)
    /// Long-form chat and markdown.
    static let reading = LodyTextStyle(weight: .regular, size: 16, lineHeight: 25, tracking: -0.18, dynamicType: .body)
    /// Composer text, dense paragraphs in cards.
    static let callout = LodyTextStyle(weight: .regular, size: 15, lineHeight: 20, tracking: -0.13, dynamicType: .callout)
    /// Descriptions under titles, settings footers.
    static let bodySmall = LodyTextStyle(weight: .regular, size: 14, lineHeight: 20, tracking: -0.09, dynamicType: .subheadline)
    /// Section headers, segmented controls, buttons.
    static let subhead = LodyTextStyle(weight: .medium, size: 14, lineHeight: 20, tracking: -0.09, dynamicType: .subheadline)
    /// Compact buttons, segmented items, form labels.
    static let label = LodyTextStyle(weight: .medium, size: 13, lineHeight: 16, tracking: -0.04, dynamicType: .footnote)
    /// Row subtitles, metadata, timestamps.
    static let footnote = LodyTextStyle(weight: .regular, size: 13, lineHeight: 18, tracking: -0.04, dynamicType: .footnote)
    /// Badges, chip labels.
    static let caption = LodyTextStyle(weight: .medium, size: 12, lineHeight: 16, tracking: 0.01, dynamicType: .caption)
    /// Tab bar labels, counters.
    static let micro = LodyTextStyle(weight: .medium, size: 11, lineHeight: 14, tracking: 0.05, dynamicType: .caption2)
    /// Code blocks.
    static let code = LodyTextStyle(weight: .regular, monospaced: true, size: 13, lineHeight: 20, tracking: 0, dynamicType: .callout)
    /// Diffs, inline code in dense rows.
    static let codeSmall = LodyTextStyle(weight: .regular, monospaced: true, size: 12, lineHeight: 18, tracking: 0, dynamicType: .footnote)

    static let all: [(name: String, style: LodyTextStyle)] = [
        ("display", .display),
        ("largeTitle", .largeTitle),
        ("title", .title),
        ("headline", .headline),
        ("conversationTitle", .conversationTitle),
        ("body", .body),
        ("bodyEmphasis", .bodyEmphasis),
        ("reading", .reading),
        ("callout", .callout),
        ("bodySmall", .bodySmall),
        ("subhead", .subhead),
        ("label", .label),
        ("footnote", .footnote),
        ("caption", .caption),
        ("micro", .micro),
        ("code", .code),
        ("codeSmall", .codeSmall),
    ]
}
