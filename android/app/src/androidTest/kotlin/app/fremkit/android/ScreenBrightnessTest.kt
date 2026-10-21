package app.fremkit.android

import android.provider.Settings
import android.view.WindowManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The Mac's brightness target lands on the activity's window, never on the system level; the
 * system level changing (the user's slider) drops it. The system setting itself is only read
 * here: the change is announced on its URI, as the settings provider does, without writing it.
 */
@RunWith(AndroidJUnit4::class)
class ScreenBrightnessTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val app = context.applicationContext as FremkitApplication
    private lateinit var activity: MainActivity

    private fun onMain(block: () -> Unit) = instrumentation.runOnMainSync(block)

    private fun windowLevel(): Float {
        var level = 0f
        onMain { level = activity.window.attributes.screenBrightness }
        return level
    }

    /** The window's level once it is [expected], or whatever it is after 5 s. */
    private fun awaitWindowLevel(expected: Float): Float {
        repeat(50) {
            if (windowLevel() == expected) return expected
            Thread.sleep(100)
        }
        return windowLevel()
    }

    @Before
    fun setUp() {
        val front = appInFront()
        assertNotNull("the app did not come to the front", front)
        activity = front as MainActivity
        // Starts from the system level: no override left by another test.
        onMain { app.brightness.systemChanged() }
    }

    @After
    fun tearDown() = onMain { app.brightness.systemChanged() }

    @Test
    fun aTargetSetsTheWindowNotTheSystem() {
        val system = Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS)
        onMain { app.brightness.receive(40.0, 7001) }
        assertEquals(0.4f, windowLevel())
        onMain { assertEquals(0.4, app.brightness.levels.read(), 1e-9) }
        assertEquals(system, Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS))
    }

    @Test
    fun theSameSeqIsAppliedOnce() {
        onMain { app.brightness.receive(40.0, 7002) }
        onMain { app.brightness.systemChanged() }
        onMain { app.brightness.receive(40.0, 7002) }
        assertEquals(WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE, windowLevel())
        onMain { app.brightness.receive(60.0, 7003) }
        assertEquals(0.6f, windowLevel())
    }

    @Test
    fun aSystemChangeDropsTheOverride() {
        onMain { app.brightness.receive(25.0, 7004) }
        assertEquals(0.25f, windowLevel())
        // What the settings provider does when the user moves the slider.
        context.contentResolver.notifyChange(Settings.System.getUriFor(Settings.System.SCREEN_BRIGHTNESS), null)
        assertEquals(WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE, awaitWindowLevel(WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE))
        val system = Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS)
        onMain { assertEquals(system / 255.0, app.brightness.levels.read(), 1e-9) }
    }

    @Test
    fun aModeChangeDropsItToo() {
        onMain { app.brightness.receive(80.0, 7005) }
        context.contentResolver.notifyChange(Settings.System.getUriFor(Settings.System.SCREEN_BRIGHTNESS_MODE), null)
        assertEquals(WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE, awaitWindowLevel(WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE))
    }
}
