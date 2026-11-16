package app.lody.android.chat

import android.content.Context
import app.lody.android.BackendEnvironment
import app.lody.android.runtime.RuntimeScope

/**
 * Device-local composer text, per account, workspace and conversation (or the new-chat page),
 * as iOS keeps its composer drafts: leaving the page, the process dying or a restart keeps what
 * was typed until it is sent. Text only; picked attachments are content grants that do not
 * outlive the page. Cleared with the rest of the account's local state at logout.
 */
object ComposerDrafts {
    private const val FILE = "composer-drafts-v1"
    const val CREATE = "create"

    fun session(id: String) = "session:$id"

    private fun preferences(context: Context) =
        context.getSharedPreferences(FILE + BackendEnvironment.storageSuffix, Context.MODE_PRIVATE)

    private fun key(scope: RuntimeScope, target: String) = "${scope.accountId}\u0000${scope.workspaceId}\u0000$target"

    fun read(context: Context, scope: RuntimeScope, target: String): String =
        preferences(context).getString(key(scope, target), null).orEmpty()

    /** Blank text removes the draft. */
    fun write(context: Context, scope: RuntimeScope, target: String, text: String) {
        val editor = preferences(context).edit()
        if (text.isBlank()) editor.remove(key(scope, target)) else editor.putString(key(scope, target), text)
        editor.apply()
    }

    fun clear(context: Context) { preferences(context).edit().clear().apply() }
}
