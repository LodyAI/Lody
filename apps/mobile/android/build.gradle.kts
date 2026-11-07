buildscript {
    dependencies {
        // Built-in Kotlin uses the newest Kotlin Gradle plugin on the build classpath.
        classpath(libs.kotlin.gradle.plugin)
    }
}

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.compose.compiler) apply false
}
