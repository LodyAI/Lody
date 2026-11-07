package app.lody.android.auth
import app.lody.android.runtime.ShortLivedGrant
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DeviceFlowTest {
    private val code=DeviceAuthorization("private-device-code","ABCD","https://lody.ai/device",30,2)
    private class Api(val replies: MutableList<TokenPoll>) : CloudAuthApi {
        var calls=0
        override suspend fun authorize()=error("unused")
        override suspend fun poll(code:DeviceAuthorization):TokenPoll { calls++;return replies.removeAt(0) }
        override suspend fun account(credential:Credential)=error("unused")
        override suspend fun grant(credential:Credential,workspaceId:String):ShortLivedGrant=error("unused")
        override suspend fun signOut(credential:Credential)=Unit
    }
    @Test fun pendingAndSlowDownRespectServerPollingInterval()=runTest {
        val api=Api(mutableListOf(TokenPoll.Pending,TokenPoll.SlowDown,TokenPoll.Authorized(Credential("fixture"))))
        val result=DeviceFlow(api){testScheduler.currentTime}.await(code)
        assertEquals("fixture",result.token);assertEquals(11000L,testScheduler.currentTime)
    }
    @Test fun expiryStopsWithoutAnExtraRequest()=runTest {
        val api=Api(mutableListOf(TokenPoll.Pending))
        try {DeviceFlow(api){testScheduler.currentTime}.await(DeviceAuthorization("d","u","https://lody.ai",2,2));fail()}
        catch(e:AuthFailure){assertEquals("code_expired",e.code)}
        assertEquals(0,api.calls)
    }
    @Test fun callerCancellationStopsPolling()=runTest {
        val api=Api(mutableListOf(TokenPoll.Pending))
        val job=launch {DeviceFlow(api){testScheduler.currentTime}.await(code)}
        runCurrent();job.cancelAndJoin();advanceUntilIdle();assertEquals(0,api.calls)
    }
}
