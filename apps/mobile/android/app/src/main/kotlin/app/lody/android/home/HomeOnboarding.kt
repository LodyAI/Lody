// First-run guide on the Chats tab; web counterpart: `MobileHomeOnboarding` in `mobile/mobile-home-screen.tsx`.
//
// Stands in for the empty list only when a loaded catalog has no computers and no chats. The phone
// never opens the download page or runs anything: it copies or shares the command and the link.

package app.lody.android.home

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import app.lody.android.R
import app.lody.android.designsystem.LodyButton
import app.lody.android.designsystem.LodyIconButton
import app.lody.android.designsystem.LodyIconSize
import app.lody.android.designsystem.LodyIcons
import app.lody.android.designsystem.LodyLayout
import app.lody.android.designsystem.LodyRadius
import app.lody.android.designsystem.LodySize
import app.lody.android.designsystem.LodySpacing
import app.lody.android.designsystem.LodyTheme
import kotlinx.coroutines.delay

/** The installer command; identical in every language, so not a string resource. */
internal const val ONBOARDING_INSTALL_COMMAND = "curl -fsSL 'https://api.lody.ai/install.sh' | sh -s -- --channel 'stable'"

private enum class Copied { Command, Link }

@Composable
internal fun HomeOnboarding(padding: PaddingValues) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val downloadUrl = stringResource(R.string.home_onboarding_download_url)
    var copied by remember { mutableStateOf<Copied?>(null) }
    LaunchedEffect(copied) { if (copied != null) { delay(2000); copied = null } }
    fun copy(text: String, kind: Copied) { clipboard.setText(AnnotatedString(text)); copied = kind }
    fun share(text: String) {
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
        context.startActivity(Intent.createChooser(send, null))
    }

    Box(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier.widthIn(max = LodyLayout.readableMaxWidth).fillMaxWidth()
                .padding(horizontal = LodyLayout.screenPaddingX, vertical = LodySpacing.xxl),
            verticalArrangement = Arrangement.spacedBy(LodySpacing.lg),
        ) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(LodySpacing.md)) {
                Box(
                    Modifier.size(LodySize.controlLg).clip(RoundedCornerShape(LodyRadius.xl)).background(colors.fillSecondary),
                    contentAlignment = Alignment.Center,
                ) { Icon(LodyIcons.Machine, null, Modifier.size(LodyIconSize.lg), tint = colors.iconSecondary) }
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(LodySpacing.xs)) {
                    Text(
                        stringResource(R.string.home_onboarding_title), style = type.headline, color = colors.textPrimary,
                        textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() },
                    )
                    Text(stringResource(R.string.home_onboarding_description), style = type.subhead, color = colors.textSecondary, textAlign = TextAlign.Center)
                }
            }

            // Path 1: one command on any macOS / Linux machine.
            OnboardingCard(LodyIcons.Terminal, stringResource(R.string.home_onboarding_command_heading), stringResource(R.string.home_onboarding_command_hint)) {
                val copyLabel = stringResource(R.string.home_onboarding_copy_command)
                val copiedLabel = stringResource(R.string.home_onboarding_copied)
                val isCopied = copied == Copied.Command
                Row(
                    Modifier.weight(1f).heightIn(min = LodySize.controlLg)
                        .clip(RoundedCornerShape(LodyRadius.lg)).background(colors.bgSunken)
                        .clickable(role = Role.Button, onClickLabel = copyLabel) { copy(ONBOARDING_INSTALL_COMMAND, Copied.Command) }
                        .semantics { contentDescription = if (isCopied) copiedLabel else "$copyLabel: $ONBOARDING_INSTALL_COMMAND" }
                        .padding(horizontal = LodySpacing.md, vertical = LodySpacing.sm),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm),
                ) {
                    Text(ONBOARDING_INSTALL_COMMAND, Modifier.weight(1f), style = type.codeSmall, color = colors.textPrimary)
                    CopyGlyph(isCopied)
                }
                val shareLabel = stringResource(R.string.home_onboarding_share_command)
                LodyIconButton(onClick = { share("$ONBOARDING_INSTALL_COMMAND\n$downloadUrl") }, modifier = Modifier.semantics { contentDescription = shareLabel }) {
                    Icon(LodyIcons.Share, null, Modifier.size(LodyIconSize.sm), tint = colors.iconSecondary)
                }
            }

            // Path 2: the desktop app, handed to the computer as a link.
            OnboardingCard(LodyIcons.Desktop, stringResource(R.string.home_onboarding_desktop_heading), stringResource(R.string.home_onboarding_desktop_hint)) {
                LodyButton(
                    onClick = { share(downloadUrl) }, modifier = Modifier.weight(1f), shape = RoundedCornerShape(LodyRadius.lg),
                    colors = ButtonDefaults.buttonColors(containerColor = colors.bgInverse, contentColor = colors.textInverse),
                ) {
                    Icon(LodyIcons.Share, null, Modifier.size(LodyIconSize.sm))
                    Text(stringResource(R.string.home_onboarding_share_download), Modifier.padding(start = LodySpacing.sm), style = type.bodyEmphasis)
                }
                val copyLabel = stringResource(R.string.home_onboarding_copy_download)
                val copiedLabel = stringResource(R.string.home_onboarding_copied)
                val isCopied = copied == Copied.Link
                LodyIconButton(
                    onClick = { copy(downloadUrl, Copied.Link) },
                    modifier = Modifier.semantics { contentDescription = if (isCopied) copiedLabel else "$copyLabel: $downloadUrl" },
                ) { CopyGlyph(isCopied) }
            }

            // What happens next, so the user knows the flow continues on this phone.
            Column(Modifier.padding(horizontal = LodySpacing.xs), verticalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
                Text(
                    stringResource(R.string.home_onboarding_next_heading), style = type.caption, color = colors.textTertiary,
                    modifier = Modifier.semantics { heading() },
                )
                listOf(R.string.home_onboarding_next_machine, R.string.home_onboarding_next_project, R.string.home_onboarding_next_agent)
                    .forEachIndexed { index, step ->
                        Row(horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
                            Box(
                                Modifier.size(LodySize.badge).clip(CircleShape).background(colors.fillSecondary),
                                contentAlignment = Alignment.Center,
                            ) { Text("${index + 1}", style = type.micro, color = colors.textSecondary) }
                            Text(stringResource(step), Modifier.weight(1f), style = type.footnote, color = colors.textSecondary)
                        }
                    }
            }
        }
    }
}

@Composable
private fun OnboardingCard(icon: ImageVector, title: String, hint: String, actions: @Composable RowScope.() -> Unit) {
    val colors = LodyTheme.colors
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(LodyRadius.xl)).background(colors.bgRaised).padding(LodySpacing.lg),
        verticalArrangement = Arrangement.spacedBy(LodySpacing.md),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
            Icon(icon, null, Modifier.size(LodyIconSize.sm), tint = colors.iconSecondary)
            Text(title, style = LodyTheme.typography.bodyEmphasis, color = colors.textPrimary, modifier = Modifier.semantics { heading() })
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm), content = actions)
        Text(hint, style = LodyTheme.typography.footnote, color = colors.textSecondary)
    }
}

/** Copy, or a check for a moment after copying. */
@Composable
private fun CopyGlyph(copied: Boolean) {
    val colors = LodyTheme.colors
    Icon(
        if (copied) LodyIcons.Check else LodyIcons.Copy, null, Modifier.size(LodyIconSize.sm),
        tint = if (copied) colors.successDefault else colors.iconSecondary,
    )
}
