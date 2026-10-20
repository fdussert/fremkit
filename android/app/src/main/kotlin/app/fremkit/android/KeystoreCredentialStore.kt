package app.fremkit.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import app.fremkit.kit.CredentialStore
import app.fremkit.kit.PairedMac
import app.fremkit.kit.UnreadableCredentialsException
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The pairing, stored the iPad's way: readable after the first unlock, never leaving this tablet.
 *
 * The [PairedMac] JSON is encrypted with AES-256-GCM under a key the Android Keystore generates and
 * never lets out (no user authentication, so it works while the screen is locked once the tablet
 * has been unlocked since boot), and written atomically to the no-backup directory, which no
 * backup and no device-to-device transfer copies (the manifest excludes everything else too).
 *
 * File layout: one version byte, the 12-byte IV the Keystore chose, the ciphertext and its tag.
 *
 * [load] throws [UnreadableCredentialsException] when a file is there but cannot be decrypted (the
 * key gone after a lock-screen reset on some vendors, a corrupt file): the app then shows the
 * welcome screen and leaves the file alone, as `KeychainCredentialStore` does. Nothing here logs,
 * and no exception it throws quotes the record or keeps a cause that might.
 *
 * @param fileName and [keyAlias]: the app's own by default; the instrumented test uses others, so
 *   it never touches a real pairing.
 */
class KeystoreCredentialStore(
    context: Context,
    fileName: String = FILE_NAME,
    private val keyAlias: String = KEY_ALIAS,
) : CredentialStore {
    /** Where the pairing lives: app-private, out of every backup. */
    val file: File = File(context.noBackupFilesDir, fileName)

    private val atomic = AtomicFile(file)
    private val lock = Any()

    override fun load(): PairedMac? = synchronized(lock) {
        val bytes = try {
            atomic.readFully()
        } catch (_: FileNotFoundException) {
            return null
        } catch (_: IOException) {
            throw UnreadableCredentialsException("the stored pairing could not be read")
        }
        val json = try {
            decrypt(bytes)
        } catch (_: GeneralSecurityException) {
            throw UnreadableCredentialsException("the stored pairing could not be decrypted")
        } catch (_: IllegalArgumentException) {
            throw UnreadableCredentialsException("the stored pairing could not be decrypted")
        }
        PairedMac.fromJson(json)
    }

    override fun save(mac: PairedMac): Unit = synchronized(lock) {
        val bytes = try {
            encrypt(mac.toJson())
        } catch (_: GeneralSecurityException) {
            throw IOException("the pairing could not be encrypted")
        }
        val out = atomic.startWrite()
        try {
            out.write(bytes)
            atomic.finishWrite(out)
        } catch (e: IOException) {
            atomic.failWrite(out)
            throw e
        }
    }

    override fun clear(): Unit = synchronized(lock) {
        atomic.delete()
    }

    private fun encrypt(json: String): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key(create = true))
        val iv = cipher.iv
        check(iv.size == IV_BYTES) { "unexpected IV size" }
        val sealed = cipher.doFinal(json.toByteArray(Charsets.UTF_8))
        return byteArrayOf(VERSION) + iv + sealed
    }

    private fun decrypt(bytes: ByteArray): String {
        if (bytes.size <= 1 + IV_BYTES || bytes[0] != VERSION) {
            throw GeneralSecurityException("not a stored pairing")
        }
        val key = key(create = false) ?: throw GeneralSecurityException("no key")
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, bytes, 1, IV_BYTES))
        val plain = cipher.doFinal(bytes, 1 + IV_BYTES, bytes.size - 1 - IV_BYTES)
        return String(plain, Charsets.UTF_8)
    }

    /** The Keystore key, made on first use when [create]; null when there is none and none is to be made. */
    private fun key(create: Boolean): SecretKey? {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        if (!create) return null
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    companion object {
        const val FILE_NAME = "pairing.bin"
        const val KEY_ALIAS = "fremkit-pairing"
        private const val KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val VERSION: Byte = 1
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
    }
}
