package app.lody.android.runtime

import org.junit.Assert.*
import org.junit.Test

class RuntimeHealthTest {
    @Test fun startupAndHeartbeatHaveDifferentDeadlines() {
        val health = RuntimeHealth()
        health.started(100)
        assertFalse(health.timedOut(20_099))
        assertTrue(health.timedOut(20_100))
        health.acknowledged(21_000)
        assertFalse(health.timedOut(28_999))
        assertTrue(health.timedOut(29_000))
    }
    @Test fun backgroundTimeDoesNotConsumeHeartbeatBudget() {
        val health = RuntimeHealth()
        health.started(0)
        health.acknowledged(1)
        health.suspend()
        assertFalse(health.timedOut(600_000))
        health.resume(600_000)
        assertFalse(health.timedOut(607_999))
        assertTrue(health.timedOut(608_000))
    }
    @Test fun automaticRecoveryIsBoundedAndWindowExpires() {
        val health = RuntimeHealth()
        assertTrue(health.allowRestart(0))
        assertTrue(health.allowRestart(1))
        assertTrue(health.allowRestart(2))
        assertFalse(health.allowRestart(3))
        assertTrue(health.allowRestart(60_000))
        assertFalse(health.allowRestart(60_000))
    }
}
