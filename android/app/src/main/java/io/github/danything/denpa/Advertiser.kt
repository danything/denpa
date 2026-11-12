package io.github.danything.denpa

import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log

/**
 * **LAN の denpa にエージェントを知らせる** (mDNS / DNS-SD。docs/agent.md「LAN で見つける」)。
 * Wi-Fi でマルチキャストを受けるにはアプリの MulticastLock が要るので、子プロセスのエージェントでなくアプリが `NsdManager` で知らせる (ほかの OS はエージェントが自分で。Mdns.cs)。
 *
 * 知らせるのは `_denpa-agent._tcp` とポート、TXT の `v=1`・`id` (証明書の指紋の先頭 16 字)・`name` (端末の名前) だけで、**合言葉は入れない**。
 * アドレスとホストの名前は Android が付ける (denpa は答えの A を使う)。指紋が変わったら (鍵を作り直した) 知らせ直す。
 * [update] は [DenpaService] の worker のスレッドで、[stop] は終了のときに呼ぶ
 */
internal class Advertiser(private val nsd: NsdManager) {
    private var listener: NsdManager.RegistrationListener? = null
    private var advertised: String? = null

    /** 知らせる。同じ指紋で知らせていれば何もしない */
    @Synchronized
    fun update(fingerprint: String, name: String, port: Int) {
        val id = fingerprint.take(16)
        if (advertised == id) return
        stop()
        val info = NsdServiceInfo().apply {
            serviceName = instanceName(name, id)
            serviceType = SERVICE_TYPE
            setPort(port)
            for ((key, value) in txt(id, name)) setAttribute(key, value)
        }
        val next = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(info: NsdServiceInfo) {
                Log.i(DenpaService.TAG, "LAN に知らせます (mDNS: ${info.serviceName})")
            }

            override fun onRegistrationFailed(info: NsdServiceInfo, code: Int) {
                Log.w(DenpaService.TAG, "LAN に知らせられませんでした (NsdManager: $code)。denpa には登録用の URL で登録できます")
            }

            override fun onServiceUnregistered(info: NsdServiceInfo) = Unit

            override fun onUnregistrationFailed(info: NsdServiceInfo, code: Int) = Unit
        }
        try {
            nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, next)
        } catch (error: RuntimeException) {
            Log.w(DenpaService.TAG, "LAN に知らせられませんでした (NsdManager)", error)
            return
        }
        listener = next
        advertised = id
    }

    /** 取り下げる (終了のとき) */
    @Synchronized
    fun stop() {
        val current = listener ?: return
        listener = null
        advertised = null
        runCatching { nsd.unregisterService(current) }
    }

    companion object {
        const val SERVICE_TYPE = "_denpa-agent._tcp"

        /**
         * インスタンスの名前。`名前 (指紋の先頭 8 字)` で、エージェントの Mdns.InstanceName と同じ作り。
         * `.` と `\` は `-` にし、63 バイトに収まるよう名前を字の切れ目で詰める
         */
        fun instanceName(name: String, id: String): String {
            val suffix = " (${id.take(8)})"
            val clean = name.replace('.', '-').replace('\\', '-').trim()
            return truncate(clean, 63 - suffix.toByteArray().size) + suffix
        }

        /** TXT の中身。`name` は 250 バイトまで */
        fun txt(id: String, name: String): List<Pair<String, String>> =
            listOf("v" to "1", "id" to id, "name" to truncate(name, 250))

        private fun truncate(text: String, bytes: Int): String {
            var used = 0
            var end = 0
            while (end < text.length) {
                val point = text.codePointAt(end)
                val size = String(Character.toChars(point)).toByteArray().size
                if (used + size > bytes) break
                used += size
                end += Character.charCount(point)
            }
            return text.substring(0, end)
        }
    }
}
