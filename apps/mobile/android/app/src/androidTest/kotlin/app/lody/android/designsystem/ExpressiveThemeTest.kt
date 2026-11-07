package app.lody.android.designsystem

import androidx.compose.ui.graphics.Color
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MotionScheme
import androidx.compose.runtime.SideEffect
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.lody.android.diagnostics.ComposerMotionProbeActivity
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Production theme must opt in globally, including dark mode and native sheets. */
@RunWith(AndroidJUnit4::class)
class ExpressiveThemeTest {
    @Test fun productionThemeUsesExpressiveMotionAndPreservesTokens() {
        for (dark in listOf(false, true)) {
            val rendered = CountDownLatch(1)
            var expressive = false
            var tokensPreserved = false
            var pagePalettePreserved = false
            ActivityScenario.launch(ComposerMotionProbeActivity::class.java).use { scenario ->
                scenario.onActivity { activity -> activity.setContent {
                    LodyTheme(darkTheme = dark) {
                        val motion = MaterialTheme.motionScheme
                        val colors = MaterialTheme.colorScheme
                        val type = MaterialTheme.typography
                        val expected = if (dark) LodyDarkColors else LodyLightColors
                        SideEffect {
                            val page = if (dark) Color(0xFF111113) else Color.White
                            pagePalettePreserved = expected.bgBase == page &&
                                (!dark || expected.bgGrouped == page) &&
                                colors.background == page && colors.surface == page &&
                                colors.surfaceContainerLowest == page &&
                                (!dark || colors.surfaceDim == page)
                            expressive = motion === MotionScheme.expressive()
                            tokensPreserved = colors.primary == expected.accentSolid &&
                                colors.surface == expected.bgBase &&
                                type.bodyLarge == LodyDefaultTypography.body
                            rendered.countDown()
                        }
                    }
                } }
                assertTrue("Theme rendered", rendered.await(5, TimeUnit.SECONDS))
                assertTrue("Page palette uses soft black in dark mode and white in light mode", pagePalettePreserved)
                assertTrue("Production theme uses expressive motion (dark=$dark)", expressive)
                assertTrue("Palette and typography remain unchanged (dark=$dark)", tokensPreserved)
            }
        }
    }
}
