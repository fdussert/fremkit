package app.fremkit.android

import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.fremkit.kit.FremkitTXT
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Two Macs found at once are both resolved (fact F2: API 28's NsdManager refuses a second
 * resolution while one is in flight, so [LocalNetwork] queues them). The two services are
 * registered by this test on the tablet itself, with documentation addresses in their TXT records:
 * nothing answers there, so they stay unchecked, which is what a Mac that is not on this network
 * looks like.
 */
@RunWith(AndroidJUnit4::class)
class NsdQueueTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val nsd = context.getSystemService(NsdManager::class.java)
    private val registered = mutableListOf<NsdManager.RegistrationListener>()
    private var network: LocalNetwork? = null

    private fun register(name: String, address: String, port: Int) {
        val info = NsdServiceInfo().apply {
            serviceName = name
            serviceType = LocalNetwork.SERVICE_TYPE
            this.port = port
            setAttribute("a", address)
            setAttribute("p", port.toString())
        }
        val done = CountDownLatch(1)
        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(serviceInfo: NsdServiceInfo) = done.countDown()
            override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = done.countDown()
            override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) = Unit
            override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = Unit
        }
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
        registered += listener
        assertTrue("registration of $name timed out", done.await(10, TimeUnit.SECONDS))
    }

    @After
    fun tearDown() {
        instrumentation.runOnMainSync { network?.stop() }
        registered.forEach { runCatching { nsd.unregisterService(it) } }
    }

    @Test
    fun twoServicesFoundTogetherAreBothResolved() {
        val tag = UUID.randomUUID().toString().take(8)
        val a = "Fremkit test A $tag"
        val b = "Fremkit test B $tag"
        register(a, "192.0.2.21", 18461)
        register(b, "198.51.100.22", 18462)

        instrumentation.runOnMainSync { network = LocalNetwork(context) {}.also { it.start() } }
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        var resolved = emptyMap<String, FremkitTXT?>()
        while (System.nanoTime() < deadline) {
            instrumentation.runOnMainSync {
                resolved = network!!.macs.value.filterKeys { it == a || it == b }.mapValues { it.value.advertised }
            }
            if (resolved.size == 2 && resolved.values.all { it != null }) break
            Thread.sleep(200)
        }
        assertEquals(
            mapOf(a to FremkitTXT("192.0.2.21", 18461), b to FremkitTXT("198.51.100.22", 18462)),
            resolved,
        )
        // Nothing answers at a documentation address: neither is a candidate through its TXT record.
        instrumentation.runOnMainSync {
            val macs = network!!.macs.value
            assertTrue(macs.getValue(a).candidates.none { it.address == "192.0.2.21" })
            assertTrue(macs.getValue(b).candidates.none { it.address == "198.51.100.22" })
        }
    }
}
