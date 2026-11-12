package io.github.danything.denpa

import android.content.Context
import android.hardware.usb.UsbDevice
import org.xmlpull.v1.XmlPullParser

/**
 * 許可を求めて開く機材。挿したときにアプリを起こす表 (res/xml/device_filter.xml) と同じものを読む (同じ表を 2 つ持たない)。
 * USB の ID が表にあるか、デバイスかインターフェースのクラスが表のクラス (CCID の 11) なら当たる
 */
internal class DeviceFilter(private val ids: Set<Pair<Int, Int>>, private val classes: Set<Int>) {
    fun matches(device: UsbDevice): Boolean =
        (device.vendorId to device.productId) in ids ||
            device.deviceClass in classes ||
            (0 until device.interfaceCount).any { device.getInterface(it).interfaceClass in classes }

    companion object {
        fun load(context: Context): DeviceFilter {
            val ids = mutableSetOf<Pair<Int, Int>>()
            val classes = mutableSetOf<Int>()
            context.resources.getXml(R.xml.device_filter).use { parser ->
                while (parser.next() != XmlPullParser.END_DOCUMENT) {
                    if (parser.eventType != XmlPullParser.START_TAG || parser.name != "usb-device") continue
                    val vendor = number(parser.getAttributeValue(null, "vendor-id"))
                    val product = number(parser.getAttributeValue(null, "product-id"))
                    val kind = number(parser.getAttributeValue(null, "class"))
                    if (vendor != null && product != null) ids += vendor to product
                    if (kind != null) classes += kind
                }
            }
            return DeviceFilter(ids, classes)
        }

        /** Android の USB の表と同じく、`0x` で始まれば 16 進、ほかは 10 進 */
        fun number(text: String?): Int? = when {
            text == null -> null
            text.startsWith("0x") || text.startsWith("0X") -> text.substring(2).toIntOrNull(16)
            else -> text.toIntOrNull()
        }
    }
}
