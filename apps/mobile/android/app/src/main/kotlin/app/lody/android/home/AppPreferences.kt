package app.lody.android.home

import android.content.Context

/** iOS `LodyPreferences`: what a message sent while the agent works does (queue, or guide the reply). */
object AppPreferences {
    const val QUEUE = "queue"
    const val GUIDE = "guide"
    private const val FILE = "lody.preferences"
    private const val QUEUED = "queuedMessageBehavior"

    fun queuedMessageBehavior(context: Context): String =
        if (context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(QUEUED, QUEUE) == GUIDE) GUIDE else QUEUE

    fun saveQueuedMessageBehavior(context: Context, value: String) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit()
            .putString(QUEUED, if (value == GUIDE) GUIDE else QUEUE).apply()
    }
}
