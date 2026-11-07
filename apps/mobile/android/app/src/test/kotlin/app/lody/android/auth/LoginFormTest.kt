package app.lody.android.auth

import app.lody.android.auth.LoginForm.Problem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The sign-in page refuses what web `/login` refuses before any request leaves the device. */
class LoginFormTest {
    @Test fun signInNeedsAnEmailAndAnyPassword() {
        assertEquals(Problem.EmailInvalid, LoginForm.problem(false, "", "person", "secret"))
        assertEquals(Problem.EmailInvalid, LoginForm.problem(false, "", "person@example", "secret"))
        assertEquals(Problem.PasswordEmpty, LoginForm.problem(false, "", " person@example.test ", ""))
        // Legacy passwords are not checked against the new-password rules.
        assertNull(LoginForm.problem(false, "", "person@example.test", "x"))
    }

    @Test fun createAccountAppliesTheSharedPasswordRules() {
        assertEquals(Problem.NameRequired, LoginForm.problem(true, " ", "person@example.test", "password1"))
        assertEquals(Problem.PasswordTooShort, LoginForm.problem(true, "Jane", "person@example.test", "pass1"))
        assertEquals(Problem.PasswordComplexity, LoginForm.problem(true, "Jane", "person@example.test", "synthetic-password"))
        assertEquals(Problem.PasswordComplexity, LoginForm.problem(true, "Jane", "person@example.test", "12345678"))
        assertEquals(Problem.PasswordTooLong, LoginForm.problem(true, "Jane", "person@example.test", "a1".repeat(65)))
        assertNull(LoginForm.problem(true, "Jane", "person@example.test", "synthetic-password-1"))
    }
}
