using System.Buffers.Binary;
using Denpa.Agent;
using TUnit.Core.Enums;

namespace Denpa.Agent.Tests;

/*
 * USB の CCID リーダーを直に叩くところ。
 *
 * 本物のリーダーは無い。ディスクリプタは Gemalto (Gemplus) PC Twin Reader (08e6:3437) の
 * 値で組み (CCID ドライバの readers/GemPCTwin.txt)、リーダーはバルク転送の口ごと偽物にする。
 * 偽物は USB の振る舞い (パケットの倍数で終わるメッセージは ZLP が無いと返らない) も真似る。
 * 実機で当てるのは Ccid.Describe(reset: true)。
 */
public class CcidTests
{
    private static readonly byte[] BcasAtr = Convert.FromHexString("3BF01200FF9181B17C451F0399");

    /// <summary>PC Twin のデバイス + 構成ディスクリプタ (usbfs の fd を読んだときの並び)</summary>
    private static byte[] TwinDescriptors()
    {
        var blob = new List<byte>();
        void U16(int v) => blob.AddRange([(byte)v, (byte)(v >> 8)]);
        void U32(uint v) => blob.AddRange(BitConverter.GetBytes(v));

        // デバイス
        blob.AddRange([18, 1]);
        U16(0x0110);
        blob.AddRange([0, 0, 0, 8]);
        U16(0x08e6);
        U16(0x3437);
        U16(0x0100);
        blob.AddRange([1, 2, 0, 1]);

        // 構成 1。長さは最後に埋める
        var config = blob.Count;
        blob.AddRange([9, 2, 0, 0, 1, 1, 0, 0xA0, 0x32]);
        // インターフェース 0: CCID、エンドポイント 3 本
        blob.AddRange([9, 4, 0, 0, 3, 0x0b, 0, 0, 0]);
        // CCID クラスディスクリプタ (0x36 バイト)
        blob.AddRange([0x36, 0x21]);
        U16(0x0100);
        blob.AddRange([0x00, 0x07]);        // bMaxSlotIndex, bVoltageSupport (5V/3V/1.8V)
        U32(0x03);                          // dwProtocols: T=0, T=1
        U32(4000);                          // dwDefaultClock (kHz)
        U32(4000);                          // dwMaximumClock
        blob.Add(0);                        // bNumClockSupported
        U32(10752);                         // dwDataRate
        U32(344086);                        // dwMaxDataRate
        blob.Add(0);                        // bNumDataRatesSupported
        U32(254);                           // dwMaxIFSD
        U32(0);                             // dwSynchProtocols
        U32(0);                             // dwMechanical
        U32(0x00010230);                    // dwFeatures: TPDU、Fi/Di から速さを自動で、NAD 0 以外可
        U32(271);                           // dwMaxCCIDMessageLength
        blob.AddRange([0x00, 0x00]);        // bClassGetResponse, bClassEnvelope
        U16(0);                             // wLcdLayout
        blob.AddRange([0x00, 0x01]);        // bPINSupport, bMaxCCIDBusySlots
        // bulk OUT 0x01、bulk IN 0x82、interrupt IN 0x83
        blob.AddRange([7, 5, 0x01, 0x02, 64, 0, 0]);
        blob.AddRange([7, 5, 0x82, 0x02, 64, 0, 0]);
        blob.AddRange([7, 5, 0x83, 0x03, 8, 0, 24]);

        var total = blob.Count - config;
        blob[config + 2] = (byte)total;
        blob[config + 3] = (byte)(total >> 8);
        return [.. blob];
    }

    private static CcidInterface Twin => UsbDescriptors.FindCcid(TwinDescriptors(), 1, 0)!;

    [Test]
    public async Task PC_Twin_のディスクリプタを読む()
    {
        var blob = TwinDescriptors();
        await Assert.That(UsbDescriptors.Ids(blob)).IsEqualTo((0x08e6, 0x3437));
        var twin = UsbDescriptors.FindCcid(blob, 1, 0);
        await Assert.That(twin).IsEqualTo(new CcidInterface(0, 0x82, 0x01, 64, 0x00010230, 271, 254, 0x07, 0x03, 4000));
        await Assert.That(twin!.Tpdu).IsTrue();
        await Assert.That(twin.Level).IsEqualTo("TPDU");
        // 構成もインターフェースも番号で選ぶ
        await Assert.That(UsbDescriptors.FindCcid(blob, 2, 0)).IsNull();
        await Assert.That(UsbDescriptors.FindCcid(blob, 1, 1)).IsNull();
    }

    [Test]
    public async Task ioctl_の番号は_64bit_の構造体の大きさで組む()
    {
        await Assert.That(UsbFsPipe.Bulk).IsEqualTo(0xC0185502u);
        await Assert.That(UsbFsPipe.ClaimInterface).IsEqualTo(0x8004550Fu);
        await Assert.That(UsbFsPipe.ReleaseInterface).IsEqualTo(0x80045510u);
    }

    [Test]
    public async Task メッセージを組んで読む()
    {
        var command = CcidMessage.Command(CcidMessage.PowerOn, 5, [], 1);
        await Assert.That(Convert.ToHexString(command)).IsEqualTo("62000000000005010000");
        var xfr = CcidMessage.Command(CcidMessage.XfrBlock, 0xFF, [0xAA, 0xBB], 0, 0x10, 0x00);
        await Assert.That(Convert.ToHexString(xfr)).IsEqualTo("6F0200000000FF001000AABB");

        var reply = CcidMessage.Parse(Convert.FromHexString("80030000000007" + "000001" + "9000FF"));
        await Assert.That(reply.Type).IsEqualTo(CcidMessage.DataBlock);
        await Assert.That(reply.Seq).IsEqualTo((byte)7);
        await Assert.That(reply.Chain).IsEqualTo((byte)1);
        await Assert.That(Convert.ToHexString(reply.Data)).IsEqualTo("9000FF");

        var absent = CcidMessage.Parse(Convert.FromHexString("81000000000001" + "42FE00"));
        await Assert.That(absent.Absent).IsTrue();
        await Assert.That(absent.Failed).IsTrue();
        await Assert.That(CcidMessage.Describe(absent.Error)).IsEqualTo("カードが応答しません");
        Assert.Throws<IOException>(() => CcidMessage.Parse(Convert.FromHexString("80050000000100000000AA")));
    }

    /// <summary>
    /// 偽のリーダー。命令を受けると <c>handler</c> が返す応答を積む。
    /// 読み方が USB として無理なら (ZLP 無しでは返らない・パケットの途中で切る) その場で落とす
    /// </summary>
    private sealed class FakeReader(Func<CcidReply, IEnumerable<byte[]>> handler, int packet = 64) : IBulkPipe
    {
        private readonly Queue<byte[]> _pending = new();
        private byte[]? _current;
        private int _at;
        public List<CcidReply> Commands { get; } = [];
        public bool Disposed { get; private set; }

        public void Write(ReadOnlySpan<byte> data)
        {
            var command = CcidMessage.Parse(data);
            Commands.Add(command);
            foreach (var reply in handler(command)) _pending.Enqueue(reply);
        }

        public int Read(Span<byte> buffer, int timeoutMs)
        {
            if (_current is null && !_pending.TryDequeue(out _current)) throw new IOException("リーダーが応答しません");
            var rest = _current.Length - _at;
            if (buffer.Length > rest && rest % packet == 0) throw new InvalidOperationException("ZLP が来ないので返らない読み方です");
            if (buffer.Length < rest && buffer.Length % packet != 0) throw new InvalidOperationException("パケットの途中で切る読み方です");
            var n = Math.Min(buffer.Length, rest);
            _current.AsSpan(_at, n).CopyTo(buffer);
            _at += n;
            if (_at == _current.Length)
            {
                _current = null;
                _at = 0;
            }
            return n;
        }

        public void Dispose() => Disposed = true;
    }

    /// <summary>応答の形は命令と同じ (頭 10 バイトの 8〜10 バイト目が bmStatus / bError / 3つめ)</summary>
    private static byte[] Reply(byte type, byte seq, byte status, byte error, ReadOnlySpan<byte> data, byte chain = 0) =>
        CcidMessage.Command(type, seq, data, status, error, chain);

    private static byte[] Slot(CcidReply command, byte status = 0x01) => Reply(CcidMessage.SlotStatus, command.Seq, status, 0, []);

    /// <summary>
    /// PC Twin に B-CAS が挿さっているつもりの偽物。カードは I ブロックに <paramref name="answer"/> を返す。
    /// 返す前に時間延長と、番号の違う (前の誰かが残した) 応答を挟む
    /// </summary>
    private static FakeReader TwinWithBcas(byte[] answer)
    {
        var cardNs = 0;
        return new FakeReader(command => command.Type switch
        {
            CcidMessage.PowerOff => [Slot(command)],
            CcidMessage.PowerOn => [Reply(CcidMessage.DataBlock, command.Seq, 0, 0, BcasAtr)],
            CcidMessage.SetParameters => [Reply(CcidMessage.Parameters, command.Seq, 0, 0, command.Data, 1)],
            CcidMessage.XfrBlock when command.Data[1] == 0xC1 =>
                [Reply(CcidMessage.DataBlock, command.Seq, 0, 0, T1Protocol.Block(0xE1, command.Data.AsSpan(3, 1)))],
            CcidMessage.XfrBlock => (byte[][])
                [
                    Reply(CcidMessage.DataBlock, (byte)(command.Seq - 1), 0, 0, [0x00]),
                    Reply(CcidMessage.DataBlock, command.Seq, 0x80, 1, []),
                    Reply(CcidMessage.DataBlock, command.Seq, 0, 0, T1Protocol.Block((byte)(cardNs++ << 6), answer)),
                ],
            _ => throw new InvalidOperationException($"思わぬ命令 0x{command.Type:X2}"),
        });
    }

    [Test]
    public async Task PC_Twin_と_B_CAS()
    {
        // 頭 10 + NAD PCB LEN + 50 + LRC = 64 バイト。パケットちょうどで終わる
        var answer = Enumerable.Range(0, 48).Select(i => (byte)i).Concat(new byte[] { 0x90, 0x00 }).ToArray();
        var reader = TwinWithBcas(answer);
        var link = new CcidLink("PC Twin", reader, Twin);

        await Assert.That(Convert.ToHexString(link.Reset())).IsEqualTo(Convert.ToHexString(BcasAtr));
        // 電圧は選べないリーダーなので 5V から
        await Assert.That(reader.Commands.First(c => c.Type == CcidMessage.PowerOn).Status).IsEqualTo((byte)1);
        // specific mode なので TA1 (0x12) を渡す。LRC・保護時間 0xFF・BWI 4 / CWI 5・IFSC 0x7C
        var parameters = reader.Commands.Single(c => c.Type == CcidMessage.SetParameters);
        await Assert.That(parameters.Status).IsEqualTo((byte)1);
        await Assert.That(Convert.ToHexString(parameters.Data)).IsEqualTo("1210FF45007C00");
        // IFSD は 271 バイトのメッセージに収まる 254 まで上げる
        await Assert.That(link.Ifsd).IsEqualTo(254);

        var response = link.Transmit(Convert.FromHexString("90300000"));
        await Assert.That(Convert.ToHexString(response)).IsEqualTo(Convert.ToHexString(answer));
        await Assert.That(Convert.ToHexString(reader.Commands[^1].Data)).IsEqualTo(Convert.ToHexString(T1Protocol.Block(0x00, Convert.FromHexString("90300000"))));

        link.Dispose();
        await Assert.That(reader.Commands[^1].Type).IsEqualTo(CcidMessage.PowerOff);
        await Assert.That(reader.Disposed).IsTrue();
    }

    [Test]
    public async Task カードが無ければ投げる()
    {
        var reader = new FakeReader(command => command.Type == CcidMessage.PowerOn
            ? [Reply(CcidMessage.SlotStatus, command.Seq, 0x42, CcidMessage.IccMute, [])]
            : [Slot(command, 0x02)]);
        var link = new CcidLink("PC Twin", reader, Twin);
        await Assert.That(Assert.Throws<IOException>(() => link.Reset()).Message).Contains("挿さっていません");
    }

    /// <summary>**ATR を読めずに失敗しても、電源を入れたなら閉じるときに切る**</summary>
    [Test]
    public async Task ATR_が壊れていても閉じるときに電源を切る()
    {
        var reader = new FakeReader(command => command.Type == CcidMessage.PowerOn
            ? [Reply(CcidMessage.DataBlock, command.Seq, 0, 0, [0x3B, 0xFF])]
            : [Slot(command)]);
        var link = new CcidLink("PC Twin", reader, Twin);
        Assert.Throws<IOException>(() => link.Reset());

        var before = reader.Commands.Count;
        link.Dispose();
        await Assert.That(reader.Commands.Count).IsEqualTo(before + 1);
        await Assert.That(reader.Commands[^1].Type).IsEqualTo(CcidMessage.PowerOff);
    }

    [Test]
    public async Task 電圧を下げて試す()
    {
        var reader = new FakeReader(command => command.Type switch
        {
            CcidMessage.PowerOn when command.Status == 1 => [Reply(CcidMessage.SlotStatus, command.Seq, 0x41, CcidMessage.IccMute, [])],
            CcidMessage.PowerOn => [Reply(CcidMessage.DataBlock, command.Seq, 0, 0, BcasAtr)],
            CcidMessage.SetParameters => [Reply(CcidMessage.Parameters, command.Seq, 0, 0, command.Data, 1)],
            CcidMessage.XfrBlock => [Reply(CcidMessage.DataBlock, command.Seq, 0, 0, T1Protocol.Block(0xE1, [0xFE]))],
            _ => [Slot(command)],
        });
        var link = new CcidLink("PC Twin", reader, Twin);
        link.Reset();
        await Assert.That(reader.Commands.Where(c => c.Type == CcidMessage.PowerOn).Select(c => c.Status)).IsEquivalentTo([(byte)1, (byte)2]);
    }

    [Test]
    public async Task APDU_単位のリーダーは連結して送り受ける()
    {
        // メッセージ 20 バイトまで = 1回に 10 バイト。15 バイトの APDU は 10 + 5
        var info = Twin with { Features = CcidInterface.ExtendedApduLevel | CcidInterface.AutoParameters | CcidInterface.AutoVoltage, MaxMessage = 20 };
        var reader = new FakeReader(command => command.Type switch
        {
            CcidMessage.PowerOn => [Reply(CcidMessage.DataBlock, command.Seq, 0, 0, BcasAtr)],
            CcidMessage.XfrBlock when command.Error == 1 => [Reply(CcidMessage.DataBlock, command.Seq, 0, 0, [], 0x10)],
            CcidMessage.XfrBlock when command.Error == 2 => [Reply(CcidMessage.DataBlock, command.Seq, 0, 0, [0xAA, 0xBB], 1)],
            CcidMessage.XfrBlock => [Reply(CcidMessage.DataBlock, command.Seq, 0, 0, [0x90, 0x00], 2)],
            _ => [Slot(command)],
        });
        var link = new CcidLink("APDU", reader, info);
        link.Reset();
        // 自分で決めるリーダーには SetParameters も S(IFS) も送らない。電圧は自動 (0)
        await Assert.That(reader.Commands.Any(c => c.Type == CcidMessage.SetParameters)).IsFalse();
        await Assert.That(reader.Commands.Single(c => c.Type == CcidMessage.PowerOn).Status).IsEqualTo((byte)0);

        var apdu = Enumerable.Range(0, 15).Select(i => (byte)i).ToArray();
        await Assert.That(Convert.ToHexString(link.Transmit(apdu))).IsEqualTo("AABB9000");
        // wLevelParameter (bError の位置 = 9 バイト目) が 1 → 2 → 0x10
        var xfr = reader.Commands.Where(c => c.Type == CcidMessage.XfrBlock).ToList();
        await Assert.That(xfr.Select(c => c.Error)).IsEquivalentTo([(byte)1, (byte)2, (byte)0x10]);
        await Assert.That(xfr[0].Data.Length).IsEqualTo(10);
    }

    [Test]
    // Linux の置き場の形 (sysfs の名前の「:」、/dev のパス) を見るもの。Windows では作れない
    [ExcludeOn(OS.Windows)]
    public async Task sysfs_から_CCID_のインターフェースだけ拾う()
    {
        var root = Path.Combine(Path.GetTempPath(), $"denpa-ccid-{Guid.NewGuid():N}");
        void Write(string dir, string name, string value)
        {
            Directory.CreateDirectory(Path.Combine(root, dir));
            File.WriteAllText(Path.Combine(root, dir, name), value + "\n");
        }
        try
        {
            Write("4-11", "busnum", "4");
            Write("4-11", "devnum", "7");
            Write("4-11", "idVendor", "08e6");
            Write("4-11", "idProduct", "3437");
            Write("4-11", "manufacturer", "Gemplus");
            Write("4-11", "product", "USB SmartCard Reader");
            Write("4-11:1.0", "bInterfaceClass", "0b");
            Write("4-11:1.0", "bInterfaceNumber", "00");
            // HID の機材は拾わない
            Write("1-2", "busnum", "1");
            Write("1-2", "devnum", "2");
            Write("1-2", "idVendor", "046d");
            Write("1-2", "idProduct", "c077");
            Write("1-2:1.0", "bInterfaceClass", "03");
            Write("1-2:1.0", "bInterfaceNumber", "00");

            var found = Ccid.Find(root, Path.Combine(root, "dev"));
            await Assert.That(found.Select(c => c.Name)).IsEquivalentTo(["Gemplus USB SmartCard Reader (usb 4-11)"]);
            // 開くのは Open を呼んだときだけ。ここでは /dev/bus/usb/004/007 が無い
            await Assert.That(Assert.Throws<IOException>(() => found[0].Open()).Message).Contains("004/007");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
