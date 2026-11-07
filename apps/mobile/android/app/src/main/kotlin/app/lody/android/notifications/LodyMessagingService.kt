package app.lody.android.notifications

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import app.lody.android.LodyApplication
import app.lody.android.home.HomeActivity
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.launch

/** OneSignal owns its marked payloads; only direct FCM notifications are displayed here. */
class LodyMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        val app = application as LodyApplication
        app.applicationScope.launch { app.notifications.refresh() }
    }
    override fun onMessageReceived(message: RemoteMessage) {
        if (message.data.containsKey("custom")) return
        val app = application as LodyApplication
        app.applicationScope.launch {
            if (!app.notifications.canDisplayDirect()) return@launch
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return@launch
            val alert = message.notification ?: return@launch
            val recipient = message.data["recipientUserId"]
            if (recipient.isNullOrBlank() || recipient != app.account.state.value.account?.id) return@launch
            val route = message.data["route"]?.takeIf { PushRoute.fromPath(it) != null }
            val intent = Intent(this@LodyMessagingService, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            route?.let { intent.putExtra("route", it).putExtra("recipientUserId", recipient) }
            val id = message.messageId?.hashCode() ?: message.data.hashCode()
            val pending = PendingIntent.getActivity(this@LodyMessagingService, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val notification = Notification.Builder(this@LodyMessagingService, "lody")
                .setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(alert.title).setContentText(alert.body)
                .setContentIntent(pending).setAutoCancel(true).build()
            getSystemService(NotificationManager::class.java).notify(id, notification)
        }
    }
}
