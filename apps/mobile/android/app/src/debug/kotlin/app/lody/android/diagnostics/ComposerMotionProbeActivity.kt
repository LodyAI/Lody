package app.lody.android.diagnostics

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.TextFieldValue
import app.lody.android.chat.ChatComposer
import app.lody.android.designsystem.LodyTheme

/** Real composer animation without requiring a connected session or writing account data. */
class ComposerMotionProbeActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val mentions = intent.getBooleanExtra("mentions", false)
        setContent {
            LodyTheme {
                var prompt by remember { mutableStateOf(TextFieldValue(if (mentions) "@session:fixture-session @role:fixture-role " else "")) }
                Surface(color = LodyTheme.colors.bgBase) {
                    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding(), verticalArrangement = Arrangement.Bottom) {
                        if (mentions) {
                            val body = "Please review @Fix sign-in with 🧪 Reviewer and @src/auth/login.ts."
                            val ranges = listOf("@Fix sign-in", "🧪 Reviewer", "@src/auth/login.ts").map { label ->
                                val start = body.indexOf(label)
                                app.lody.android.runtime.MessageReference(start, start + label.length)
                            }
                            app.lody.android.chat.ChatTranscript(listOf(app.lody.android.chat.ChatEntry.User("mentions", body, app.lody.android.chat.TurnIdentity("You"), references = ranges)), Modifier.weight(1f))
                        }

                        ChatComposer(
                            prompt = prompt, onPromptChange = { prompt = app.lody.android.chat.MentionPresentation.edit(prompt, it) },
                            referencePresentation = app.lody.android.chat.MentionPresentation(listOf(
                                app.lody.android.runtime.MentionCandidate("fixture-session", "Fix sign-in", "session", insertText = "@session:fixture-session"),
                                app.lody.android.runtime.MentionCandidate("fixture-role", "Reviewer", "role", insertText = "@role:fixture-role", emoji = "🧪"),
                            ), LodyTheme.colors.accentDefault), onFocusChange = {}, enabled = true,
                            agentCliType = "builtin", agentType = "codex", roleEmoji = null, roleName = null,
                            agentName = "Codex", face = listOf("6.1 Sol", "Medium"), mode = null, modeLabel = null,
                            plan = false, fast = false, onRunConfig = {}, stoppable = false, stopping = false,
                            attachments = emptyList(), onPickPhotos = {}, onPickFiles = {}, onRemoveAttachment = {},
                            onSend = {}, onStop = {},
                        )
                    }
                }
            }
        }
    }
}
