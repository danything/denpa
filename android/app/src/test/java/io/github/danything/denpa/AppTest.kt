package io.github.danything.denpa

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * 端末の要らない部分の単体テスト。USB_BROKER に送る行、denpa と組む URL、通知に出すエージェントの様子
 */
class BrokerLinesTest {
    private fun text(bytes: ByteArray) = bytes.toString(Charsets.UTF_8)

    @Test
    fun attached_は改行で終わる_1_行の_JSON() {
        val line = text(
            BrokerLines.attached(
                "/dev/bus/usb/001/004", 0x0511, 0x084e, "S0001", "PLEX", "PX-MLT5U",
                listOf(BrokerLines.Interface(1, 0, 255), BrokerLines.Interface(1, 1, 11)),
            ),
        )
        assertTrue(line.endsWith("\n"))
        assertEquals(1, line.count { it == '\n' })
        val json = JSONObject(line)
        assertEquals("attached", json.getString("type"))
        assertEquals("/dev/bus/usb/001/004", json.getString("name"))
        assertEquals(0x0511, json.getInt("vendor"))
        assertEquals(0x084e, json.getInt("product"))
        assertEquals("S0001", json.getString("serial"))
        assertEquals("PX-MLT5U", json.getString("productName"))
        val second = json.getJSONArray("interfaces").getJSONObject(1)
        assertEquals(1, second.getInt("config"))
        assertEquals(1, second.getInt("number"))
        assertEquals(11, second.getInt("class"))
    }

    @Test
    fun 無い文字列は書かない() {
        val json = JSONObject(text(BrokerLines.attached("/dev/bus/usb/001/004", 1, 2, null, null, null, emptyList())))
        assertFalse(json.has("serial"))
        assertFalse(json.has("manufacturer"))
        assertFalse(json.has("productName"))
        assertEquals(0, json.getJSONArray("interfaces").length())
    }

    @Test
    fun 機材の文字列に改行や引用符があっても_1_行に収まる() {
        val name = "A\"B\\C\nD\u0001"
        val line = text(BrokerLines.attached("/dev/bus/usb/001/004", 1, 2, null, name, null, emptyList()))
        assertEquals(1, line.count { it == '\n' })
        assertEquals(name, JSONObject(line).getString("manufacturer"))
    }

    @Test
    fun detached_と_synced() {
        assertEquals("{\"type\":\"detached\",\"name\":\"/dev/bus/usb/001/004\"}\n", text(BrokerLines.detached("/dev/bus/usb/001/004")))
        assertEquals("{\"type\":\"synced\"}\n", text(BrokerLines.synced))
    }
}

class PairUrlTest {
    @Test
    fun 機械の名前を_LAN_のアドレスに替える() {
        assertEquals(
            "https://192.168.1.20:25252#pair=abc-_DEF",
            PairUrl.withHost("https://localhost:25252#pair=abc-_DEF\n", "192.168.1.20"),
        )
    }

    @Test
    fun IPv6_は角括弧で囲む() {
        assertEquals("https://[fd00::1]:25252#pair=x", PairUrl.withHost("https://localhost:25252#pair=x", "fd00::1"))
        assertEquals("https://10.0.0.2:25252#pair=x", PairUrl.withHost("https://[::1]:25252#pair=x", "10.0.0.2"))
    }

    @Test
    fun 形が違えば_null() {
        assertNull(PairUrl.withHost("http://localhost:25252#pair=x", "10.0.0.2"))
        assertNull(PairUrl.withHost("", "10.0.0.2"))
    }
}

class AgentStatusTest {
    @Test
    fun 無効にしていないチューナーを数える() {
        val status = AgentStatus.parse(
            """{"tuners":[{"name":"a","disabled":false,"users":[]},{"name":"b","disabled":true},{"name":"c"}],"detected":[]}""",
        )
        assertEquals(AgentStatus(tuners = 2, recording = false), status)
    }

    @Test
    fun 利用者の_use_が_rec_なら録画中() {
        val recording = """{"tuners":[{"name":"a","users":[{"use":"live","priority":1},{"use":"rec 123","priority":5}]}]}"""
        assertTrue(AgentStatus.parse(recording).recording)
        assertTrue(AgentStatus.parse("""{"tuners":[{"name":"a","users":[{"use":"rec"}]}]}""").recording)
        // rec で始まっても、空白で区切っていなければ録画ではない
        assertFalse(AgentStatus.parse("""{"tuners":[{"name":"a","users":[{"use":"recent"}]}]}""").recording)
        assertFalse(AgentStatus.parse("""{"tuners":[{"name":"a","users":[{"use":"epg"}]}]}""").recording)
    }

    @Test
    fun チューナーが無ければ_0_台() {
        assertEquals(AgentStatus(0, false), AgentStatus.parse("""{"tuners":[],"detected":[]}"""))
    }
}

class DeviceFilterTest {
    @Test
    fun 数は_0x_で始まれば_16_進() {
        assertEquals(0x0511, DeviceFilter.number("0x0511"))
        assertEquals(0x0511, DeviceFilter.number("0X0511"))
        assertEquals(11, DeviceFilter.number("11"))
        assertNull(DeviceFilter.number(null))
        assertNull(DeviceFilter.number("0xZZ"))
    }
}
