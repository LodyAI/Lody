plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose.compiler)
}

android {
    namespace = "app.lody.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "ai.lody.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
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
