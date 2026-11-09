import MarkdownView
import UIKit

enum ChatMarkdownTheme {
  static func make(traits: UITraitCollection, secondary: Bool) -> MarkdownTheme {
    let scale = UIFont.dynamicScale(compatibleWith: traits)
    let body = UIFont.dynamic(of: secondary ? 15 : 16, compatibleWith: traits)
    var theme = MarkdownTheme()
    theme.fonts.body = body
    theme.fonts.bold = body.bold
    theme.fonts.italic = body.italic
    theme.fonts.code = .monospacedSystemFont(ofSize: 13 * scale, weight: .regular)
    theme.fonts.codeInline = .monospacedSystemFont(ofSize: body.pointSize, weight: .regular)
    theme.fonts.title = .dynamic(of: secondary ? 17 : 18, weight: .semibold, compatibleWith: traits)
    theme.fonts.largeTitle = .dynamic(of: 23, weight: .semibold, compatibleWith: traits)
    theme.fonts.footnote = .dynamic(of: 13, compatibleWith: traits)
    theme.colors.body = secondary ? .secondaryLabel : .label
    theme.colors.code = secondary ? .secondaryLabel : .lodyInk
    // Web markdown links: hsl(200 72% 34%) / hsl(200 69% 70%).
    theme.colors.highlight = UIColor { traits in
      if traits.userInterfaceStyle == .dark {
        return UIColor(red: 0.493, green: 0.769, blue: 0.907, alpha: 1)
      }
      return UIColor(red: 0.0952, green: 0.4216, blue: 0.5848, alpha: 1)
    }
    theme.colors.emphasis = .lodyAccent
    theme.colors.codeBackground = .lodyInset
    theme.colors.codeBlockBackground = .lodyInset
    theme.colors.codeBlockBarBackground = .clear
    theme.colors.selectionBackground = nil
    theme.spacings.paragraph = 8
    theme.spacings.headingBefore = 12
    theme.spacings.final = 0
    return theme
  }
}
