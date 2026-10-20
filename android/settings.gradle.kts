// The Fremkit Android app: a pure-JVM kit (the protocol, tested on any JVM) and the app over it.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "fremkit-android"
include(":fremkit-kit", ":app")
