package app.fremkit.android

import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import app.fremkit.kit.PairedMac
import app.fremkit.kit.PairingLink
import app.fremkit.kit.PairingStep
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A `fremkit://pair` link opened by another app (a `VIEW` intent) always waits for the user's
 * word, paired or not: any installed app can send one. Nothing is sent to the Mac before the user
 * confirms (the flow stays idle).
 *
 * The intents are sent as another app would, with `startActivity`, not through `ActivityScenario`,
 * which does not follow a `singleTask` activity into its own task.
 */
@RunWith(AndroidJUnit4::class)
class IntentLinkTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val app = context.applicationContext as FremkitApplication

    /** The shared vectors' link (test-vectors/devices.json): public test data, documentation addresses. */
    private val url = "fremkit://pair?h=studio.local&a=192.0.2.10&p=4243&c=ABCDEFGH" +
        "&s=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE&k=Y4nRTFWKfvKwllWID7DQPMgZIF8SqUUvgWkQZsK_ArQ"

    private fun onMain(block: () -> Unit) = instrumentation.runOnMainSync(block)

    private fun open(link: String) {
        context.startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse(link)).setPackage(context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        instrumentation.waitForIdleSync()
    }

    /** The link waiting for the user's word, once there is one (null after 5 s). */
    private fun pending(): PairingLink? {
        repeat(50) {
            var link: PairingLink? = null
            onMain { link = app.flow.pendingLink }
            if (link != null) return link
            Thread.sleep(100)
        }
        return null
    }

    @Before
    fun unpaired() = onMain {
        app.flow.cancel()
        app.model.forget()
    }

    @After
    fun cleanUp() {
        onMain {
            app.flow.cancel()
            app.model.forget()
            ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).forEach { it.finish() }
        }
        instrumentation.waitForIdleSync()
    }

    @Test
    fun anIntentLinkAsksWhenUnpaired() {
        open(url)
        assertNotNull(resumedActivity())
        assertEquals(PairingLink.parse(url), pending())
        onMain {
            assertEquals(PairingStep.Idle, app.flow.step)
            assertNull(app.model.mac.value)
            // No: nothing changes.
            app.flow.declineLink()
            assertNull(app.flow.pendingLink)
            assertEquals(PairingStep.Idle, app.flow.step)
            assertNull(app.model.mac.value)
        }
    }

    @Test
    fun anIntentLinkAsksWhenPaired() {
        val paired = PairedMac(
            host = "kitchen.local", address = "198.51.100.7", port = 4243,
            keyHash = "Y4nRTFWKfvKwllWID7DQPMgZIF8SqUUvgWkQZsK_ArQ", token = "intent-test-token-not-a-secret",
            deviceId = "intent-test-device", name = "kitchen",
        )
        onMain { app.model.pair(paired) }
        open(url)
        assertNotNull(resumedActivity())
        assertEquals(PairingLink.parse(url), pending())
        onMain {
            assertEquals(PairingStep.Idle, app.flow.step)
            app.flow.declineLink()
            assertEquals(paired.deviceId, app.model.mac.value?.deviceId)
        }
    }

    @Test
    fun aLinkToTheRunningActivityAsksToo() {
        context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val first = resumedActivity()
        assertNotNull(first)
        onMain { assertNull(app.flow.pendingLink) }
        // singleTask: the link reaches the same activity through onNewIntent.
        open(url)
        assertEquals(PairingLink.parse(url), pending())
        assertEquals(first, resumedActivity())
    }

    @Test
    fun anythingElseIsIgnored() {
        open("fremkit://pair?h=studio.local")
        assertNotNull(resumedActivity())
        assertNull(pending())
        onMain { assertEquals(PairingStep.Idle, app.flow.step) }
    }
}
