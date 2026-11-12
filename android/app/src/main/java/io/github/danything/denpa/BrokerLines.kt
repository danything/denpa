package io.github.danything.denpa

/**
 * USB_BROKER のソケットでエージェントへ送る行 (docs/agent.md「Android でアプリから USB を受け取る」)。
 * 1 行 1 つの JSON で、終わりの改行まで含めた UTF-8 のバイト列を返す。**送る側は 1 行を 1 回の write で送る** ([UsbBroker])
 */
internal object BrokerLines {
    /** (構成の値, インターフェースの番号, bInterfaceClass) */
    data class Interface(val config: Int, val number: Int, val kind: Int)

    /** 許可を得て開いた機材。この行の write に fd を 1 つ付ける。null の文字列は書かない */
    fun attached(
        name: String,
        vendor: Int,
        product: Int,
        serial: String?,
        manufacturer: String?,
        productName: String?,
        interfaces: List<Interface>,
    ): ByteArray = line(
        buildString {
            append("{\"type\":\"attached\",\"name\":").append(quote(name))
            append(",\"vendor\":").append(vendor).append(",\"product\":").append(product)
            serial?.let { append(",\"serial\":").append(quote(it)) }
            manufacturer?.let { append(",\"manufacturer\":").append(quote(it)) }
            productName?.let { append(",\"productName\":").append(quote(it)) }
            append(",\"interfaces\":[")
            interfaces.joinTo(this, ",") { "{\"config\":${it.config},\"number\":${it.number},\"class\":${it.kind}}" }
            append("]}")
        },
    )

    /** 抜かれた機材。fd は付けない */
    fun detached(name: String): ByteArray = line("{\"type\":\"detached\",\"name\":${quote(name)}}")

    /** 許可のある機材を全部送り終えた印。繋ぐたびに最後に送る */
    val synced: ByteArray get() = line("{\"type\":\"synced\"}")

    private fun line(json: String) = (json + "\n").toByteArray(Charsets.UTF_8)

    /** JSON の文字列。制御文字は \u で書く (機材の文字列に改行が入っていても 1 行に収める) */
    fun quote(text: String): String = buildString {
        append('"')
        for (c in text) {
            when {
                c == '"' -> append("\\\"")
                c == '\\' -> append("\\\\")
                c < ' ' || c == '\u2028' || c == '\u2029' -> append("\\u%04x".format(c.code))
                else -> append(c)
            }
        }
        append('"')
    }
}
