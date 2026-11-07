package app.lody.android.home

import app.lody.android.home.AgentLogo.Mark
import org.junit.Assert.assertEquals
import org.junit.Test

class AgentLogoTest {
    @Test fun builtinAndRegistryAgentsUseTheirProviderMark() {
        assertEquals(Mark.Logo("claude"), AgentLogo.mark("builtin", "claude"))
        assertEquals(Mark.Logo("codex"), AgentLogo.mark("builtin", "codex"))
        assertEquals(Mark.Logo("pi-acp"), AgentLogo.mark("builtin", "pi"))
        assertEquals(Mark.Logo("claude"), AgentLogo.mark("registry", "claude-p"))
        assertEquals(Mark.Logo("cursor"), AgentLogo.mark("registry", "cursor"))
        assertEquals(Mark.Logo("grok"), AgentLogo.mark("registry", "grok-build"))
    }

    @Test fun customCommandsShowATerminalAndUnknownAgentsTheGenericMark() {
        assertEquals(Mark.Terminal, AgentLogo.mark("custom", "3f2a-uuid"))
        assertEquals(Mark.Generic, AgentLogo.mark("registry", "something-new"))
        assertEquals(Mark.Generic, AgentLogo.mark(null, null))
    }
}
