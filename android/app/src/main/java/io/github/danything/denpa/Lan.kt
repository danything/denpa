package io.github.danything.denpa

import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.net.Inet4Address

/**
 * 端末の LAN のアドレスと、通知から渡す URL (docs/install-android.md)。
 * denpa の URL は `http://<アドレス>:3000`、別の機械の denpa がエージェントと組む URL は `https://<アドレス>:25252#pair=<合言葉>`
 * (エージェントの `--pair` は機械の名前を使うが、Android では `localhost` になるので、アプリが LAN のアドレスで作る)
 */
internal object Lan {
    /** いまの既定のネットワークが Wi-Fi か有線なら、その IPv4 のアドレス。無ければ null */
    fun address(connectivity: ConnectivityManager): String? {
        val network = connectivity.activeNetwork ?: return null
        val capabilities = connectivity.getNetworkCapabilities(network) ?: return null
        if (!capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
            !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        ) {
            return null
        }
        return connectivity.getLinkProperties(network)?.linkAddresses
            ?.map { it.address }
            ?.firstOrNull { it is Inet4Address && !it.isLoopbackAddress }
            ?.hostAddress
    }

    /** 別の機械の denpa の `TUNER_AGENT_URL` に書く URL。IPv6 のアドレスは角括弧で囲む */
    fun pairUrl(address: String, port: Int, token: String): String {
        val host = if (address.contains(':')) "[$address]" else address
        return "https://$host:$port#pair=$token"
    }
}
