package io.github.danything.denpa

import android.annotation.SuppressLint
import org.json.JSONObject
import java.io.File
import java.net.Socket
import java.net.URL
import java.security.KeyFactory
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedTrustManager

/** 通知に出すエージェントの様子。[tuners] は無効にしていないチューナーの台数 */
internal data class AgentStatus(val tuners: Int, val recording: Boolean) {
    companion object {
        /**
         * `GET /denpa/tuners` の本文を読む。**録画中は、どれかのチューナーの利用者 (`users`) の `use` が `rec` か `rec ` で始まるとき**
         * (エージェントの `TunerPool.Recording` と同じ決め方。止まれの合図で録画を待つのもこれ)
         */
        fun parse(body: String): AgentStatus {
            val list = JSONObject(body).getJSONArray("tuners")
            var tuners = 0
            var recording = false
            for (index in 0 until list.length()) {
                val tuner = list.getJSONObject(index)
                if (!tuner.optBoolean("disabled", false)) tuners++
                val users = tuner.optJSONArray("users") ?: continue
                for (at in 0 until users.length()) {
                    val use = users.optJSONObject(at)?.optString("use").orEmpty()
                    if (use == "rec" || use.startsWith("rec ")) recording = true
                }
            }
            return AgentStatus(tuners, recording)
        }
    }
}

/**
 * 動いているエージェントの `GET /denpa/tuners` を、エージェント自身の鍵と証明書 (`config/tls/agent.key`・`agent.crt`) で読む。
 * `denpa-agent --status` と同じ読み方で、エージェントは自分の証明書で来た相手を組んだ denpa と同じに通す (AgentTls.Decide)。
 * サーバの証明書は agent.crt と同じものだけを受ける。鍵はエージェントが最初の起動で作るので、読めるまでは毎回読み直す
 */
internal class AgentClient(private val tlsDir: File, private val port: Int) {
    private var context: Pair<SSLContext, ByteArray>? = null

    /** 読めなければ例外 (起動の途中、止まっている、鍵がまだ無い)。次は鍵から読み直す (鍵を作り直されても追える) */
    fun status(): AgentStatus = try {
        read()
    } catch (error: Exception) {
        context = null
        throw error
    }

    private fun read(): AgentStatus {
        val (ssl, expected) = context ?: load().also { context = it }
        val connection = URL("https://127.0.0.1:$port/denpa/tuners").openConnection() as HttpsURLConnection
        try {
            connection.sslSocketFactory = ssl.socketFactory
            // 名前でなく証明書そのもので確かめる (下の trust と同じ指紋)
            connection.setHostnameVerifier { _, session ->
                session.peerCertificates.firstOrNull()?.let { sha256(it.encoded).contentEquals(expected) } == true
            }
            connection.connectTimeout = 5_000
            connection.readTimeout = 5_000
            val code = connection.responseCode
            check(code == 200) { "GET /denpa/tuners: $code" }
            return AgentStatus.parse(connection.inputStream.bufferedReader().use { it.readText() })
        } finally {
            connection.disconnect()
        }
    }

    private fun load(): Pair<SSLContext, ByteArray> {
        val certificate = File(tlsDir, "agent.crt").inputStream().use {
            CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate
        }
        // ECDSA P-256 の PKCS#8 の PEM (AgentTls.CreateIdentity)
        val pem = File(tlsDir, "agent.key").readText()
        val der = Base64.getMimeDecoder().decode(pem.lines().filterNot { it.startsWith("-----") }.joinToString(""))
        val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(der))
        val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null)
            setKeyEntry("agent", key, CharArray(0), arrayOf(certificate))
        }
        val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store, CharArray(0)) }
        val expected = sha256(certificate.encoded)
        val ssl = SSLContext.getInstance("TLS").apply { init(keys.keyManagers, arrayOf(PinnedTrust(expected)), null) }
        return ssl to expected
    }

    /**
     * サーバの証明書が agent.crt と同じときだけ受ける (自己署名なので、端末の認証局では確かめられない)。
     * こちらはサーバにならないので、クライアントの証明書は受けない
     */
    @SuppressLint("CustomX509TrustManager")
    private class PinnedTrust(private val expected: ByteArray) : X509ExtendedTrustManager() {
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            val leaf = chain?.firstOrNull() ?: throw CertificateException("サーバの証明書がありません")
            if (!sha256(leaf.encoded).contentEquals(expected)) throw CertificateException("サーバの証明書が agent.crt と違います")
        }

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) =
            checkServerTrusted(chain, authType)

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) =
            checkServerTrusted(chain, authType)

        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) =
            throw CertificateException("クライアントの証明書は受けません")

        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) =
            checkClientTrusted(chain, authType)

        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) =
            checkClientTrusted(chain, authType)

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    private companion object {
        fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
    }
}
