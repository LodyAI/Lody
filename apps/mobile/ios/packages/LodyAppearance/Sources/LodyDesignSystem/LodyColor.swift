// Imported from Lody Mobile; maintained as platform-owned appearance code.

import SwiftUI
import UIKit

/// Semantic colors. Every value follows the trait collection's light / dark style.
public enum LodyColor {
    /// Screen background for plain lists and content (white / soft dark).
    public static let bgBase = Color(uiColor: LodyUIColor.bgBase)
    /// Behind grouped lists and cards (grouped light / soft dark).
    public static let bgGrouped = Color(uiColor: LodyUIColor.bgGrouped)
    /// Cards and cells on bg.grouped, sheets, the composer (iOS secondarySystemGroupedBackground).
    public static let bgRaised = Color(uiColor: LodyUIColor.bgRaised)
    /// Text fields and search bars: a flat translucent fill (iOS search field), no inset.
    public static let bgSunken = Color(uiColor: LodyUIColor.bgSunken)
    /// Custom menus, popovers and toasts; pair with an elevation.
    public static let bgOverlay = Color(uiColor: LodyUIColor.bgOverlay)
    /// Snackbars and tooltips; text uses text.inverse.
    public static let bgInverse = Color(uiColor: LodyUIColor.bgInverse)
    /// Row / cell highlight while pressed on iOS. Android uses the platform ripple instead.
    public static let fillPressed = Color(uiColor: LodyUIColor.fillPressed)
    /// Persistently selected row, chip or segment. Translucent.
    public static let fillSelected = Color(uiColor: LodyUIColor.fillSelected)
    /// Secondary buttons and neutral chips. Translucent like iOS tertiarySystemFill, so it reads on every surface.
    public static let fillSecondary = Color(uiColor: LodyUIColor.fillSecondary)
    /// Skeletons, avatar placeholders. Translucent.
    public static let fillTertiary = Color(uiColor: LodyUIColor.fillTertiary)
    /// Container of a disabled filled control (M3: on-surface 12%).
    public static let fillDisabled = Color(uiColor: LodyUIColor.fillDisabled)
    /// Titles and body copy (iOS label).
    public static let textPrimary = Color(uiColor: LodyUIColor.textPrimary)
    /// Supporting copy, metadata (iOS secondaryLabel).
    public static let textSecondary = Color(uiColor: LodyUIColor.textSecondary)
    /// Section headers, timestamps. Short text only (iOS tertiaryLabel).
    public static let textTertiary = Color(uiColor: LodyUIColor.textTertiary)
    /// Field placeholders (iOS placeholderText).
    public static let textPlaceholder = Color(uiColor: LodyUIColor.textPlaceholder)
    /// Text and icons of disabled controls (M3: on-surface 38%).
    public static let textDisabled = Color(uiColor: LodyUIColor.textDisabled)
    /// Text on bg.inverse.
    public static let textInverse = Color(uiColor: LodyUIColor.textInverse)
    /// Text and icons on accent.solid.
    public static let textOnAccent = Color(uiColor: LodyUIColor.textOnAccent)
    /// Text and icons on danger.solid.
    public static let textOnDanger = Color(uiColor: LodyUIColor.textOnDanger)
    public static let textLink = Color(uiColor: LodyUIColor.textLink)
    public static let iconPrimary = Color(uiColor: LodyUIColor.iconPrimary)
    public static let iconSecondary = Color(uiColor: LodyUIColor.iconSecondary)
    /// Decorative only, e.g. the section header plus.
    public static let iconTertiary = Color(uiColor: LodyUIColor.iconTertiary)
    public static let iconDisabled = Color(uiColor: LodyUIColor.iconDisabled)
    /// Hairline list separators, drawn at one physical pixel (iOS separator).
    public static let borderSubtle = Color(uiColor: LodyUIColor.borderSubtle)
    /// 1pt outlines: filter chips, cards that need an edge.
    public static let borderDefault = Color(uiColor: LodyUIColor.borderDefault)
    /// Checkbox rings, emphasized outlines.
    public static let borderStrong = Color(uiColor: LodyUIColor.borderStrong)
    /// Focus ring for hardware keyboards.
    public static let borderFocus = Color(uiColor: LodyUIColor.borderFocus)
    /// Tint: switches, checkmarks, progress, selection, toolbar actions, running state.
    public static let accentDefault = Color(uiColor: LodyUIColor.accentDefault)
    /// Filled primary buttons and the send button, with text.onAccent.
    public static let accentSolid = Color(uiColor: LodyUIColor.accentSolid)
    /// accent.solid while pressed (iOS).
    public static let accentPressed = Color(uiColor: LodyUIColor.accentPressed)
    /// Accent as readable foreground: selected tab label, accent text.
    public static let accentFg = Color(uiColor: LodyUIColor.accentFg)
    /// Tinted background for accent chips and banners (M3 primary container).
    public static let accentSubtle = Color(uiColor: LodyUIColor.accentSubtle)
    public static let accentOnSubtle = Color(uiColor: LodyUIColor.accentOnSubtle)
    /// Destructive icons and text, e.g. a destructive menu item.
    public static let dangerDefault = Color(uiColor: LodyUIColor.dangerDefault)
    /// Filled destructive buttons, with text.onDanger.
    public static let dangerSolid = Color(uiColor: LodyUIColor.dangerSolid)
    public static let dangerSubtle = Color(uiColor: LodyUIColor.dangerSubtle)
    public static let dangerOnSubtle = Color(uiColor: LodyUIColor.dangerOnSubtle)
    /// Icons and badges. The light brand orange is under 3:1 on white, so light uses the text step.
    public static let warningDefault = Color(uiColor: LodyUIColor.warningDefault)
    public static let warningSubtle = Color(uiColor: LodyUIColor.warningSubtle)
    public static let warningOnSubtle = Color(uiColor: LodyUIColor.warningOnSubtle)
    public static let successDefault = Color(uiColor: LodyUIColor.successDefault)
    public static let successSubtle = Color(uiColor: LodyUIColor.successSubtle)
    public static let successOnSubtle = Color(uiColor: LodyUIColor.successOnSubtle)
    public static let infoDefault = Color(uiColor: LodyUIColor.infoDefault)
    public static let infoSubtle = Color(uiColor: LodyUIColor.infoSubtle)
    public static let infoOnSubtle = Color(uiColor: LodyUIColor.infoOnSubtle)
    /// Backlog / not started / archived.
    public static let stateIdle = Color(uiColor: LodyUIColor.stateIdle)
    /// Agent working.
    public static let stateRunning = Color(uiColor: LodyUIColor.stateRunning)
    /// Needs user input or approval.
    public static let stateWaiting = Color(uiColor: LodyUIColor.stateWaiting)
    public static let stateDone = Color(uiColor: LodyUIColor.stateDone)
    public static let stateFailed = Color(uiColor: LodyUIColor.stateFailed)
    /// Pull request merged.
    public static let stateMerged = Color(uiColor: LodyUIColor.stateMerged)
    public static let prOpen = Color(uiColor: LodyUIColor.prOpen)
    public static let prMerged = Color(uiColor: LodyUIColor.prMerged)
    public static let prClosed = Color(uiColor: LodyUIColor.prClosed)
    public static let prDraft = Color(uiColor: LodyUIColor.prDraft)
    public static let labelGrayFg = Color(uiColor: LodyUIColor.labelGrayFg)
    public static let labelGrayBg = Color(uiColor: LodyUIColor.labelGrayBg)
    public static let labelRedFg = Color(uiColor: LodyUIColor.labelRedFg)
    public static let labelRedBg = Color(uiColor: LodyUIColor.labelRedBg)
    public static let labelOrangeFg = Color(uiColor: LodyUIColor.labelOrangeFg)
    public static let labelOrangeBg = Color(uiColor: LodyUIColor.labelOrangeBg)
    public static let labelYellowFg = Color(uiColor: LodyUIColor.labelYellowFg)
    public static let labelYellowBg = Color(uiColor: LodyUIColor.labelYellowBg)
    public static let labelGreenFg = Color(uiColor: LodyUIColor.labelGreenFg)
    public static let labelGreenBg = Color(uiColor: LodyUIColor.labelGreenBg)
    public static let labelTealFg = Color(uiColor: LodyUIColor.labelTealFg)
    public static let labelTealBg = Color(uiColor: LodyUIColor.labelTealBg)
    public static let labelBlueFg = Color(uiColor: LodyUIColor.labelBlueFg)
    public static let labelBlueBg = Color(uiColor: LodyUIColor.labelBlueBg)
    public static let labelIndigoFg = Color(uiColor: LodyUIColor.labelIndigoFg)
    public static let labelIndigoBg = Color(uiColor: LodyUIColor.labelIndigoBg)
    public static let labelPurpleFg = Color(uiColor: LodyUIColor.labelPurpleFg)
    public static let labelPurpleBg = Color(uiColor: LodyUIColor.labelPurpleBg)
    public static let labelPinkFg = Color(uiColor: LodyUIColor.labelPinkFg)
    public static let labelPinkBg = Color(uiColor: LodyUIColor.labelPinkBg)
    /// Code blocks and diffs. Translucent so a block reads on lists and cards alike.
    public static let codeBg = Color(uiColor: LodyUIColor.codeBg)
    /// Inline `code` spans inside prose.
    public static let codeInlineBg = Color(uiColor: LodyUIColor.codeInlineBg)
    public static let codeText = Color(uiColor: LodyUIColor.codeText)
    public static let codeBorder = Color(uiColor: LodyUIColor.codeBorder)
    /// Line numbers.
    public static let codeGutter = Color(uiColor: LodyUIColor.codeGutter)
    public static let syntaxKeyword = Color(uiColor: LodyUIColor.syntaxKeyword)
    public static let syntaxString = Color(uiColor: LodyUIColor.syntaxString)
    public static let syntaxNumber = Color(uiColor: LodyUIColor.syntaxNumber)
    /// true / false / null and named constants.
    public static let syntaxConstant = Color(uiColor: LodyUIColor.syntaxConstant)
    public static let syntaxFunction = Color(uiColor: LodyUIColor.syntaxFunction)
    public static let syntaxType = Color(uiColor: LodyUIColor.syntaxType)
    public static let syntaxVariable = Color(uiColor: LodyUIColor.syntaxVariable)
    /// Object keys, HTML / JSX attributes.
    public static let syntaxProperty = Color(uiColor: LodyUIColor.syntaxProperty)
    public static let syntaxTag = Color(uiColor: LodyUIColor.syntaxTag)
    public static let syntaxComment = Color(uiColor: LodyUIColor.syntaxComment)
    /// Operators and punctuation.
    public static let syntaxPunctuation = Color(uiColor: LodyUIColor.syntaxPunctuation)
    public static let diffAddedBg = Color(uiColor: LodyUIColor.diffAddedBg)
    public static let diffRemovedBg = Color(uiColor: LodyUIColor.diffRemovedBg)
    public static let diffAddedText = Color(uiColor: LodyUIColor.diffAddedText)
    public static let diffRemovedText = Color(uiColor: LodyUIColor.diffRemovedText)
    /// @@ hunk header rows.
    public static let diffHunkBg = Color(uiColor: LodyUIColor.diffHunkBg)
    public static let diffHunkText = Color(uiColor: LodyUIColor.diffHunkText)
    /// Selected-text highlight.
    public static let selectionText = Color(uiColor: LodyUIColor.selectionText)
    /// Caret and selection handles.
    public static let selectionHandle = Color(uiColor: LodyUIColor.selectionHandle)
    /// Dimming behind custom modals.
    public static let overlayScrim = Color(uiColor: LodyUIColor.overlayScrim)
    public static let shadowSm = Color(uiColor: LodyUIColor.shadowSm)
    public static let shadowMd = Color(uiColor: LodyUIColor.shadowMd)
    public static let shadowLg = Color(uiColor: LodyUIColor.shadowLg)

    public static let all: [(name: String, color: Color)] = [
        ("bg.base", bgBase),
        ("bg.grouped", bgGrouped),
        ("bg.raised", bgRaised),
        ("bg.sunken", bgSunken),
        ("bg.overlay", bgOverlay),
        ("bg.inverse", bgInverse),
        ("fill.pressed", fillPressed),
        ("fill.selected", fillSelected),
        ("fill.secondary", fillSecondary),
        ("fill.tertiary", fillTertiary),
        ("fill.disabled", fillDisabled),
        ("text.primary", textPrimary),
        ("text.secondary", textSecondary),
        ("text.tertiary", textTertiary),
        ("text.placeholder", textPlaceholder),
        ("text.disabled", textDisabled),
        ("text.inverse", textInverse),
        ("text.onAccent", textOnAccent),
        ("text.onDanger", textOnDanger),
        ("text.link", textLink),
        ("icon.primary", iconPrimary),
        ("icon.secondary", iconSecondary),
        ("icon.tertiary", iconTertiary),
        ("icon.disabled", iconDisabled),
        ("border.subtle", borderSubtle),
        ("border.default", borderDefault),
        ("border.strong", borderStrong),
        ("border.focus", borderFocus),
        ("accent.default", accentDefault),
        ("accent.solid", accentSolid),
        ("accent.pressed", accentPressed),
        ("accent.fg", accentFg),
        ("accent.subtle", accentSubtle),
        ("accent.onSubtle", accentOnSubtle),
        ("danger.default", dangerDefault),
        ("danger.solid", dangerSolid),
        ("danger.subtle", dangerSubtle),
        ("danger.onSubtle", dangerOnSubtle),
        ("warning.default", warningDefault),
        ("warning.subtle", warningSubtle),
        ("warning.onSubtle", warningOnSubtle),
        ("success.default", successDefault),
        ("success.subtle", successSubtle),
        ("success.onSubtle", successOnSubtle),
        ("info.default", infoDefault),
        ("info.subtle", infoSubtle),
        ("info.onSubtle", infoOnSubtle),
        ("state.idle", stateIdle),
        ("state.running", stateRunning),
        ("state.waiting", stateWaiting),
        ("state.done", stateDone),
        ("state.failed", stateFailed),
        ("state.merged", stateMerged),
        ("pr.open", prOpen),
        ("pr.merged", prMerged),
        ("pr.closed", prClosed),
        ("pr.draft", prDraft),
        ("label.gray.fg", labelGrayFg),
        ("label.gray.bg", labelGrayBg),
        ("label.red.fg", labelRedFg),
        ("label.red.bg", labelRedBg),
        ("label.orange.fg", labelOrangeFg),
        ("label.orange.bg", labelOrangeBg),
        ("label.yellow.fg", labelYellowFg),
        ("label.yellow.bg", labelYellowBg),
        ("label.green.fg", labelGreenFg),
        ("label.green.bg", labelGreenBg),
        ("label.teal.fg", labelTealFg),
        ("label.teal.bg", labelTealBg),
        ("label.blue.fg", labelBlueFg),
        ("label.blue.bg", labelBlueBg),
        ("label.indigo.fg", labelIndigoFg),
        ("label.indigo.bg", labelIndigoBg),
        ("label.purple.fg", labelPurpleFg),
        ("label.purple.bg", labelPurpleBg),
        ("label.pink.fg", labelPinkFg),
        ("label.pink.bg", labelPinkBg),
        ("code.bg", codeBg),
        ("code.inlineBg", codeInlineBg),
        ("code.text", codeText),
        ("code.border", codeBorder),
        ("code.gutter", codeGutter),
        ("syntax.keyword", syntaxKeyword),
        ("syntax.string", syntaxString),
        ("syntax.number", syntaxNumber),
        ("syntax.constant", syntaxConstant),
        ("syntax.function", syntaxFunction),
        ("syntax.type", syntaxType),
        ("syntax.variable", syntaxVariable),
        ("syntax.property", syntaxProperty),
        ("syntax.tag", syntaxTag),
        ("syntax.comment", syntaxComment),
        ("syntax.punctuation", syntaxPunctuation),
        ("diff.addedBg", diffAddedBg),
        ("diff.removedBg", diffRemovedBg),
        ("diff.addedText", diffAddedText),
        ("diff.removedText", diffRemovedText),
        ("diff.hunkBg", diffHunkBg),
        ("diff.hunkText", diffHunkText),
        ("selection.text", selectionText),
        ("selection.handle", selectionHandle),
        ("overlay.scrim", overlayScrim),
        ("shadow.sm", shadowSm),
        ("shadow.md", shadowMd),
        ("shadow.lg", shadowLg),
    ]
}

/// UIKit mirror of `LodyColor` for views that are not SwiftUI.
public enum LodyUIColor {
    public static let bgBase = UIColor(lodyLight: 0xFFFFFFFF, dark: 0x111113FF)
    public static let bgGrouped = UIColor(lodyLight: 0xF2F2F2FF, dark: 0x111113FF)
    public static let bgRaised = UIColor(lodyLight: 0xFFFFFFFF, dark: 0x1C1C1CFF)
    public static let bgSunken = UIColor(lodyLight: 0x0000000D, dark: 0xFFFFFF1A)
    public static let bgOverlay = UIColor(lodyLight: 0xFFFFFFFF, dark: 0x2B2B2BFF)
    public static let bgInverse = UIColor(lodyLight: 0x1C1C1CFF, dark: 0xFFFFFFFF)
    public static let fillPressed = UIColor(lodyLight: 0xE5E5E5FF, dark: 0x393939FF)
    public static let fillSelected = UIColor(lodyLight: 0x00000014, dark: 0xFFFFFF1F)
    public static let fillSecondary = UIColor(lodyLight: 0x00000012, dark: 0xFFFFFF1F)
    public static let fillTertiary = UIColor(lodyLight: 0x0000000D, dark: 0xFFFFFF14)
    public static let fillDisabled = UIColor(lodyLight: 0xEBEBEBFF, dark: 0x2B2B2BFF)
    public static let textPrimary = UIColor(lodyLight: 0x1C1C1CFF, dark: 0xFFFFFFFF)
    public static let textSecondary = UIColor(lodyLight: 0x646464FF, dark: 0xABABABFF)
    public static let textTertiary = UIColor(lodyLight: 0x898989FF, dark: 0x8C8C8CFF)
    public static let textPlaceholder = UIColor(lodyLight: 0x999999FF, dark: 0x7A7A7AFF)
    public static let textDisabled = UIColor(lodyLight: 0x999999FF, dark: 0x7A7A7AFF)
    public static let textInverse = UIColor(lodyLight: 0xFFFFFFFF, dark: 0x000000FF)
    public static let textOnAccent = UIColor(lodyLight: 0xFFFFFFFF, dark: 0xFFFFFFFF)
    public static let textOnDanger = UIColor(lodyLight: 0xFFFFFFFF, dark: 0xFFFFFFFF)
    public static let textLink = UIColor(lodyLight: 0x345FBDFF, dark: 0x80ABFFFF)
    public static let iconPrimary = UIColor(lodyLight: 0x1C1C1CFF, dark: 0xFFFFFFFF)
    public static let iconSecondary = UIColor(lodyLight: 0x898989FF, dark: 0x8C8C8CFF)
    public static let iconTertiary = UIColor(lodyLight: 0xAFAFAFFF, dark: 0x6C6C6CFF)
    public static let iconDisabled = UIColor(lodyLight: 0xAFAFAFFF, dark: 0x6C6C6CFF)
    public static let borderSubtle = UIColor(lodyLight: 0xD2D2D2FF, dark: 0x393939FF)
    public static let borderDefault = UIColor(lodyLight: 0xD2D2D2FF, dark: 0x444444FF)
    public static let borderStrong = UIColor(lodyLight: 0xC5C5C5FF, dark: 0x525252FF)
    public static let borderFocus = UIColor(lodyLight: 0x5D8DEFFF, dark: 0x7CA8FFFF)
    public static let accentDefault = UIColor(lodyLight: 0x5D8DEFFF, dark: 0x7CA8FFFF)
    public static let accentSolid = UIColor(lodyLight: 0x4673D3FF, dark: 0x4C74C7FF)
    public static let accentPressed = UIColor(lodyLight: 0x3864C2FF, dark: 0x3E65B6FF)
    public static let accentFg = UIColor(lodyLight: 0x345FBDFF, dark: 0x80ABFFFF)
    public static let accentSubtle = UIColor(lodyLight: 0x5D8DEF1F, dark: 0x7CA8FF33)
    public static let accentOnSubtle = UIColor(lodyLight: 0x345FBDFF, dark: 0x80ABFFFF)
    public static let dangerDefault = UIColor(lodyLight: 0xBD001EFF, dark: 0xFF706AFF)
    public static let dangerSolid = UIColor(lodyLight: 0xCE222DFF, dark: 0xDD353AFF)
    public static let dangerSubtle = UIColor(lodyLight: 0xCE222D1A, dark: 0xFD555438)
    public static let dangerOnSubtle = UIColor(lodyLight: 0xBD001EFF, dark: 0xFF706AFF)
    public static let warningDefault = UIColor(lodyLight: 0x9B5300FF, dark: 0xFF9F4AFF)
    public static let warningSubtle = UIColor(lodyLight: 0xE9820C24, dark: 0xFF9F4A33)
    public static let warningOnSubtle = UIColor(lodyLight: 0x9B5300FF, dark: 0xFF9F4AFF)
    public static let successDefault = UIColor(lodyLight: 0x298E5DFF, dark: 0x4EAE7BFF)
    public static let successSubtle = UIColor(lodyLight: 0x298E5D1F, dark: 0x4EAE7B33)
    public static let successOnSubtle = UIColor(lodyLight: 0x006F43FF, dark: 0x57B783FF)
    public static let infoDefault = UIColor(lodyLight: 0x5D8DEFFF, dark: 0x7CA8FFFF)
    public static let infoSubtle = UIColor(lodyLight: 0x5D8DEF1F, dark: 0x7CA8FF33)
    public static let infoOnSubtle = UIColor(lodyLight: 0x345FBDFF, dark: 0x80ABFFFF)
    public static let stateIdle = UIColor(lodyLight: 0x898989FF, dark: 0x8C8C8CFF)
    public static let stateRunning = UIColor(lodyLight: 0x5D8DEFFF, dark: 0x7CA8FFFF)
    public static let stateWaiting = UIColor(lodyLight: 0x9B5300FF, dark: 0xFF9F4AFF)
    public static let stateDone = UIColor(lodyLight: 0x298E5DFF, dark: 0x4EAE7BFF)
    public static let stateFailed = UIColor(lodyLight: 0xCE222DFF, dark: 0xFD5554FF)
    public static let stateMerged = UIColor(lodyLight: 0x814EDFFF, dark: 0xA37AFFFF)
    public static let prOpen = UIColor(lodyLight: 0x1A7F37FF, dark: 0x53AF65FF)
    public static let prMerged = UIColor(lodyLight: 0x814EDFFF, dark: 0xA37AFFFF)
    public static let prClosed = UIColor(lodyLight: 0xCE222DFF, dark: 0xFD5554FF)
    public static let prDraft = UIColor(lodyLight: 0x898989FF, dark: 0x8C8C8CFF)
    public static let labelGrayFg = UIColor(lodyLight: 0x646464FF, dark: 0xABABABFF)
    public static let labelGrayBg = UIColor(lodyLight: 0x0000000F, dark: 0xFFFFFF1A)
    public static let labelRedFg = UIColor(lodyLight: 0xAB3937FF, dark: 0xF58B84FF)
    public static let labelRedBg = UIColor(lodyLight: 0xD15C5624, dark: 0xF2888133)
    public static let labelOrangeFg = UIColor(lodyLight: 0x984C00FF, dark: 0xEB9557FF)
    public static let labelOrangeBg = UIColor(lodyLight: 0xC9690C24, dark: 0xE9935533)
    public static let labelYellowFg = UIColor(lodyLight: 0x785F00FF, dark: 0xCDA83CFF)
    public static let labelYellowBg = UIColor(lodyLight: 0xA4820024, dark: 0xCBA63A33)
    public static let labelGreenFg = UIColor(lodyLight: 0x007332FF, dark: 0x69C27EFF)
    public static let labelGreenBg = UIColor(lodyLight: 0x2E9E5224, dark: 0x69C27E33)
    public static let labelTealFg = UIColor(lodyLight: 0x006E6FFF, dark: 0x00C3C3FF)
    public static let labelTealBg = UIColor(lodyLight: 0x009A9A24, dark: 0x00C3C333)
    public static let labelBlueFg = UIColor(lodyLight: 0x0064AEFF, dark: 0x68B2FBFF)
    public static let labelBlueBg = UIColor(lodyLight: 0x2F8ADC24, dark: 0x67B0F933)
    public static let labelIndigoFg = UIColor(lodyLight: 0x4D58B8FF, dark: 0x95A6FFFF)
    public static let labelIndigoBg = UIColor(lodyLight: 0x6D7CDF24, dark: 0x93A3FC33)
    public static let labelPurpleFg = UIColor(lodyLight: 0x7A4AAAFF, dark: 0xC198EFFF)
    public static let labelPurpleBg = UIColor(lodyLight: 0x9B6BCE24, dark: 0xBE95EC33)
    public static let labelPinkFg = UIColor(lodyLight: 0xA13972FF, dark: 0xEC8AB9FF)
    public static let labelPinkBg = UIColor(lodyLight: 0xC65B9324, dark: 0xE887B633)
    public static let codeBg = UIColor(lodyLight: 0x0000000D, dark: 0xFFFFFF12)
    public static let codeInlineBg = UIColor(lodyLight: 0x00000012, dark: 0xFFFFFF1F)
    public static let codeText = UIColor(lodyLight: 0x1C1C1CFF, dark: 0xFFFFFFFF)
    public static let codeBorder = UIColor(lodyLight: 0xDEDEDEFF, dark: 0x393939FF)
    public static let codeGutter = UIColor(lodyLight: 0x646464FF, dark: 0x8C8C8CFF)
    public static let syntaxKeyword = UIColor(lodyLight: 0x7A4AAAFF, dark: 0xC198EFFF)
    public static let syntaxString = UIColor(lodyLight: 0x007332FF, dark: 0x69C27EFF)
    public static let syntaxNumber = UIColor(lodyLight: 0x984C00FF, dark: 0xEB9557FF)
    public static let syntaxConstant = UIColor(lodyLight: 0x0064AEFF, dark: 0x68B2FBFF)
    public static let syntaxFunction = UIColor(lodyLight: 0x4D58B8FF, dark: 0x95A6FFFF)
    public static let syntaxType = UIColor(lodyLight: 0x006E6FFF, dark: 0x00C3C3FF)
    public static let syntaxVariable = UIColor(lodyLight: 0x1C1C1CFF, dark: 0xFFFFFFFF)
    public static let syntaxProperty = UIColor(lodyLight: 0xAB3937FF, dark: 0xF58B84FF)
    public static let syntaxTag = UIColor(lodyLight: 0xA13972FF, dark: 0xEC8AB9FF)
    public static let syntaxComment = UIColor(lodyLight: 0x646464FF, dark: 0x8C8C8CFF)
    public static let syntaxPunctuation = UIColor(lodyLight: 0x646464FF, dark: 0xABABABFF)
    public static let diffAddedBg = UIColor(lodyLight: 0x298E5D1F, dark: 0x4EAE7B2E)
    public static let diffRemovedBg = UIColor(lodyLight: 0xCE222D1A, dark: 0xFD555433)
    public static let diffAddedText = UIColor(lodyLight: 0x006F43FF, dark: 0x57B783FF)
    public static let diffRemovedText = UIColor(lodyLight: 0xBD001EFF, dark: 0xFF706AFF)
    public static let diffHunkBg = UIColor(lodyLight: 0x5D8DEF1A, dark: 0x7CA8FF24)
    public static let diffHunkText = UIColor(lodyLight: 0x345FBDFF, dark: 0x80ABFFFF)
    public static let selectionText = UIColor(lodyLight: 0x5D8DEF3D, dark: 0x7CA8FF5C)
    public static let selectionHandle = UIColor(lodyLight: 0x5D8DEFFF, dark: 0x7CA8FFFF)
    public static let overlayScrim = UIColor(lodyLight: 0x00000066, dark: 0x00000099)
    public static let shadowSm = UIColor(lodyLight: 0x00000014, dark: 0x00000066)
    public static let shadowMd = UIColor(lodyLight: 0x0000001F, dark: 0x00000080)
    public static let shadowLg = UIColor(lodyLight: 0x00000029, dark: 0x00000099)
}

extension UIColor {
    convenience init(lodyLight light: UInt32, dark: UInt32) {
        self.init { traits in
            UIColor(lodyRGBA: traits.userInterfaceStyle == .dark ? dark : light)
        }
    }

    convenience init(lodyRGBA rgba: UInt32) {
        self.init(
            red: CGFloat((rgba >> 24) & 0xFF) / 255,
            green: CGFloat((rgba >> 16) & 0xFF) / 255,
            blue: CGFloat((rgba >> 8) & 0xFF) / 255,
            alpha: CGFloat(rgba & 0xFF) / 255
        )
    }
}
