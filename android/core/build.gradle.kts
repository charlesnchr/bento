import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// Platform-independent logic shared by the app: the sync protocol's documents and
// state machines (notes, todos, voice), text merging, quick-add parsing and the
// Gemini clients. Pure Kotlin/JVM so it is unit tested without a device.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    api(libs.kotlinx.coroutines.core)
    api(libs.kotlinx.serialization.json)
    api(libs.okhttp)

    testImplementation(kotlin("test"))
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    useJUnitPlatform()
    // The live Gemini tests run only with a key: its presence (never its value) is an
    // input, so a cached run without the key can't stand in for one with it.
    inputs.property("geminiKeyPresent", providers.environmentVariable("GEMINI_API_KEY").map { it.isNotBlank() }.orElse(false))
    testLogging { events("failed"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
