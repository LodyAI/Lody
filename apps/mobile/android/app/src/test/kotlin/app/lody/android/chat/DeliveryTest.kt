package app.lody.android.chat

import org.junit.Assert.assertEquals
import org.junit.Test

class DeliveryTest {
    @Test fun agentClaimedTurnsRemainDeliveredThroughExecution() {
        for (status in listOf("seen", "processing", "handled", "failed", "canceled")) {
            assertEquals(status, Delivery.Seen, delivery(status))
        }
    }

    @Test fun unconfirmedTurnsDoNotClaimDelivery() {
        for (status in listOf("", "prepared", "pending", "pending_apply", "delivery_unknown")) {
            assertEquals(status, Delivery.Sent, delivery(status))
        }
        assertEquals(Delivery.Queued, delivery("queued"))
        assertEquals(Delivery.Failed, delivery("not_sent"))
    }
}
