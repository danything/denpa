package io.github.danything.denpa

import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.net.Inet4Address

/**
 * denpa と組む URL。エージェントの `--pair` は `https://<機械の名前>:25252#pair=<合言葉>` を出すが、Android では機械の名前が `localhost` になる。
 * アプリが LAN のアドレス (Wi-Fi か有線の IPv4) に置き換える (docs/install-android.md)
 */
internal object PairUrl {
    private val host = Regex("""^(https://)(\[[^\]]*]|[^:/#\[]+)(?=[:/#]|$)""")

    /** URL の機械の名前を [address] に替える。形が違えば null */
    fun withHost(url: String, address: String): String? {
        val trimmed = url.trim()
        val match = host.find(trimmed) ?: return null
        val written = if (address.contains(':')) "[$address]" else address
        return match.groupValues[1] + written + trimmed.substring(match.range.last + 1)
    }

    /** いまの既定のネットワークが Wi-Fi か有線なら、その IPv4 のアドレス。無ければ null */
    fun lanAddress(connectivity: ConnectivityManager): String? {
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
}
