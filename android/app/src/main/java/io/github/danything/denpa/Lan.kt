package io.github.danything.denpa

import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.net.Inet4Address

/** 端末の LAN のアドレス。通知に出す denpa の URL (`http://<アドレス>:3000`) に使う (docs/install-android.md) */
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
}
