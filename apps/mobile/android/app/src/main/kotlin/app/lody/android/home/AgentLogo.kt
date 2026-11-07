package app.lody.android.home

import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import app.lody.android.designsystem.LodyIcons

/**
 * Agent provider marks, web `AgentIcon` (iOS `LodyAgentIcon`): builtin and registry agents by
 * their agentType, a terminal for custom commands, and the generic assistant otherwise. The
 * drawables come from the iOS agent SVGs (`scripts/agent-icons.mjs`).
 */
object AgentLogo {
    sealed interface Mark {
        data class Logo(val name: String) : Mark
        data object Terminal : Mark
        data object Generic : Mark
    }

    /** Agent types whose mark has another name (web `AgentIcon`'s special cases). */
    private val aliases = mapOf(
        "claude-p" to "claude", "claude-code" to "claude", "kimi-code" to "kimi", "grok-build" to "grok", "pi" to "pi-acp",
    )

    fun mark(cliType: String?, agentType: String?): Mark {
        if (cliType == "custom") return Mark.Terminal
        val type = agentType.orEmpty().trim().lowercase()
        val name = aliases[type] ?: type
        return if (name in AgentLogoDrawables) Mark.Logo(name) else Mark.Generic
    }
}

/** The provider's mark, tinted like an icon. */
@Composable
fun AgentMark(cliType: String?, agentType: String?, tint: Color, modifier: Modifier = Modifier) {
    when (val mark = AgentLogo.mark(cliType, agentType)) {
        is AgentLogo.Mark.Logo -> Icon(painterResource(AgentLogoDrawables.getValue(mark.name)), contentDescription = null, tint = tint, modifier = modifier)
        AgentLogo.Mark.Terminal -> Icon(LodyIcons.Terminal, contentDescription = null, tint = tint, modifier = modifier)
        AgentLogo.Mark.Generic -> Icon(LodyIcons.Agent, contentDescription = null, tint = tint, modifier = modifier)
    }
}
