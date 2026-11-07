import MarkdownView
import UIKit

enum ChatMarkdownTheme {
  static func make(traits: UITraitCollection, secondary: Bool) -> MarkdownTheme {
    let scale = UIFont.dynamicScale(compatibleWith: traits)
    let body = UIFont.dynamic(of: secondary ? 15 : 17, compatibleWith: traits)
    var theme = MarkdownTheme()
    theme.fonts.body = body
    theme.fonts.bold = body.bold
    theme.fonts.italic = body.italic
    theme.fonts.code = .monospacedSystemFont(ofSize: 13 * scale, weight: .regular)
    theme.fonts.codeInline = .monospacedSystemFont(ofSize: (secondary ? 12 : 13) * scale, weight: .regular)
    theme.fonts.title = .dynamic(of: secondary ? 17 : 20, weight: .semibold, compatibleWith: traits)
    theme.fonts.largeTitle = .dynamic(of: 23, weight: .semibold, compatibleWith: traits)
    theme.fonts.footnote = .dynamic(of: 13, compatibleWith: traits)
    theme.colors.body = secondary ? .secondaryLabel : .label
    theme.colors.code = secondary ? .secondaryLabel : .lodyInk
    theme.colors.highlight = .systemBlue
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
