namespace Denpa.Agent.Tests;

/*
 * TS パケットの先頭を探す共通の処理 (TsSync.cs)。NativeTsFramer・SianoTsAligner・Mb86h47Framer・Descrambler が使う。
 * 見つからなかったときに返す位置で、呼ぶ側が持ち越すバイトと捨てたバイトの数が決まるので、その位置も確かめる。
 */
public class TsSyncTests
{
    private static byte[] Packets(int count, int offset = 0, int unit = 188)
    {
        var data = new byte[count * unit];
        for (var i = 0; i < count; i++) data[i * unit + offset] = 0x47;
        return data;
    }

    [Test]
    public async Task FindPair_は_0x47_が_stride_おきに_2_つ続く最初の位置を返す()
    {
        // 先頭に中身の 0x47 が 1 つだけある 50 バイト
        var junk = new byte[50];
        junk[10] = 0x47;
        byte[] data = [.. junk, .. Packets(3)];
        await Assert.That(TsSync.FindPair(data, 0, 188)).IsEqualTo(50);
        await Assert.That(TsSync.FindPair(data, 50, 188)).IsEqualTo(50);
        await Assert.That(TsSync.FindPair(data, 51, 188)).IsEqualTo(238);
    }

    [Test]
    public async Task FindPair_は_offset_の位置の_0x47_で揃える()
    {
        // 4 バイトの到着時刻 + 188 バイトの TS の 192 バイトの単位。途中の 96 バイトから始まる
        var units = Packets(3, offset: 4, unit: 192);
        var data = units[96..];
        var found = TsSync.FindPair(data, 0, 192, 4);
        await Assert.That(found).IsEqualTo(96);
        await Assert.That(data[found + 4]).IsEqualTo((byte)0x47);
    }

    [Test]
    public async Task FindPair_は_2_つ目がまだ届いていなければ_候補にできない最初の位置を返す()
    {
        // 1 パケットと 100 バイト。2 つ目の 0x47 が無い
        byte[] data = [.. Packets(1), .. new byte[100]];
        var found = TsSync.FindPair(data, 0, 188);
        await Assert.That(found).IsEqualTo(data.Length - 188);
        await Assert.That(found + 188 < data.Length).IsFalse();
        // 2 つ目の位置の直前で切れていれば、まだ候補にしない
        byte[] cut = [0, .. Packets(1)];
        await Assert.That(TsSync.FindPair(cut, 0, 188)).IsEqualTo(1);
        // 始める位置がすでに先なら、その位置
        await Assert.That(TsSync.FindPair(data, 150, 188)).IsEqualTo(150);
        await Assert.That(TsSync.FindPair(new byte[10], 0, 188)).IsEqualTo(0);
        await Assert.That(TsSync.FindPair(new byte[10], 0, 192, 4)).IsEqualTo(0);
    }

    [Test]
    public async Task FindSingle_は_残りが_188_バイト以上ある最初の_0x47_を返す()
    {
        byte[] data = [0, 0, 0, .. Packets(2)];
        await Assert.That(TsSync.FindSingle(data, 0)).IsEqualTo(3);
        // 0x47 が無ければ、残りが 188 バイトを切った最初の位置
        var none = new byte[300];
        await Assert.That(TsSync.FindSingle(none, 0)).IsEqualTo(300 - 187);
        await Assert.That(TsSync.FindSingle(none, 200)).IsEqualTo(200);
        // 残りが 188 バイトを切ったところの 0x47 は返さない
        none[150] = 0x47;
        await Assert.That(TsSync.FindSingle(none, 0)).IsEqualTo(300 - 187);
    }

    [Test]
    public async Task RunEnd_は_先頭が_0x47_のパケットが続く範囲の終わりを返す()
    {
        byte[] data = [.. Packets(3), 1, 2, .. Packets(1)];
        await Assert.That(TsSync.RunEnd(data, 0)).IsEqualTo(188 * 3);
        // 先頭が 0x47 でなければ進めない
        await Assert.That(TsSync.RunEnd(data, 188 * 3)).IsEqualTo(188 * 3);
        // 188 バイトに満たない端数は範囲に入れない
        await Assert.That(TsSync.RunEnd(Packets(2)[..300], 0)).IsEqualTo(188);
    }
}
