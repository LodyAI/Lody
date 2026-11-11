package app.lody.android.chat

import app.lody.android.runtime.*
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DevicePreviewsTest {
    private val pixel = PreviewDevice("Pixel_8", "Pixel 8", "API 35", "phone", "Booted", true)
    private fun preview(phase: String, url: String? = null) =
        DevicePreviewState("op", "Pixel_8", phase, "remote", url)

    @Test fun reopeningResumesARunningPreviewAndPollsUntilReady() = runTest {
        val phases = ArrayDeque(listOf("booting", "connecting", "ready"))
        val calls = mutableListOf<DeviceCommand>()
        val session = DevicePreviewSession(DevicePlatform.ANDROID, { command ->
            calls += command
            when (command) {
                is DeviceCommand.Status -> DeviceControlReply(true, preview = preview(if (command.operationId == null) "preparing" else phases.removeFirst(), "https://a-b.trycloudflare.com/v"))
                DeviceCommand.Devices -> DeviceControlReply(true, devices = listOf(pixel))
                else -> error("no writes on resume")
            }
        }, backgroundScope)
        session.open()
        advanceUntilIdle()
        assertEquals("ready", session.phase)
        assertEquals("Pixel 8", session.name)
        assertEquals("https://a-b.trycloudflare.com/v", session.viewerUrl)
        assertTrue(calls.none { it is DeviceCommand.Start || it is DeviceCommand.Stop })
    }

    @Test fun refusedStartFailsWithTheComputersReasonAndIsNotRetried() = runTest {
        var starts = 0
        val session = DevicePreviewSession(DevicePlatform.ANDROID, { command ->
            when (command) {
                is DeviceCommand.Start -> { starts++; assertEquals("balanced", command.quality); DeviceControlReply(false, error = "unsupported") }
                else -> DeviceControlReply(true, devices = listOf(pixel))
            }
        }, backgroundScope)
        session.start(pixel)
        advanceUntilIdle()
        assertEquals("failed", session.phase)
        assertEquals("unsupported", session.failure?.code)
        assertEquals(1, starts)
    }

    @Test fun stopEndsTheOperationThenListsDevicesAgain() = runTest {
        val calls = mutableListOf<DeviceCommand>()
        val session = DevicePreviewSession(DevicePlatform.IOS, { command ->
            calls += command
            when (command) {
                is DeviceCommand.Start -> DeviceControlReply(true, preview = preview("ready", "https://a-b.trycloudflare.com/v"))
                is DeviceCommand.Status -> DeviceControlReply(true)
                is DeviceCommand.Stop -> DeviceControlReply(true)
                DeviceCommand.Devices -> DeviceControlReply(true, devices = listOf(pixel))
            }
        }, backgroundScope)
        session.start(pixel)
        advanceUntilIdle()
        assertEquals("ready", session.phase)
        session.stop()
        advanceUntilIdle()
        assertEquals("closed", session.phase)
        assertEquals(DeviceCommand.Stop("op"), calls.first { it is DeviceCommand.Stop })
        assertEquals(listOf(pixel), session.devices)
        assertNull((calls.first { it is DeviceCommand.Start } as DeviceCommand.Start).quality)
    }
}
