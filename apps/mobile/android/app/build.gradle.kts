plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose.compiler)
}

// Shared, non-executable .env.local parser; shell environment takes precedence.
val backendJson = providers.exec {
    commandLine("node", rootProject.file("../backend-config.mjs").absolutePath)
}.standardOutput.asText.get()
val backends = groovy.json.JsonSlurper().parseText(backendJson) as Map<*, *>

android {
    namespace = "app.lody.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "ai.lody.android"
        // Public OAuth Web client ID, never a client secret. Empty disables Google clearly.
        val googleClient = providers.gradleProperty("LODY_GOOGLE_WEB_CLIENT_ID").orElse("").get()
        require(googleClient.matches(Regex("[A-Za-z0-9._-]*")))
        buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", "\"$googleClient\"")
        for (key in listOf("CONVEX_URL", "CONVEX_SITE_URL", "CF_WORKER_URL", "STORAGE_SUFFIX")) {
            val name = if (key == "STORAGE_SUFFIX") "BACKEND_STORAGE_SUFFIX" else key
            buildConfigField("String", name, groovy.json.JsonOutput.toJson(backends[key]))
        }
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "ONESIGNAL_APP_ID", "\"${providers.gradleProperty("LODY_ONESIGNAL_APP_ID").getOrElse("e383bf31-7c8e-4641-b3f6-3486e77b9a82")}\"")
        // Public Firebase client options, never a service-account key.
        for (key in listOf("APP_ID", "API_KEY", "PROJECT_ID", "SENDER_ID")) {
            buildConfigField("String", "FIREBASE_$key", "\"${providers.gradleProperty("LODY_FIREBASE_$key").getOrElse("")}\"")
        }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures { compose = true; buildConfig = true }

    buildTypes {
        create("m3e") {
            initWith(getByName("debug"))
            applicationIdSuffix = ".m3e"
            versionNameSuffix = "-m3e-preview"
            matchingFallbacks += listOf("debug")
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.credentials)
    implementation(libs.credentials.play)
    implementation(libs.googleid)
    implementation(libs.browser)
    implementation(libs.onesignal)
    implementation(libs.firebase.messaging)
    implementation(libs.okhttp)
    implementation(libs.webkit)
    implementation(libs.coroutines.android)
    implementation(libs.lifecycle.process)
    implementation(libs.lifecycle.runtime)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.json.test)
    androidTestImplementation(libs.test.core)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.runtime)
    implementation(libs.activity.compose)
    implementation(libs.compose.material3)
    implementation(libs.compose.foundation)
    // Chat transcript: QuickJS runs the shared remend repair; Markdown renders per block.
    implementation(libs.quickjs)
    testImplementation(libs.quickjs.jvm)
    implementation(libs.markdown.parser)
    implementation(libs.markdown.renderer.m3)
    implementation(libs.markdown.renderer.code)
    testImplementation(libs.junit)
    androidTestImplementation(libs.test.runner)
    androidTestImplementation(libs.test.junit)
}

abstract class RuntimeAssets : Exec() {
    @get:OutputDirectory abstract val mainAssets: DirectoryProperty
    @get:OutputDirectory abstract val debugAssets: DirectoryProperty
}
val generateRuntimeAssets = tasks.register<RuntimeAssets>("generateRuntimeAssets") {
    workingDir(rootProject.file("runtime"))
    commandLine("node", "build.mjs")
    inputs.dir(rootProject.file("runtime/vendor"))
    inputs.dir(rootProject.file("runtime/src"))
    inputs.file(rootProject.file("runtime/build.mjs"))
    inputs.file(rootProject.file("../shared/markdown-repair/entry.js"))
    inputs.file(rootProject.file("runtime/snapshot.mjs"))
    inputs.file(rootProject.file("runtime/package-lock.json"))
    mainAssets.set(layout.buildDirectory.dir("generated/runtime/main"))
    debugAssets.set(layout.buildDirectory.dir("generated/runtime/debug"))
}
androidComponents.onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(generateRuntimeAssets) { it.mainAssets }
    if (variant.buildType == "debug") {
        variant.sources.assets?.addGeneratedSourceDirectory(generateRuntimeAssets) { it.debugAssets }
    }
}

tasks.withType<Test>().configureEach {
    // Unit tests run the shipped remend bundle in the JVM QuickJS engine.
    dependsOn(generateRuntimeAssets)
    val markdownRepair = layout.buildDirectory.file("generated/runtime/main/markdown/MarkdownRepair.js")
    inputs.file(markdownRepair)
    systemProperty("markdown.repair", markdownRepair.get().asFile.absolutePath)
    inputs.file(rootProject.file("runtime/contract/fixtures.json"))
    systemProperty("runtime.fixtures", rootProject.file("runtime/contract/fixtures.json").absolutePath)
}
