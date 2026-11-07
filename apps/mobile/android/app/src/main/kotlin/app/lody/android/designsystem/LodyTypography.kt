// Imported from Lody Mobile; maintained as platform-owned appearance code.

package app.lody.android.designsystem

import androidx.compose.runtime.Immutable
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.sp
import app.lody.android.R

val LodySansFontFamily = FontFamily(
    Font(R.font.lody_inter_regular, FontWeight.W400),
    Font(R.font.lody_inter_medium, FontWeight.W500),
    Font(R.font.lody_inter_semibold, FontWeight.W600),
    Font(R.font.lody_inter_bold, FontWeight.W700),
)

val LodyMonoFontFamily = FontFamily(
    Font(R.font.lody_jetbrainsmono_regular, FontWeight.W400),
    Font(R.font.lody_jetbrainsmono_medium, FontWeight.W500),
    Font(R.font.lody_jetbrainsmono_bold, FontWeight.W700),
)

/** Type scale. Read the active set through `LodyTheme.typography`. */
@Immutable
class LodyTypography(
    /** Onboarding and empty-screen hero titles. */
    val display: TextStyle,
    /** Root screen titles ("Sessions", "My issues"). */
    val largeTitle: TextStyle,
    /** Detail screen headers, empty-state titles. */
    val title: TextStyle,
    /** Navigation bar titles, sheet titles, card titles. */
    val headline: TextStyle,
    /** List row titles, form values. */
    val body: TextStyle,
    /** Unread rows, emphasized values. */
    val bodyEmphasis: TextStyle,
    /** Long-form chat and markdown. */
    val reading: TextStyle,
    /** Composer text, dense paragraphs in cards. */
    val callout: TextStyle,
    /** Descriptions under titles, settings footers. */
    val bodySmall: TextStyle,
    /** Section headers, segmented controls, buttons. */
    val subhead: TextStyle,
    /** Compact buttons, segmented items, form labels. */
    val label: TextStyle,
    /** Row subtitles, metadata, timestamps. */
    val footnote: TextStyle,
    /** Badges, chip labels. */
    val caption: TextStyle,
    /** Tab bar labels, counters. */
    val micro: TextStyle,
    /** Code blocks. */
    val code: TextStyle,
    /** Diffs, inline code in dense rows. */
    val codeSmall: TextStyle,
) {
    fun entries(): List<Pair<String, TextStyle>> = listOf(
        "display" to display,
        "largeTitle" to largeTitle,
        "title" to title,
        "headline" to headline,
        "body" to body,
        "bodyEmphasis" to bodyEmphasis,
        "reading" to reading,
        "callout" to callout,
        "bodySmall" to bodySmall,
        "subhead" to subhead,
        "label" to label,
        "footnote" to footnote,
        "caption" to caption,
        "micro" to micro,
        "code" to code,
        "codeSmall" to codeSmall,
    )
}

val LodyDefaultTypography = LodyTypography(
    display = lodyTextStyle(LodySansFontFamily, FontWeight.W700, 34, 40, -0.74f),
    largeTitle = lodyTextStyle(LodySansFontFamily, FontWeight.W700, 28, 34, -0.59f),
    title = lodyTextStyle(LodySansFontFamily, FontWeight.W600, 22, 28, -0.4f),
    headline = lodyTextStyle(LodySansFontFamily, FontWeight.W600, 17, 22, -0.22f),
    body = lodyTextStyle(LodySansFontFamily, FontWeight.W400, 16, 22, -0.18f),
    bodyEmphasis = lodyTextStyle(LodySansFontFamily, FontWeight.W500, 16, 22, -0.18f),
    reading = lodyTextStyle(LodySansFontFamily, FontWeight.W400, 16, 25, -0.18f),
    callout = lodyTextStyle(LodySansFontFamily, FontWeight.W400, 15, 20, -0.13f),
    bodySmall = lodyTextStyle(LodySansFontFamily, FontWeight.W400, 14, 20, -0.09f),
    subhead = lodyTextStyle(LodySansFontFamily, FontWeight.W500, 14, 20, -0.09f),
    label = lodyTextStyle(LodySansFontFamily, FontWeight.W500, 13, 16, -0.04f),
    footnote = lodyTextStyle(LodySansFontFamily, FontWeight.W400, 13, 18, -0.04f),
    caption = lodyTextStyle(LodySansFontFamily, FontWeight.W500, 12, 16, 0.01f),
    micro = lodyTextStyle(LodySansFontFamily, FontWeight.W500, 11, 14, 0.05f),
    code = lodyTextStyle(LodyMonoFontFamily, FontWeight.W400, 13, 20, 0f),
    codeSmall = lodyTextStyle(LodyMonoFontFamily, FontWeight.W400, 12, 18, 0f),
)

// Center glyphs in the full line box and keep the leading on both ends, which
// matches how the iOS runtime pads lines to the same height.
private val LodyLineHeightStyle = LineHeightStyle(
    alignment = LineHeightStyle.Alignment.Center,
    trim = LineHeightStyle.Trim.None,
)

private fun lodyTextStyle(family: FontFamily, weight: FontWeight, size: Int, lineHeight: Int, tracking: Float) =
    TextStyle(
        fontFamily = family,
        fontWeight = weight,
        fontSize = size.sp,
        lineHeight = lineHeight.sp,
        letterSpacing = tracking.sp,
        lineHeightStyle = LodyLineHeightStyle,
    )
