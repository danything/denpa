package io.github.danything.denpa

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/* LAN に知らせる名前と TXT (Advertiser)。エージェントの Mdns.InstanceName・Mdns.Txt (agent/Denpa.Agent.Tests/MdnsTests.cs) と同じ作り */
class AdvertiserTest {
    private val id = "0123456789abcdef"

    @Test
    fun instanceNameAddsFingerprintAndFitsOneLabel() {
        assertEquals("居間 (01234567)", Advertiser.instanceName("居間", id))
        assertEquals("tuner-local (01234567)", Advertiser.instanceName("tuner.local", id))
        val long = Advertiser.instanceName("あ".repeat(40), id)
        assertTrue(long.toByteArray().size <= 63)
        assertTrue(long.endsWith(" (01234567)"))
    }

    @Test
    fun txtHasOnlyVersionIdAndName() {
        assertEquals(listOf("v" to "1", "id" to id, "name" to "居間"), Advertiser.txt(id, "居間"))
    }
}
