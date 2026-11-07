package app.lody.android.runtime

import org.junit.Assert.*
import org.junit.Test

class GrantLifetimeTest {
    @Test fun receiptAgeReducesLifetimeAndExpiredGrantCannotBeDelivered() {
        val grant = ShortLivedGrant("fixture", "https://streams.example.org", 60, receivedAtNanos = 0)
        assertEquals(25, grant.remainingSeconds(35_000_000_000))
        assertEquals(0, grant.remainingSeconds(61_000_000_000))
        assertFalse(grant.toString().contains("fixture"))
    }
}
