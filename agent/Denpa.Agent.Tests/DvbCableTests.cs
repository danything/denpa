using TUnit.Assertions.Enums;

namespace Denpa.Agent.Tests;

/*
 * DVB の機材で ISDB-C を受けるところ (DvbTuner・DvbCable・DeviceProbe)。カーネルの ioctl は呼べないので、
 * 選局で渡す property の並びと、受けられる方式から種別を決めるところと、dvr から読んだ TS を TSMF の処理に通すところ (偽の dvr) を確かめる。
 * Annex A・Annex C の DVB-C の機材で実際に受けられるかは、実機で確かめていない。
 *
 * **固まったら失敗にする。** 各テストは最初に `await Task.Yield()` する
 */
[Timeout(60_000)]
public class DvbCableTests
{
    /// <summary>
    /// 偽の dvr。<paramref name="next"/> が返す塊をつなげたバイト列を、188 バイトの区切りに揃えずに 1,000 バイトずつ返す。
    /// <paramref name="next"/> が null を返したら尽きる (0 を返す)。止める合図が立っていたら 0 を返す
    /// </summary>
    private sealed class FakeDvr(Func<byte[]?> next)
    {
        private byte[] _pending = [];
        private int _at;

        public int Read(byte[] buffer, int offset, int count, Func<bool> giveUp)
        {
            if (giveUp()) return 0;
            Thread.Sleep(1);
            if (_at == _pending.Length)
            {
                if (next() is not { } chunk) return 0;
                _pending = chunk;
                _at = 0;
            }
            var taken = Math.Min(Math.Min(count, 1000), _pending.Length - _at);
            _pending.AsSpan(_at, taken).CopyTo(buffer.AsSpan(offset));
            _at += taken;
            return taken;
        }
    }

    /// <summary>TSMF の搬送波の TS (相対 TS 番号 2 と 3 が有効で、スロットを交互に使う)。1 回で 4 フレーム</summary>
    private static Func<byte[]?> TsmfCarrier()
    {
        var slots = TsmfFake.Alternate();
        var frame = 0;
        return () =>
        {
            var chunk = new List<byte>();
            for (var i = 0; i < 4; i++, frame++)
            {
                chunk.AddRange(TsmfFake.Header(slots, TsmfFake.Valid2And3));
                foreach (var packet in TsmfFake.Frame(slots, frame % 600)) chunk.AddRange(packet);
            }
            return [.. chunk];
        };
    }

    /// <summary>ヘッダーの無い搬送波の TS。1 回で 200 パケット。<paramref name="chunks"/> 回で尽きる</summary>
    private static Func<byte[]?> PlainCarrier(int chunks = int.MaxValue)
    {
        var number = 0;
        var left = chunks;
        return () => left-- <= 0 ? null : [.. Enumerable.Range(0, 200).SelectMany(_ => TsmfFake.Packet(0x100, number++ & 0x7FFF))];
    }

    /// <summary>出口から <paramref name="count"/> パケットを読む (5 秒で打ち切る)</summary>
    private static List<byte[]> Read(Stream output, int count)
    {
        var buffer = new byte[count * 188];
        var used = 0;
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (used < buffer.Length && DateTime.UtcNow < deadline) used += output.Read(buffer, used, buffer.Length - used);
        return [.. Enumerable.Range(0, used / 188).Select(i => buffer.AsSpan(i * 188, 188).ToArray())];
    }

    [Test]
    public async Task TSMF_の搬送波から_k_本目の_TS_だけを流す()
    {
        await Task.Yield();
        var dvr = new FakeDvr(TsmfCarrier());
        var tsmf = new TsmfSelector(1);
        var cable = new DvbCable(dvr.Read, tsmf, new SplitTlv(), "test");
        try
        {
            await Assert.That(tsmf.Wait(5_000)).IsEqualTo(TsmfDecision.Selected);
            // 有効な TS は相対 TS 番号 2 と 3。1 本目 (0 から数える) は 3
            await Assert.That(tsmf.Relative).IsEqualTo(3);
            await Assert.That(tsmf.Streams).IsEqualTo(2);
            var packets = Read(cable.Output, 60);
            await Assert.That(packets.Count).IsEqualTo(60);
            await Assert.That(packets.All(packet => packet[0] == 0x47 && TsmfFake.Pid(packet) == 0x300)).IsTrue();
        }
        finally
        {
            cable.Stop();
        }
        // 止めたら出口を閉じる。読む側は、残っているぶんを読み終えると尽きる (理由は付けない)
        await Assert.That(cable.Closed).IsTrue();
        var rest = new byte[188 * 1024];
        var deadline = DateTime.UtcNow.AddSeconds(5);
        var last = -1;
        while (last != 0 && DateTime.UtcNow < deadline) last = cable.Output.Read(rest, 0, rest.Length);
        await Assert.That(last).IsEqualTo(0);
    }

    [Test]
    public async Task ヘッダーの無い搬送波は_0_本目の指定でそのまま流す()
    {
        await Task.Yield();
        var tsmf = new TsmfSelector(0);
        var cable = new DvbCable(new FakeDvr(PlainCarrier()).Read, tsmf, new SplitTlv(), "test");
        try
        {
            await Assert.That(tsmf.Wait(5_000)).IsEqualTo(TsmfDecision.Passthrough);
            var packets = Read(cable.Output, 30);
            await Assert.That(packets.Count).IsEqualTo(30);
            // 188 バイトに揃えずに読んだ dvr からも、続きの番号で流れる (途中を落とさない)
            await Assert.That(packets.Zip(packets.Skip(1)).All(pair => TsmfFake.Number(pair.Second) == ((TsmfFake.Number(pair.First) + 1) & 0x7FFF))).IsTrue();
        }
        finally
        {
            cable.Stop();
        }
    }

    [Test]
    public async Task dvr_が尽きたら_読む側に理由を伝えて終える()
    {
        await Task.Yield();
        var tsmf = new TsmfSelector(0, discard: 0);
        // ヘッダーの無い搬送波と決めるのに 424 パケット要る。600 パケットで尽きる
        var cable = new DvbCable(new FakeDvr(PlainCarrier(chunks: 3)).Read, tsmf, new SplitTlv(), "test");
        try
        {
            await Assert.That(tsmf.Wait(5_000)).IsEqualTo(TsmfDecision.Passthrough);
            var buffer = new byte[188 * 1024];
            var error = Assert.Throws<IOException>(() =>
            {
                var deadline = DateTime.UtcNow.AddSeconds(5);
                while (DateTime.UtcNow < deadline && cable.Output.Read(buffer, 0, buffer.Length) > 0)
                {
                }
            });
            await Assert.That(error.Message).IsEqualTo(DvbCable.Ended);
            await Assert.That(cable.Closed).IsTrue();
        }
        finally
        {
            cable.Stop();
        }
    }

    [Test]
    public async Task TS_が届かなければ判定は決まらず_届かない文で失敗にする()
    {
        await Task.Yield();
        var tsmf = new TsmfSelector(0);
        var cable = new DvbCable(new FakeDvr(() => []).Read, tsmf, new SplitTlv(), "test");
        try
        {
            var decision = tsmf.Wait(100);
            await Assert.That(decision).IsEqualTo(TsmfDecision.Pending);
            // 1 パケットも届かないのは、電波ではなく dvr から先で止まっている。同期しなかった文とは分ける (IT930x の受信機と同じ扱い)
            await Assert.That(It930xTuner.TsmfFailure(tsmf, decision, DvbTuner.TsMissing)).IsEqualTo(DvbTuner.TsMissing);
        }
        finally
        {
            cable.Stop();
        }
    }

    [Test]
    public async Task ISDB_C_は_64QAM_5274_kbaud_で_中心周波数を渡す()
    {
        await Task.Yield();
        var qc51 = ChannelTable.Parse("QC51")!;
        // linux/dvb/frontend.h の番号: DTV_DELIVERY_SYSTEM 17、DTV_FREQUENCY 3、DTV_MODULATION 4 (QAM_64 = 3)、DTV_SYMBOL_RATE 8、DTV_INVERSION 6 (INVERSION_AUTO = 2)、DTV_TUNE 1
        await Assert.That(DvbTuner.CableProperties(ChannelTable.SysDvbcAnnexA, qc51.Frequency)).IsEquivalentTo(new List<(uint, uint)>
        {
            (17, 1), (3, 393_000_000), (4, 3), (8, 5_274_000), (6, 2), (1, 0),
        }, CollectionOrdering.Matching);
        await Assert.That(DvbTuner.CableProperties(ChannelTable.SysDvbcAnnexC, qc51.Frequency)[0]).IsEqualTo(((uint)17, (uint)18));
        // 256QAM (QAM_256 = 5) と QAM_AUTO (6) も渡せる
        await Assert.That(DvbTuner.CableProperties(ChannelTable.SysDvbcAnnexA, qc51.Frequency, DvbTuner.Qam256)[2]).IsEqualTo(((uint)4, (uint)5));
        await Assert.That(DvbTuner.CableProperties(ChannelTable.SysDvbcAnnexA, qc51.Frequency, DvbTuner.QamAuto)[2]).IsEqualTo(((uint)4, (uint)6));
    }

    [Test]
    public async Task ISDB_C_の変調は_復調器が見分けられれば_QAM_AUTO_を_見分けられなければ_64QAM_と_256QAM_を試す()
    {
        await Task.Yield();
        // linux/dvb/frontend.h の FE_CAN_QAM_AUTO = 0x10000。J:COM の回線には 256QAM の搬送波 (QC26) があった
        await Assert.That(DvbTuner.CableModulations(0x10000 | 0x2000)).IsEquivalentTo(new[] { DvbTuner.QamAuto }, CollectionOrdering.Matching);
        await Assert.That(DvbTuner.CableModulations(0x2000 | 0x8000)).IsEquivalentTo(new[] { DvbTuner.Qam64, DvbTuner.Qam256 }, CollectionOrdering.Matching);
        await Assert.That(DvbTuner.CableModulations(0)).IsEquivalentTo(new[] { DvbTuner.Qam64, DvbTuner.Qam256 }, CollectionOrdering.Matching);
        // dvb_frontend_info の caps は末尾の 4 バイト (168 バイトのうち 164 から)
        var info = new byte[168];
        BitConverter.TryWriteBytes(info.AsSpan(164), 0x10000u);
        await Assert.That(DeviceProbe.ParseCaps(info)).IsEqualTo(0x10000u);
    }

    [Test]
    public async Task Annex_C_があればそれを_無ければ_Annex_A_を使う()
    {
        await Task.Yield();
        // linux/dvb/frontend.h の enum fe_delivery_system: SYS_DVBC_ANNEX_A 1、SYS_DVBC_ANNEX_B 2、SYS_ISDBT 8、SYS_DVBC_ANNEX_C 18
        await Assert.That(ChannelTable.SysDvbcAnnexA).IsEqualTo(1);
        await Assert.That(ChannelTable.SysDvbcAnnexB).IsEqualTo(2);
        await Assert.That(ChannelTable.SysDvbcAnnexC).IsEqualTo(18);
        await Assert.That(DeviceProbe.CableSystem([8, 1, 18])).IsEqualTo(18);
        await Assert.That(DeviceProbe.CableSystem([8, 1])).IsEqualTo(1);
        // J.83B (Annex B) では受けない
        await Assert.That(DeviceProbe.CableSystem([8, 2])).IsNull();
    }

    [Test]
    public async Task CATV_は受けられる種別にだけ入れ_見つけたときには選ばない()
    {
        await Task.Yield();
        // ISDB-T と DVB-C (Annex A) を受けられる機材
        await Assert.That(DeviceProbe.TypesFor([8, 1])).IsEquivalentTo(["GR"], CollectionOrdering.Matching);
        await Assert.That(DeviceProbe.ReceivableFor([8, 1])).IsEquivalentTo(["GR", ChannelTable.Catv], CollectionOrdering.Matching);
        var both = DeviceProbe.Frontend("adapter0", "/dev/dvb/adapter0/frontend0", ["GR"], ["GR", ChannelTable.Catv])!;
        await Assert.That(both.Types).IsEquivalentTo(["GR"], CollectionOrdering.Matching);
        await Assert.That(both.Disabled).IsFalse();
        // DVB-C しか受けられない機材は、CATV を選んで「使う」をオフにして並べる
        var cableOnly = DeviceProbe.Frontend("adapter1", "/dev/dvb/adapter1/frontend0", DeviceProbe.TypesFor([1, 3]), DeviceProbe.ReceivableFor([1, 3]))!;
        await Assert.That(cableOnly.Types).IsEquivalentTo([ChannelTable.Catv], CollectionOrdering.Matching);
        await Assert.That(cableOnly.Disabled).IsTrue();
        // 日本の放送のどれも受けられない機材は並べない
        await Assert.That(DeviceProbe.Frontend("adapter2", "/dev/dvb/adapter2/frontend0", DeviceProbe.TypesFor([3, 16]), DeviceProbe.ReceivableFor([3, 16]))).IsNull();
    }

    [Test]
    [NotInParallel(nameof(DeviceProbe))]
    public async Task 受けられる種別は_見つけたときの種別に_CATV_を足して返す()
    {
        await Task.Yield();
        DeviceProbe.Remember(
            [
                new TunerSpec("adapter0", ["GR"], false, "/dev/dvb/adapter0/frontend0"),
                new TunerSpec("adapter1", [ChannelTable.Catv], true, "/dev/dvb/adapter1/frontend0"),
                new TunerSpec("adapter2", ["BS", "CS"], false, "/dev/dvb/adapter2/frontend0"),
            ],
            ["/dev/dvb/adapter0/frontend0", "/dev/dvb/adapter1/frontend0"]);
        try
        {
            await Assert.That(DeviceProbe.Receivable("/dev/dvb/adapter0/frontend0")).IsEquivalentTo(["GR", ChannelTable.Catv], CollectionOrdering.Matching);
            await Assert.That(DeviceProbe.Receivable("/dev/dvb/adapter1/frontend0")).IsEquivalentTo([ChannelTable.Catv], CollectionOrdering.Matching);
            await Assert.That(DeviceProbe.Receivable("/dev/dvb/adapter2/frontend0")).IsEquivalentTo(["BS", "CS"], CollectionOrdering.Matching);
        }
        finally
        {
            DeviceProbe.Remember([]);
        }
    }
}
