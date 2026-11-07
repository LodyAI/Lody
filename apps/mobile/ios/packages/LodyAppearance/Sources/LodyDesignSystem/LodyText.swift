// Hand-written runtime for the generated LodyTextStyles.swift. Edit freely.

import CoreText
import SwiftUI
import UIKit

/// One entry of the shared type scale. Instances are generated; see `LodyTextStyle.body` etc.
public struct LodyTextStyle: Sendable, Hashable {
    public let fontName: String
    public let size: CGFloat
    public let lineHeight: CGFloat
    public let tracking: CGFloat
    public let dynamicType: LodyDynamicType

    /// Scales with Dynamic Type. Prefer `.lodyTextStyle(_:)`, which also applies line height and tracking.
    public var font: Font { .custom(fontName, size: size, relativeTo: dynamicType.textStyle) }

    /// UIKit font scaled for the current content size category.
    public var uiFont: UIFont {
        let base = UIFont(name: fontName, size: size) ?? .systemFont(ofSize: size)
        return UIFontMetrics(forTextStyle: dynamicType.uiTextStyle).scaledFont(for: base)
    }
}

/// The iOS text style a Lody style scales with under Dynamic Type.
public enum LodyDynamicType: Sendable, Hashable {
    case largeTitle, title, title2, title3, headline, body, callout, subheadline, footnote, caption, caption2

    public var textStyle: Font.TextStyle {
        switch self {
        case .largeTitle: .largeTitle
        case .title: .title
        case .title2: .title2
        case .title3: .title3
        case .headline: .headline
        case .body: .body
        case .callout: .callout
        case .subheadline: .subheadline
        case .footnote: .footnote
        case .caption: .caption
        case .caption2: .caption2
        }
    }

    public var uiTextStyle: UIFont.TextStyle {
        switch self {
        case .largeTitle: .largeTitle
        case .title: .title1
        case .title2: .title2
        case .title3: .title3
        case .headline: .headline
        case .body: .body
        case .callout: .callout
        case .subheadline: .subheadline
        case .footnote: .footnote
        case .caption: .caption1
        case .caption2: .caption2
        }
    }
}

public extension View {
    /// Applies font, tracking and a fixed line height, matching Compose's
    /// `lineHeight` + `LineHeightStyle(Center, Trim.None)` on Android.
    func lodyTextStyle(_ style: LodyTextStyle) -> some View {
        modifier(LodyTextStyleModifier(style: style))
    }
}

private struct LodyTextStyleModifier: ViewModifier {
    let style: LodyTextStyle
    @ScaledMetric private var size: CGFloat
    @ScaledMetric private var lineHeight: CGFloat

    init(style: LodyTextStyle) {
        self.style = style
        _size = ScaledMetric(wrappedValue: style.size, relativeTo: style.dynamicType.textStyle)
        _lineHeight = ScaledMetric(wrappedValue: style.lineHeight, relativeTo: style.dynamicType.textStyle)
    }

    func body(content: Content) -> some View {
        let natural = (UIFont(name: style.fontName, size: size) ?? .systemFont(ofSize: size)).lineHeight
        let leading = max(0, lineHeight - natural)
        content
            .font(.custom(style.fontName, fixedSize: size))
            .tracking(style.tracking)
            .lineSpacing(leading)
            .padding(.vertical, leading / 2)
    }
}

public enum LodyFonts {
    private static let registration: Void = {
        for name in LodyFontFiles.all {
            // SwiftPM may keep or flatten the fonts/font directory when processing resources.
            let url = Bundle.module.url(forResource: name, withExtension: "ttf")
                ?? Bundle.module.url(forResource: name, withExtension: "ttf", subdirectory: "font")
            guard let url else {
                assertionFailure("Missing bundled font \(name).ttf")
                continue
            }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }()

    /// Registers the bundled Inter / JetBrains Mono faces. Call once at launch, before any UI.
    public static func register() { _ = registration }
}

public enum LodyAppearance {
    /// Points native navigation bars at the Lody type scale and accent while keeping the
    /// system material (Liquid Glass) untouched. Call once at launch after `LodyFonts.register()`.
    @MainActor
    public static func apply() {
        let standard = UINavigationBarAppearance()
        standard.configureWithDefaultBackground()
        let scrollEdge = UINavigationBarAppearance()
        scrollEdge.configureWithTransparentBackground()
        for appearance in [standard, scrollEdge] {
            appearance.largeTitleTextAttributes = attributes(.largeTitle)
            appearance.titleTextAttributes = attributes(.headline)
        }
        let bar = UINavigationBar.appearance()
        bar.standardAppearance = standard
        bar.compactAppearance = standard
        bar.scrollEdgeAppearance = scrollEdge
        bar.tintColor = LodyUIColor.accentDefault
    }

    private static func attributes(_ style: LodyTextStyle) -> [NSAttributedString.Key: Any] {
        [.font: style.uiFont, .kern: style.tracking, .foregroundColor: LodyUIColor.textPrimary]
    }
}
