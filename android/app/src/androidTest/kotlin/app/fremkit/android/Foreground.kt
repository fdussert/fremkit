package app.fremkit.android

import android.app.Activity
import android.content.Intent
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage

/**
 * Brings the app to the front, unpaired (the welcome screen), and returns its activity once
 * resumed, or null after 10 s.
 *
 * The WebView tests need it: a WebView in an app that is not in front gets no script time on the
 * tablet, and the pages never answer. Unpaired first, so the app's own screens never show a
 * dashboard in the test process: a pin change after one would restart the process
 * ([PinChangeGuard]), the tests with it.
 */
fun appInFront(): Activity? {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    val app = context.applicationContext as FremkitApplication
    instrumentation.runOnMainSync {
        app.flow.cancel()
        app.model.forget()
    }
    context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    instrumentation.waitForIdleSync()
    return resumedActivity()
}

/** The app's activity once resumed, or null after 10 s. */
fun resumedActivity(): Activity? {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    repeat(100) {
        var found: Activity? = null
        instrumentation.runOnMainSync {
            found = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).firstOrNull()
        }
        if (found is MainActivity) return found
        Thread.sleep(100)
    }
    return null
}
