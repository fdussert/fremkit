// Plugins are declared here once, with the versions pinned in gradle/libs.versions.toml, and
// applied by the modules. The Kotlin plugin on this classpath is also the one AGP's built-in
// Kotlin compiles the app with.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
