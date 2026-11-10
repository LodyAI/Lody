package app.lody.android.auth

import android.content.Context

/**
 * Pure rules of the sign-in page, as web `login-page.tsx`: what an email submission needs before
 * any request, and which method this device last completed (web `last-login-method.ts`).
 */
internal object LoginForm {
    enum class Problem { EmailInvalid, PasswordEmpty, NameRequired, PasswordTooShort, PasswordTooLong, PasswordComplexity }

    fun isEmail(value: String): Boolean {
        val parts = value.split("@")
        if (parts.size != 2 || parts[0].isEmpty() || value.length > 254 || value.any { it.isWhitespace() }) return false
        val domain = parts[1]
        return domain.contains('.') && !domain.startsWith('.') && !domain.endsWith('.')
    }

    /** Sign-in only needs a password (legacy passwords stay valid); creating one applies web `validateNewPassword`. */
    fun problem(register: Boolean, name: String, email: String, password: String): Problem? = when {
        !isEmail(email.trim()) -> Problem.EmailInvalid
        password.isEmpty() -> Problem.PasswordEmpty
        !register -> null
        name.isBlank() -> Problem.NameRequired
        password.length < 8 -> Problem.PasswordTooShort
        password.length > 128 -> Problem.PasswordTooLong
        password.none { it in 'a'..'z' || it in 'A'..'Z' } || password.none { it in '0'..'9' } -> Problem.PasswordComplexity
        else -> null
    }
}

/** The sign-in method shown as "Last used". Display only: it never selects or starts a method. */
internal enum class LastLoginMethod { GitHub, Google, Apple, Discord, Email;
    companion object {
        private const val PREFS = "lody.auth"
        private const val KEY = "lastLoginMethod"
        fun of(provider: BrowserProvider) = when (provider) {
            BrowserProvider.GitHub -> GitHub
            BrowserProvider.Discord -> Discord
            BrowserProvider.Apple -> Apple
        }
        fun read(context: Context): LastLoginMethod? =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
                ?.let { stored -> entries.firstOrNull { it.name == stored } }
        fun write(context: Context, method: LastLoginMethod) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, method.name).apply()
        }
    }
}
