package app.lody.android.designsystem

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Icon
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntSize
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.lody.android.diagnostics.ComposerMotionProbeActivity
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Guards against native minimum touch targets expanding the existing composer/control row. */
@RunWith(AndroidJUnit4::class)
class ControlBoundsTest {
    @Test fun expressiveControlsKeepTheirExistingOccupiedBounds() {
        val laidOut = CountDownLatch(3)
        val sizes = arrayOfNulls<IntSize>(3)
        val positions = FloatArray(3)
        val expected = IntArray(3)
        ActivityScenario.launch(ComposerMotionProbeActivity::class.java).use { scenario ->
            scenario.onActivity { activity -> activity.setContent {
                LodyTheme {
                    val density = LocalDensity.current
                    SideEffect {
                        expected[0] = with(density) { LodySize.controlSm.roundToPx() }
                        expected[1] = with(density) { LodySize.controlLg.roundToPx() }
                        expected[2] = expected[1]
                    }
                    fun bounds(index: Int) = Modifier.onGloballyPositioned {
                        sizes[index] = it.size
                        positions[index] = it.positionInRoot().x
                        laidOut.countDown()
                    }
                    Row {
                        LodyFilledIconButton({}, bounds(0).size(LodySize.controlSm)) {
                            Icon(LodyIcons.Send, null, Modifier.size(LodyIconSize.sm))
                        }
                        LodyIconButton({}, bounds(1)) {
                            Icon(LodyIcons.Plus, null, Modifier.size(LodyIconSize.md))
                        }
                        LodyFilledIconButton({}, bounds(2).size(LodySize.controlLg), enabled = false) {
                            Icon(LodyIcons.Compose, null, Modifier.size(LodyIconSize.lg))
                        }
                    }
                }
            } }
            assertTrue("All controls laid out", laidOut.await(5, TimeUnit.SECONDS))
            expected.forEachIndexed { i, size -> assertEquals("Control $i keeps its bounds", IntSize(size, size), sizes[i]) }
            assertEquals("Small send control does not displace its neighbor", expected[0].toFloat(), positions[1] - positions[0], 0.5f)
            assertEquals("No implicit spacing is added", expected[1].toFloat(), positions[2] - positions[1], 0.5f)
        }
    }
}
