// System typography runtime for the platform-owned LodyTextStyles.swift.

import SwiftUI
import UIKit

/// One entry of the native type scale; see `LodyTextStyle.body` etc.
public struct LodyTextStyle: Sendable, Hashable {
    public let weight: LodyFontWeight
    public var monospaced: Bool = false
    public let size: CGFloat
    public let lineHeight: CGFloat
    public let tracking: CGFloat
    public let dynamicType: LodyDynamicType

    /// UIKit font scaled for the current content size category.
    public var uiFont: UIFont {
        UIFontMetrics(forTextStyle: dynamicType.uiTextStyle).scaledFont(for: baseFont(size: size))
    }

    fileprivate func baseFont(size: CGFloat) -> UIFont {
        monospaced
            ? .monospacedSystemFont(ofSize: size, weight: weight.uiWeight)
            : .systemFont(ofSize: size, weight: weight.uiWeight)
    }
}

public enum LodyFontWeight: Sendable, Hashable {
    case regular, medium, semibold, bold

    fileprivate var uiWeight: UIFont.Weight {
        switch self {
        case .regular: .regular
        case .medium: .medium
        case .semibold: .semibold
        case .bold: .bold
        }
    }

    fileprivate var swiftUIWeight: Font.Weight {
        switch self {
        case .regular: .regular
        case .medium: .medium
        case .semibold: .semibold
        case .bold: .bold
        }
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
    func lodyTextStyle(_ style: LodyTextStyle, fontOnly: Bool = false) -> some View {
        modifier(LodyTextStyleModifier(style: style, fontOnly: fontOnly))
    }
}

private struct LodyTextStyleModifier: ViewModifier {
    let style: LodyTextStyle
    let fontOnly: Bool
    @ScaledMetric private var size: CGFloat
    @ScaledMetric private var lineHeight: CGFloat

    init(style: LodyTextStyle, fontOnly: Bool) {
        self.style = style
        self.fontOnly = fontOnly
        _size = ScaledMetric(wrappedValue: style.size, relativeTo: style.dynamicType.textStyle)
        _lineHeight = ScaledMetric(wrappedValue: style.lineHeight, relativeTo: style.dynamicType.textStyle)
    }

    func body(content: Content) -> some View {
        let natural = style.baseFont(size: size).lineHeight
        let leading = fontOnly ? 0 : max(0, lineHeight - natural)
        content
            .font(.system(size: size, weight: style.weight.swiftUIWeight, design: style.monospaced ? .monospaced : .default))
            .tracking(fontOnly ? 0 : style.tracking)
            .lineSpacing(leading)
            .padding(.vertical, leading / 2)
    }
}

public enum LodyAppearance {
    /// Points native navigation bars at the Lody type scale and accent while keeping the
    /// system material (Liquid Glass) untouched. Call once at launch if adopting the navigation type scale.
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
