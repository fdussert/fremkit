// The Android app: Compose screens and one WebView over the kit.
import org.gradle.api.artifacts.result.ResolvedComponentResult
import org.gradle.api.artifacts.result.ResolvedDependencyResult

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// The version users see is the Mac's, from the root package.json: no fifth `version` field to bump.
val fremkitVersion: String = providers.fileContents(rootProject.layout.projectDirectory.file("../package.json"))
    .asText
    .map { Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(it)?.groupValues?.get(1) ?: error("package.json has no version") }
    .get()

// The commit count of HEAD, as the iPad's build number: a release from main always goes up.
val commitCount: Int = providers.exec {
    commandLine("/usr/bin/git", "rev-list", "--count", "HEAD")
    isIgnoreExitValue = true
}.standardOutput.asText.get().trim().toIntOrNull() ?: 1

android {
    namespace = "app.fremkit.android"
    compileSdk = libs.versions.compileSdk.get().toInt()
    buildToolsVersion = libs.versions.buildTools.get()

    defaultConfig {
        applicationId = "app.fremkit.android"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = commitCount
        versionName = fremkitVersion
    }

    buildTypes {
        debug {
            // Installs beside a release build.
            applicationIdSuffix = ".debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // No signingConfig: Gradle never sees the release key or its password.
            // scripts/build-android.sh release signs the unsigned APK with apksigner.
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures { compose = true }
}

dependencies {
    implementation(project(":fremkit-kit"))
    implementation(platform(libs.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.compose.ui)
    testImplementation(libs.junit)
}

// No Google Play services, Firebase, ML Kit or analytics SDK in the app, ever: the tablet talks to
// the Mac and to nobody else. A transitive dependency must not bring one in quietly.
tasks.register("checkNoPlayServices") {
    group = "verification"
    description = "Fails if the release runtime classpath holds Google Play services or an analytics SDK."
    // Local to the task, so the configuration cache does not have to serialize the script.
    val bannedGroups = listOf(
        "com.google.android.gms", "com.google.firebase", "com.google.mlkit", "com.google.android.play",
        "com.google.android.datatransport", "com.crashlytics", "io.fabric", "com.facebook",
        "com.amplitude", "com.mixpanel", "io.sentry", "com.segment", "com.appsflyer", "com.adjust",
        "com.flurry", "com.onesignal", "com.bugsnag", "com.newrelic", "com.datadoghq",
    )
    inputs.property("banned", bannedGroups)
    // Looked up when the task is configured: AGP creates the variant configurations late.
    val releaseRoot = configurations.named("releaseRuntimeClasspath")
        .flatMap { it.incoming.resolutionResult.rootComponent }
    doLast {
        val seen = mutableSetOf<ResolvedComponentResult>()
        val stack = ArrayDeque(listOf(releaseRoot.get()))
        val found = sortedSetOf<String>()
        while (stack.isNotEmpty()) {
            val component = stack.removeLast()
            if (!seen.add(component)) continue
            val module = component.moduleVersion
            if (module != null && bannedGroups.any { module.group == it || module.group.startsWith("$it.") }) {
                found += "${module.group}:${module.name}:${module.version}"
            }
            component.dependencies.filterIsInstance<ResolvedDependencyResult>().forEach { stack.add(it.selected) }
        }
        if (found.isNotEmpty()) {
            throw GradleException("banned libraries in releaseRuntimeClasspath:\n  " + found.joinToString("\n  "))
        }
        logger.lifecycle("checkNoPlayServices: ${seen.size} components, none banned")
    }
}
