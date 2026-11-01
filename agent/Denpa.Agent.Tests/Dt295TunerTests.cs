using System.Buffers;
using System.Security.Cryptography;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * PIX-DT295 をチューナーとして持つところ (Dt295.cs の名前と検出、Dt295Tuner.cs)。
 * USB は偽物 (FakeDt295Usb)、TS は合成のもの、鍵・表・IV はでたらめ。
 */
public class Dt295TunerTests
{
    private const string Port = "1-2";
    private static readonly string Device = Dt295.Device(Port);

    // ---------------------------------------------------------------------
    // 名前と検出
    // ---------------------------------------------------------------------

    [Test]
    public async Task 設定の_device_は_dt295_とポート()
    {
        await Assert.That(Dt295.Device("4-12.1")).IsEqualTo("dt295:4-12.1");
        await Assert.That(Dt295.Parse("dt295:4-12.1")).IsEqualTo("4-12.1");
        await Assert.That(Dt295.Parse("dt295:abc")).IsNull();
        await Assert.That(Dt295.Parse("zd1j:4-12.1")).IsNull();
        await Assert.That(Dt295.Is("dt295:1-2")).IsTrue();
        await Assert.That(Dt295.Is(null)).IsFalse();
    }

    [Test]
    public async Task sysfs_から_06b8_103b_だけを並べる()
    {
        // sysfs は Linux だけ (インターフェースの名前の「:」は Windows のファイル名に使えない)
        if (OperatingSystem.IsWindows()) return;
        var dir = Directory.CreateTempSubdirectory("dt295sysfs");
        try
        {
            void Usb(string name, string vendor, string product)
            {
                var at = Directory.CreateDirectory(Path.Combine(dir.FullName, name)).FullName;
                File.WriteAllText(Path.Combine(at, "idVendor"), vendor + "\n");
                File.WriteAllText(Path.Combine(at, "idProduct"), product + "\n");
            }
            Usb("1-2", "06b8", "103b");
            Usb("1-3", "054c", "04b2");
            Usb("1-2:1.0", "06b8", "103b");
            Usb("2-1.4", "06b8", "103b");
            await Assert.That(Dt295.Ports(dir.FullName, null)).IsEquivalentTo(new[] { "1-2", "2-1.4" });
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Test]
    public async Task dt295_の_device_は開かずに_Dt295Tuner_にする()
    {
        if (OperatingSystem.IsWindows()) return;
        using var tuner = TunerPool.OpenDevice("dt295:1-2", null);
        await Assert.That(tuner).IsTypeOf<Dt295Tuner>();
        await Assert.That(tuner.Tuned).IsFalse();
        Assert.Throws<IOException>(() => TunerPool.OpenDevice("dt295:bad", null));
    }

    // ---------------------------------------------------------------------
    // TS の確かめ (10.2・10.3)
    // ---------------------------------------------------------------------

    [Test]
    public async Task 暗号化されていないパケットはそのまま渡し_端数は次につなぐ()
    {
        var filter = new Dt295TsFilter(new Dt295PacketDecryptor());
        var output = new ArrayBufferWriter<byte>();
        var clear = 0;
        byte[] data = [.. Dt295Ts.Payload(0x100), .. Dt295Ts.Payload(0x101)];
        await Assert.That(filter.Feed(data.AsSpan(0, 200), output, _ => clear++)).IsEqualTo(1);
        await Assert.That(filter.Feed(data.AsSpan(200), output, _ => clear++)).IsEqualTo(1);
        await Assert.That(output.WrittenSpan.ToArray()).IsEquivalentTo(data);
        await Assert.That(clear).IsEqualTo(2);
        await Assert.That(filter.Packets).IsEqualTo(2L);
    }

    [Test]
    public async Task AES_のかかったパケットは_IV_が無ければ止め_あれば外す()
    {
        var output = new ArrayBufferWriter<byte>();
        var encrypted = Dt295Ts.Payload(0x100, scrambling: 1);
        var none = Assert.Throws<Dt295Exception>(() => new Dt295TsFilter(new Dt295PacketDecryptor()).Feed(encrypted, output));
        await Assert.That(none.Message).IsEqualTo(Dt295TsFilter.NoIv);
        await Assert.That(output.WrittenCount).IsEqualTo(0);

        // 鍵と IV を渡せば外す (どちらも合成の値。TRC で受けるときの形)
        var key = RandomNumberGenerator.GetBytes(16);
        var iv = RandomNumberGenerator.GetBytes(16);
        var plain = Dt295Ts.Payload(0x100);
        var packet = plain.ToArray();
        using (var aes = Aes.Create())
        {
            aes.Key = key;
            aes.EncryptCbc(packet.AsSpan(4, 176), iv, packet.AsSpan(4, 176), PaddingMode.None);
            var stream = aes.EncryptEcb(packet.AsSpan(4 + 160, 16), PaddingMode.None);
            for (var i = 0; i < 8; i++) packet[180 + i] ^= stream[i];
        }
        packet[3] |= 0x40;
        new Dt295TsFilter(new Dt295PacketDecryptor(), key, iv).Feed(packet, output);
        await Assert.That(output.WrittenSpan.ToArray()).IsEquivalentTo(plain);
    }

    [Test]
    public async Task 不正なパケットで止める()
    {
        var bad = Dt295Ts.Payload(0x100);
        bad[0] = 0x00;
        var error = Assert.Throws<Dt295Exception>(() => new Dt295TsFilter(new Dt295PacketDecryptor()).Feed(bad, new ArrayBufferWriter<byte>()));
        await Assert.That(error.Message).IsEqualTo(Dt295TsFilter.Invalid);
        var tei = Dt295Ts.Payload(0x100, scrambling: 1);
        tei[1] |= 0x80;
        Assert.Throws<Dt295Exception>(() => new Dt295TsFilter(new Dt295PacketDecryptor()).Feed(tei, new ArrayBufferWriter<byte>()));
    }

    // ---------------------------------------------------------------------
    // ルートを育てる (11.2・11.3)
    // ---------------------------------------------------------------------

    [Test]
    public async Task PAT_と_PMT_からルートを育てる()
    {
        var tracker = new Dt295RouteTracker();
        await Assert.That(tracker.Plan.Length).IsEqualTo(Dt295Routes.FixedSi.Length);
        var both = Dt295Ts.PatPmt([0x09, 0x04, 0x00, 0x05, 0xE9, 0x01]);
        await Assert.That(tracker.Push(both.AsSpan(0, 188))).IsTrue();
        await Assert.That(tracker.PatSeen).IsTrue();
        await Assert.That(tracker.FirstPmtPid).IsEqualTo(0x1F0);
        await Assert.That(tracker.Plan.Any(route => route.Pid == 0x1F0)).IsTrue();

        await Assert.That(tracker.Push(both.AsSpan(188))).IsTrue();
        await Assert.That(tracker.Main!.VideoPid).IsEqualTo(0x111);
        var plan = tracker.Plan.ToDictionary(route => route.Pid);
        await Assert.That(plan[0x111].Slot).IsEqualTo(0);
        await Assert.That(plan[0x112].Slot).IsEqualTo(1);
        await Assert.That(plan[0x1F0].Slot).IsEqualTo(2);
        await Assert.That(plan[0x901].Slot).IsEqualTo(63);
        await Assert.That(plan[0x111].EcmSlot).IsEqualTo(63);

        // 同じものがもう一度来ても変わらない
        await Assert.That(tracker.Push(both.AsSpan(0, 188))).IsFalse();
        await Assert.That(tracker.Push(both.AsSpan(188))).IsFalse();
    }

    // ---------------------------------------------------------------------
    // ボード (開く・更新・閉じる)
    // ---------------------------------------------------------------------

    private static Dt295Board Open(FakeDt295Usb usb) =>
        Dt295Board.Acquire(Port, FakeDt295Material.Vendor, () => usb, usb.Time, refresher: false);

    [Test]
    public async Task 開くと認証とカードまで進み_更新し_閉じると_0x10_に戻す()
    {
        var usb = FakeDt295Usb.Authenticating(FakeDt295Material.Create());
        var board = Open(usb);
        await Assert.That(usb.State).IsEqualTo(Dt295Device.Authenticated);
        await Assert.That(board.Card).IsEqualTo(Dt295CardState.Ready);
        await Assert.That(board.CardProblem).IsNull();

        // 30 秒たつまで更新しない。たったら更新する
        var before = usb.Log.Count(line => line.StartsWith("40 B8 0000 0000 08", StringComparison.Ordinal));
        await Assert.That(board.Tick()).IsTrue();
        await Assert.That(usb.Log.Count(line => line.StartsWith("40 B8 0000 0000 08", StringComparison.Ordinal))).IsEqualTo(before);
        usb.Time.NowMs += Dt295Device.RefreshMs;
        await Assert.That(board.Tick()).IsTrue();
        await Assert.That(usb.Log.Count(line => line.StartsWith("40 B8 0000 0000 08", StringComparison.Ordinal))).IsEqualTo(before + 2);

        board.Dispose();
        await Assert.That(usb.State).IsEqualTo(Dt295Device.Idle);
        await Assert.That(usb.Bulk.Count).IsEqualTo(1);
        Assert.Throws<ObjectDisposedException>(() => board.Locked(() => { }));
    }

    [Test]
    public async Task 更新に失敗したら使わず_画面に理由を出す()
    {
        var usb = FakeDt295Usb.Authenticating(FakeDt295Material.Create());
        usb.RefuseRefresh = true;
        var board = Open(usb);
        usb.Time.NowMs += Dt295Device.RefreshMs;
        await Assert.That(board.Tick()).IsFalse();
        await Assert.That(board.Fault).Contains("開き直します");
        await Assert.That(Px4Userland.Notice(Device)).IsEqualTo(board.Fault);
        Assert.Throws<IOException>(() => board.Locked(() => { }));
        board.Dispose();
        await Assert.That(Px4Userland.Notice(Device)).IsNull();
    }

    [Test]
    public async Task カードが無ければ開いたまま画面に出す()
    {
        var usb = FakeDt295Usb.Authenticating(FakeDt295Material.Create());
        usb.Set16(0x822AC, 0x0000);
        usb.Events = Dt295Bridge.EventCard;
        var board = Dt295Board.Acquire("9-9", FakeDt295Material.Vendor, () => usb, usb.Time, refresher: false);
        await Assert.That(board.CardProblem).Contains("B-CAS カードが挿さっていません");
        await Assert.That(Px4Userland.Notice("dt295:9-9")).IsEqualTo(board.CardProblem);
        board.Dispose();
    }


    [Test]
    public async Task 受信中のルート変更は6バイト()
    {
        await Assert.That(Convert.ToHexString(Dt295Device.RouteChangeBytes(5, 0, 0x111, true))).IsEqualTo("050081110111");
        await Assert.That(Convert.ToHexString(Dt295Device.RouteChangeBytes(0, 63, 0x1FF, true))).IsEqualTo("003F81FF01FF");
        Assert.Throws<ArgumentOutOfRangeException>(() => Dt295Device.RouteChangeBytes(4, 0, 0, true));
    }

    [Test]
    public async Task 抜かれたカードを画面に出し_挿し直されたら通知ごとに1回だけ活性化する()
    {
        var usb = FakeDt295Usb.Receiving(FakeDt295Material.Create());
        var board = Dt295Board.Acquire("9-8", FakeDt295Material.Vendor, () => usb, usb.Time, refresher: false);
        await Assert.That(board.Card).IsEqualTo(Dt295CardState.Ready);
        int Activations() => usb.Log.Count(line => line.EndsWith("0A010001", StringComparison.Ordinal));

        // 抜かれた: 通知とともに 0
        usb.Set16(0x822AC, 0x0000);
        usb.Events = Dt295Bridge.EventCard;
        await Assert.That(board.Tick()).IsTrue();
        await Assert.That(board.CardProblem).Contains("挿さっていません");
        await Assert.That(Px4Userland.Notice("dt295:9-8")).IsEqualTo(board.CardProblem);

        // 挿し直された: 通知とともに 1。活性化を 1 回送る (偽物は 3 にしない → 失敗)
        usb.Set16(0x822AC, 0x1000);
        usb.Events = Dt295Bridge.EventCard;
        var before = Activations();
        await Assert.That(board.Tick()).IsTrue();
        await Assert.That(Activations()).IsEqualTo(before + 1);
        await Assert.That(board.CardProblem).Contains("B-CAS カードが使えません");
        // 同じ通知に対して 2 回は送らない
        await Assert.That(board.Tick()).IsTrue();
        await Assert.That(Activations()).IsEqualTo(before + 1);

        // 次の通知で 3 になれば使える
        usb.OnCommand = (command, sub, _) =>
        {
            if (command == 0x0A && sub == 1) usb.Set16(0x822AC, 0x3000);
        };
        usb.Events = Dt295Bridge.EventCard;
        await Assert.That(board.Tick()).IsTrue();
        await Assert.That(board.Card).IsEqualTo(Dt295CardState.Ready);
        await Assert.That(board.CardProblem).IsNull();
        await Assert.That(Px4Userland.Notice("dt295:9-8")).IsNull();
        board.Dispose();
    }

    // ---------------------------------------------------------------------
    // エラーの状態からの復帰 (5.8)
    // ---------------------------------------------------------------------

    [Test]
    public async Task エラーの状態からは_cmd_3_を1回だけ送り_古い通知の間は待つ()
    {
        var usb = FakeDt295Usb.Receiving(FakeDt295Material.Create());
        usb.State = 0xFFFF;
        usb.Events = Dt295Bridge.EventState;
        // cmd 3 のあと、しばらく 0xFFFF と 0x11 が残ってから 0x10
        usb.NextState = (command, _, _) => command == 3 ? (ushort?)0xFFFF : null;
        var reads = 0;
        usb.Time.OnSleep = () =>
        {
            reads++;
            usb.State = reads switch
            {
                < 3 => 0xFFFF,
                < 5 => 0x0011,
                _ => 0x0010,
            };
        };
        var device = new Dt295Device(new Dt295Bridge(usb, usb.Time));
        await Assert.That(device.Boot([1])).IsEqualTo(Dt295Boot.Recovered);
        await Assert.That(usb.State).IsEqualTo(Dt295Device.Idle);
        await Assert.That(usb.MainCommands()).IsEquivalentTo(new[] { "03000000" });
        await Assert.That(usb.Events & Dt295Bridge.EventState).IsEqualTo(0);

        // 0x10・0x11・0xFFFF 以外になったら諦める
        var odd = FakeDt295Usb.Receiving(FakeDt295Material.Create());
        odd.State = 0xFFFF;
        odd.NextState = (command, _, _) => command == 3 ? (ushort?)0x0002 : null;
        var error = Assert.Throws<Dt295Exception>(() => new Dt295Device(new Dt295Bridge(odd, odd.Time)).Recover());
        await Assert.That(error.Message).Contains("戻せません");
        // エラーでなければ送らない
        var fine = FakeDt295Usb.Receiving(FakeDt295Material.Create());
        Assert.Throws<Dt295Exception>(() => new Dt295Device(new Dt295Bridge(fine, fine.Time)).Recover());
        await Assert.That(fine.Log).IsEmpty();
    }

    [Test]
    public async Task 開くときにエラーの状態なら戻してから認証する()
    {
        var usb = FakeDt295Usb.Receiving(FakeDt295Material.Create());
        usb.State = 0xFFFF;
        var board = Dt295Board.Acquire("9-7", FakeDt295Material.Vendor, () => usb, usb.Time, refresher: false);
        await Assert.That(usb.State).IsEqualTo(Dt295Device.Authenticated);
        await Assert.That(usb.MainCommands()[0]).IsEqualTo("03000000");
        await Assert.That(usb.Bulk).IsEmpty();
        board.Dispose();
    }

    // ---------------------------------------------------------------------
    // フィールド表と受信に要るもの (12.5・12.7)
    // ---------------------------------------------------------------------

    [Test]
    public async Task フィールド表を_JSON_から読み_形を確かめる()
    {
        var table = Dt295FieldTable.Parse("""
            {"fields": [
              {"name": "A", "address": "0x1002", "shift": 8, "width": 2, "value": 1},
              {"address": 4100, "shift": 0, "width": 16, "value": "0xBEEF"}
            ]}
            """);
        await Assert.That(table.Rows.Count).IsEqualTo(2);
        await Assert.That(table.Rows[1]).IsEqualTo(new Dt295Field(0x1004, 0, 16, 0xBEEF));
        await Assert.That(table.Pause).IsEqualTo((ushort)3);
        await Assert.That(table.Sha256()).IsNotEqualTo(Dt295FieldTable.ReferenceSha256);
        await Assert.That(new Dt295FieldTable([new(0x1010, 0, 1, 1)]).Pause).IsEqualTo((ushort)4);

        Assert.Throws<InvalidDataException>(() => Dt295FieldTable.Parse("""{"fields": []}"""));
        Assert.Throws<InvalidDataException>(() => Dt295FieldTable.Parse("""{"rows": []}"""));
        Assert.Throws<InvalidDataException>(() => Dt295FieldTable.Parse("not json"));
        // アドレスは 0x1000〜0x1AFE の偶数
        Assert.Throws<InvalidDataException>(() => new Dt295FieldTable([new(0x1001, 0, 1, 1)]));
        Assert.Throws<InvalidDataException>(() => new Dt295FieldTable([new(0x1B00, 0, 1, 1)]));
        // 幅に収まらない値
        Assert.Throws<InvalidDataException>(() => new Dt295FieldTable([new(0x1000, 0, 2, 4)]));
        // 0x1002 のビット 8〜9 の最終値は 0 か 1
        Assert.Throws<InvalidDataException>(() => new Dt295FieldTable([new(0x1002, 8, 2, 1), new(0x1002, 9, 1, 1)]));
    }

    [Test]
    public async Task フィールド表が無ければ_受信には要ると断り_IV_が見つからなければそう言う()
    {
        var folder = Directory.CreateTempSubdirectory("dt295receive");
        try
        {
            var store = new Dt295ReceiveStore(folder.FullName, [Path.Combine(folder.FullName, Dt295Receive.AppFolder)], TimeProvider.System);
            var none = Assert.Throws<IOException>(() => store.Ensure());
            await Assert.That(none.Message).Contains("受信にはフィールド表が要ります (まだ未対応)");
            await Assert.That(none.Message).Contains(Dt295Receive.FieldsFile);

            File.WriteAllText(Path.Combine(folder.FullName, Dt295Receive.FieldsFile), """{"fields": [{"address": "0x1002", "shift": 8, "width": 2, "value": 0}]}""");
            // StationTV X の写しに IV は入っていない (でたらめのファイル)
            var app = Directory.CreateDirectory(Path.Combine(folder.FullName, Dt295Receive.AppFolder));
            File.WriteAllBytes(Path.Combine(app.FullName, "app.dll"), RandomNumberGenerator.GetBytes(4096));
            var noIv = Assert.Throws<IOException>(() => store.Ensure());
            await Assert.That(noIv.Message).Contains("StationTV X");
            // 置き場の IV が合わなければ使わない
            File.WriteAllBytes(Path.Combine(folder.FullName, Dt295Receive.IvFile), new byte[16]);
            Assert.Throws<IOException>(() => store.Ensure());

            File.WriteAllText(Path.Combine(folder.FullName, Dt295Receive.FieldsFile), """{"fields": [{"address": "0x1003"}]}""");
            var broken = Assert.Throws<IOException>(() => store.Ensure());
            await Assert.That(broken.Message).Contains(Dt295Receive.FieldsFile);
        }
        finally
        {
            folder.Delete(recursive: true);
        }
    }

    // ---------------------------------------------------------------------
    // 受信 (9 章)
    // ---------------------------------------------------------------------

    private static readonly byte[] Iv = [.. Enumerable.Range(0, 16).Select(i => (byte)(0x30 + i))];

    /// <summary>0x1002 のビット 8〜9 を 1 (一時停止は 3) にし、ほかに 1 行だけのでたらめの表</summary>
    private static Dt295ReceiveData Data() =>
        new(new Dt295FieldTable([new(0x1002, 8, 2, 1), new(0x1100, 0, 16, 0x1234)]), Iv);

    private static Dt295Tuner Tuner(FakeDt295Usb usb, string port, int silenceMs = 2000, int? settleMs = null, Func<Dt295ReceiveData>? receive = null) =>
        new($"{Dt295.Model} {port}", Dt295.Device(port), receive ?? Data,
            () => Dt295Board.Acquire(port, FakeDt295Material.Vendor, () => usb, usb.Time, refresher: false),
            TimeSpan.FromMilliseconds(silenceMs), settleMs is { } settle ? TimeSpan.FromMilliseconds(settle) : null);

    private static byte[] ReadAll(Stream output, int length)
    {
        var buffer = new byte[length];
        var got = 0;
        while (got < length)
        {
            var n = output.Read(buffer, got, length - got);
            if (n == 0) break;
            got += n;
        }
        return buffer[..got];
    }

    [Test]
    public async Task フィールド表が無ければ機材に触らず理由を画面に出す()
    {
        var opened = false;
        using var tuner = new Dt295Tuner($"{Dt295.Model} 3-5", "dt295:3-5",
            () => throw new IOException(Dt295Receive.NoFields("/data")),
            () =>
            {
                opened = true;
                throw new InvalidOperationException("開かないはず");
            });
        var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId));
        await Assert.That(error.Message).Contains("受信にはフィールド表が要ります (まだ未対応)");
        await Assert.That(opened).IsFalse();
        await Assert.That(tuner.Tuned).IsFalse();
        await Assert.That(Px4Userland.Notice("dt295:3-5")).Contains("フィールド表");
        tuner.Dispose();
        await Assert.That(Px4Userland.Notice("dt295:3-5")).IsNull();
    }

    [Test]
    public async Task 選局から_TS_鍵_TRC_フィールド表_ルート_取得開始_受信開始の順に送り_止めるときは9_9()
    {
        var usb = FakeDt295Usb.Receiving(FakeDt295Material.Create());
        usb.Ts.Enqueue(Dt295Ts.Payload(0x100));
        var tuner = Tuner(usb, "3-6");
        tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId);
        await Assert.That(tuner.Tuned).IsTrue();
        await Assert.That(usb.State).IsEqualTo((ushort)2);
        await Assert.That(usb.TsKeyRequests).IsEqualTo(1);
        // 9.3: 領域を 0 で埋めてからフィールド表を当てた
        await Assert.That(usb.Get16(0x1002)).IsEqualTo((ushort)0x0100);
        await Assert.That(usb.Get16(0x1100)).IsEqualTo((ushort)0x1234);
        // 11.2 の初期計画: 固定の SI PID がスロット 5 から
        await Assert.That(usb.Get16(0x1028)).IsEqualTo((ushort)(0x8000 | 0x0001));
        await Assert.That(usb.Bulk.Select(chunk => chunk.Length).Sum()).IsEqualTo(FakeDt295Material.Vendor().Trc.Length);

        var commands = usb.MainCommands();
        var trc = commands.IndexOf("04000000");
        await Assert.That(commands.IndexOf("08000000")).IsLessThan(trc);
        await Assert.That(commands.Skip(trc)).IsEquivalentTo(new[] { "04000000", "04200000", "05000002" });

        // 止める: 一時停止 (3) → 設定済み (1) → アイドル設定で 0x11
        usb.Log.Clear();
        tuner.Dispose();
        await Assert.That(usb.MainCommands().Take(3)).IsEquivalentTo(new[] { "05000003", "05000001", "01000000" });
        await Assert.That(usb.State).IsEqualTo(Dt295Device.Idle);
    }

    [Test]
    public async Task PSI_がそろったら1回だけ準備し直し_TS_鍵は要求し直さず_AES_を外す()
    {
        var usb = FakeDt295Usb.Receiving(FakeDt295Material.Create());
        var plain = Dt295Ts.Payload(0x111);
        byte[] first = [.. Dt295Ts.PatPmt([0x09, 0x04, 0x00, 0x05, 0xE9, 0x01]), .. Dt295Ts.Cat()];
        usb.Ts.Enqueue(first);
        var tuner = Tuner(usb, "3-7");
        tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId);
        await Assert.That(ReadAll(tuner.Output, first.Length)).IsEquivalentTo(first);

        // 主番組と ECM のスロットは受信中には足せないので、準備し直す (9.10)
        for (var i = 0; i < 200 && tuner.Stream!.Reprepared == 0; i++) await Task.Delay(10);
        await Assert.That(tuner.Stream!.Reprepared).IsEqualTo(1);
        await Assert.That(usb.Get16(0x101E)).IsEqualTo((ushort)0x8111);
        await Assert.That(usb.Get16(0x1018)).IsEqualTo((ushort)0x0400);
        await Assert.That(usb.TsKeyRequests).IsEqualTo(1);
        var commands = usb.MainCommands();
        await Assert.That(commands.Count(command => command == "04000000")).IsEqualTo(2);
        await Assert.That(commands).Contains("05000003");

        // 準備し直したあとの AES のかかったパケットは外して渡す
        usb.Ts.Enqueue(Dt295Ts.Encrypted(plain, FakeDt295Usb.TsKey, Iv));
        await Assert.That(ReadAll(tuner.Output, 188)).IsEquivalentTo(plain);
        tuner.Dispose();
    }

    [Test]
    public async Task 受信中は空きスロットへの_ECM_でない_PID_だけを_9_8_で足す()
    {
        var usb = FakeDt295Usb.Receiving(FakeDt295Material.Create());
        // PAT だけ (PMT はまだ): NIT と PMT の PID を足す
        var pat = Dt295Ts.PatPmt()[..188];
        usb.Ts.Enqueue(pat);
        var tuner = Tuner(usb, "3-8");
        tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId);
        ReadAll(tuner.Output, 188);
        for (var i = 0; i < 200 && !usb.MainCommands().Contains("05010000"); i++) await Task.Delay(10);
        await Assert.That(usb.MainCommands()).Contains("05010000");
        await Assert.That(tuner.Stream!.Reprepared).IsEqualTo(0);
        // 0x81000 に「スロット 16・ECM なし・有効・PID 0x1F0」
        await Assert.That(usb.Log.Any(line => line.Contains("0800 1000 1000", StringComparison.Ordinal) && line.EndsWith("81F001F0", StringComparison.Ordinal))).IsTrue();
        tuner.Dispose();
    }

    [Test]
    public async Task PSI_が上限までにそろわなければ_そろったぶんで準備し直す()
    {
        var usb = FakeDt295Usb.Receiving(FakeDt295Material.Create());
        // 地上波なのに CAT が来ない
        var both = Dt295Ts.PatPmt();
        usb.Ts.Enqueue(both);
        var tuner = Tuner(usb, "3-9", settleMs: 100);
        tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId);
        ReadAll(tuner.Output, both.Length);
        await Assert.That(tuner.Stream!.Reprepared).IsEqualTo(0);
        await Task.Delay(150);
        usb.Ts.Enqueue(Dt295Ts.Payload(0x111));
        ReadAll(tuner.Output, 188);
        for (var i = 0; i < 200 && tuner.Stream!.Reprepared == 0; i++) await Task.Delay(10);
        await Assert.That(tuner.Stream!.Reprepared).IsEqualTo(1);
        tuner.Dispose();
    }

    [Test]
    public async Task TS_が来なければ選局は理由を添えて失敗し_次の選局もできる()
    {
        var usb = FakeDt295Usb.Receiving(FakeDt295Material.Create());
        using var tuner = Tuner(usb, "3-2", silenceMs: 200);
        var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId));
        await Assert.That(error.Message).IsEqualTo(Dt295Stream.NoData);
        await Assert.That(tuner.Tuned).IsFalse();
        // 止めてアイドルに戻っている。セッションは続いていて、TS 鍵は要求し直さない
        await Assert.That(usb.State).IsEqualTo(Dt295Device.Authenticated);

        usb.Ts.Enqueue(Dt295Ts.Payload(0x100));
        tuner.Tune(ChannelTable.Parse("T21")!, ChannelTable.NoStreamId);
        await Assert.That(tuner.Tuned).IsTrue();
        await Assert.That(usb.TsKeyRequests).IsEqualTo(1);
    }

    [Test]
    public async Task 手順の途中で失敗したら次の選局で開き直す()
    {
        var usb = FakeDt295Usb.Receiving(FakeDt295Material.Create());
        var opens = 0;
        // 取得開始で状態 1 にならない (状態 0xFFFF に落ちる)
        usb.NextState = (command, sub, value) => command switch
        {
            1 => (ushort?)0x0011,
            3 => 0x0010,
            4 when sub == 1 => 0x0010,
            4 when sub == 0x20 => 0xFFFF,
            5 when sub == 0 => value,
            _ => null,
        };
        using var tuner = new Dt295Tuner($"{Dt295.Model} 3-10", "dt295:3-10", Data,
            () =>
            {
                opens++;
                return Dt295Board.Acquire("3-10", FakeDt295Material.Vendor, () => usb, usb.Time, refresher: false);
            },
            TimeSpan.FromMilliseconds(500));
        Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId));
        await Assert.That(opens).IsEqualTo(1);

        // 次の選局: 閉じて開き直す。エラーの状態なので cmd 3 で戻してから認証する
        usb.NextState = (command, sub, value) => command switch
        {
            1 => (ushort?)0x0011,
            3 => 0x0010,
            4 when sub == 1 => 0x0010,
            4 when sub == 0x20 => 0x0001,
            5 when sub == 0 => value,
            _ => null,
        };
        usb.Log.Clear();
        usb.Ts.Enqueue(Dt295Ts.Payload(0x100));
        tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId);
        await Assert.That(opens).IsEqualTo(2);
        await Assert.That(usb.MainCommands()).Contains("03000000");
        await Assert.That(tuner.Tuned).IsTrue();
    }

    [Test]
    public async Task 衛星がロックしなければ同期しませんでした()
    {
        var usb = FakeDt295Usb.Receiving(FakeDt295Material.Create());
        // S[0xC3] のビット 4 が 1 (未ロック)
        usb.I2cDevice = (address, write, read) =>
            address == Dt295Frontend.SatelliteDemod && write is [0xC3] ? [0x10] : new byte[read];
        using var tuner = Tuner(usb, "3-3");
        var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("BS01_0")!, 16400));
        await Assert.That(error.Message).IsEqualTo(ITuneDevice.SyncFailed);
        // ロックしないのは機材の失敗ではないので開き直さない
        await Assert.That(usb.State).IsEqualTo(Dt295Device.Authenticated);
        tuner.Dispose();
        await Assert.That(usb.State).IsEqualTo(Dt295Device.Idle);
    }

    [Test]
    public async Task メーカーのデータが取れなければ理由を画面に出す()
    {
        using var tuner = new Dt295Tuner($"{Dt295.Model} 3-4", "dt295:3-4", Data, () => throw new IOException("PIX-DT295 のデータを用意できません (テスト)"));
        var error = Assert.Throws<IOException>(() => tuner.Tune(ChannelTable.Parse("T27")!, ChannelTable.NoStreamId));
        await Assert.That(error.Message).Contains("用意できません");
        await Assert.That(Px4Userland.Notice("dt295:3-4")).Contains("用意できません");
        tuner.Dispose();
        await Assert.That(Px4Userland.Notice("dt295:3-4")).IsNull();
    }
}
