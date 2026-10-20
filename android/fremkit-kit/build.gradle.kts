// The kit: the pairing protocol, the pin, the connection logic. Pure Kotlin/JVM, no android.*,
// so every test runs on any JVM and reads the same vectors as the server's and the Swift kit's.
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions { jvmTarget = JvmTarget.JVM_17 }
}

sourceSets {
    // The shared protocol vectors, read in place: one file for vitest, XCTest and JUnit.
    test { resources.srcDir("../../test-vectors") }
}

tasks.processResources {
    // The fingerprint's word list, taken from the server rather than copied a third time.
    from("../../server/src/devices/fingerprint-words.txt")
}

dependencies {
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.kotlinx.serialization.json)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
