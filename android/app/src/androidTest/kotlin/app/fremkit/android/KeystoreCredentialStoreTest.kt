package app.fremkit.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.fremkit.kit.PairedMac
import app.fremkit.kit.UnreadableCredentialsException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyStore

/**
 * The pairing store on the tablet: a round trip through the Keystore, a file that is app-private,
 * out of backups and does not hold the token in clear, and "something stored but unreadable" told
 * apart from "not paired". Its own file and key alias, so a real pairing is never touched.
 */
@RunWith(AndroidJUnit4::class)
class KeystoreCredentialStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val alias = "fremkit-pairing-test"
    private val fileName = "pairing-test.bin"
    private lateinit var store: KeystoreCredentialStore

    private val mac = PairedMac(
        host = "studio.local",
        address = "192.0.2.10",
        port = 4243,
        keyHash = "AAH-_wABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhs",
        token = "test-token-0123456789abcdefghijklmnopqrstuvwxyz",
        deviceId = "device-1",
        name = "studio",
        addresses = listOf("192.0.2.11", "198.51.100.7"),
    )

    @Before
    fun setUp() {
        deleteKey()
        store = KeystoreCredentialStore(context, fileName, alias)
        store.clear()
    }

    @After
    fun tearDown() {
        store.clear()
        deleteKey()
    }

    private fun deleteKey() {
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias)
    }

    @Test
    fun nothingStoredIsNotPaired() {
        assertNull(store.load())
    }

    @Test
    fun roundTrip() {
        store.save(mac)
        assertEquals(mac, store.load())
        // Another instance reads what this one wrote: the key lives in the Keystore, not in memory.
        assertEquals(mac, KeystoreCredentialStore(context, fileName, alias).load())
    }

    @Test
    fun clearForgets() {
        store.save(mac)
        store.clear()
        assertNull(store.load())
        assertFalse(store.file.exists())
    }

    @Test
    fun theFileIsPrivateOutOfBackupsAndEncrypted() {
        store.save(mac)
        val file = store.file
        assertTrue(file.isFile)
        assertEquals(context.noBackupFilesDir.canonicalPath, file.parentFile!!.canonicalPath)
        val bytes = file.readBytes()
        val text = String(bytes, Charsets.ISO_8859_1)
        assertFalse("the token is in clear", text.contains(mac.token))
        assertFalse("the pin is in clear", text.contains(mac.keyHash))
        assertFalse("the host is in clear", text.contains(mac.host))
    }

    @Test
    fun aCorruptFileIsUnreadableAndKept() {
        store.save(mac)
        val bytes = store.file.readBytes()
        bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 0x01).toByte()
        store.file.writeBytes(bytes)
        expectUnreadable()
        assertTrue("the file was left alone", store.file.exists())
    }

    @Test
    fun aLostKeyIsUnreadableNotUnpaired() {
        store.save(mac)
        deleteKey()
        expectUnreadable()
        assertTrue(store.file.exists())
        // Pairing again replaces it, under a new key.
        store.save(mac)
        assertEquals(mac, store.load())
    }

    @Test
    fun garbageIsUnreadable() {
        store.file.parentFile!!.mkdirs()
        store.file.writeBytes(byteArrayOf(9, 9, 9))
        expectUnreadable()
    }

    private fun expectUnreadable() {
        try {
            store.load()
            fail("load() should have thrown")
        } catch (e: UnreadableCredentialsException) {
            assertFalse(e.message.orEmpty().contains(mac.token))
            assertNull(e.cause)
        }
    }
}
