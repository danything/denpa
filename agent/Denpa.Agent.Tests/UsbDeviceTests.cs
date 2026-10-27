using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * USB の層 (UsbDevice.cs・UsbFsDevice.cs)。機材なしで確かめられる所: usbfs の ioctl の番号と構造体の大きさ
 * (カーネルの uapi の linux/usbdevice_fs.h の形)、Windows と macOS のポートの名前の作り方。
 */
public class UsbDeviceTests
{
    [Test]
    public async Task usbfs_の構造体と_ioctl_の番号()
    {
        // 64bit (x64・arm64) の大きさ
        await Assert.That(Unsafe.SizeOf<UsbFsDevice.ControlTransfer>()).IsEqualTo(24);
        await Assert.That(Unsafe.SizeOf<UsbFsDevice.SetInterfaceRequest>()).IsEqualTo(8);
        await Assert.That(Unsafe.SizeOf<UsbFsDevice.Urb>()).IsEqualTo(56);
        // _IOWR('U', 0, struct usbdevfs_ctrltransfer) など
        await Assert.That(UsbFsDevice.Control).IsEqualTo(0xC0185500u);
        await Assert.That(UsbFsDevice.SetInterface).IsEqualTo(0x80085504u);
        await Assert.That(UsbFsDevice.SubmitUrb).IsEqualTo(0x8038550Au);
        await Assert.That(UsbFsDevice.DiscardUrb).IsEqualTo(0x0000550Bu);
        await Assert.That(UsbFsDevice.ReapUrbNoDelay).IsEqualTo(0x4008550Du);
        await Assert.That(UsbFsDevice.ClearHalt).IsEqualTo(0x80045515u);
    }

    [Test]
    public async Task Windows_のポートの名前は場所の文字列から()
    {
        string[] controllers = ["PCIROOT(0)#PCI(0800)#PCI(0003)", "PCIROOT(0)#PCI(1400)"];
        await Assert.That(UsbDevices.WindowsPort("PCIROOT(0)#PCI(1400)#USBROOT(0)#USB(3)#USB(2)", controllers)).IsEqualTo("2-3.2");
        await Assert.That(UsbDevices.WindowsPort("PCIROOT(0)#PCI(0800)#PCI(0003)#USBROOT(0)#USB(11)", controllers)).IsEqualTo("1-11");
        // コントローラーが分からない・ポートが無い
        await Assert.That(UsbDevices.WindowsPort("PCIROOT(0)#PCI(1D00)#USBROOT(0)#USB(1)", controllers)).IsNull();
        await Assert.That(UsbDevices.WindowsPort("PCIROOT(0)#PCI(1400)#USBROOT(0)", controllers)).IsNull();
        await Assert.That(UsbDevices.WindowsPort("ACPI(_SB_)", controllers)).IsNull();
    }

    [Test]
    public async Task macOS_のポートの名前は_locationID_から()
    {
        await Assert.That(UsbDevices.MacPort(0x14320000)).IsEqualTo("20-3.2");
        await Assert.That(UsbDevices.MacPort(0x01100000)).IsEqualTo("1-1");
        await Assert.That(UsbDevices.MacPort(0x14000000)).IsNull();
        // どれも sysfs の名前と同じ形なので、zd1j: の device にそのまま書ける
        await Assert.That(Zd1j.Parse($"zd1j:{UsbDevices.MacPort(0x14320000)}")).IsEqualTo("20-3.2");
    }

    [Test]
    public async Task 端点の一覧は番号と種類と最大パケット長()
    {
        var line = UsbDevices.DescribePipes([(0x81, 2, 512), (0x02, 2, 512), (0x83, 3, 64)]);
        await Assert.That(line).IsEqualTo("EP 0x81 bulk 512 バイト、EP 0x02 bulk 512 バイト、EP 0x83 interrupt 64 バイト");
    }

    /// <summary>時間切れの無い読みの偽物。答えを1つずつ返し、取り消されるまで待つ</summary>
    private sealed class FakeEndpoint
    {
        public readonly BlockingCollection<byte[]> Answers = [];
        public readonly CancellationTokenSource Cancelled = new();
        public int Reads;
        public int Size;

        public int Read(byte[] buffer)
        {
            Interlocked.Increment(ref Reads);
            Size = buffer.Length;
            try
            {
                var answer = Answers.Take(Cancelled.Token);
                answer.CopyTo(buffer, 0);
                return answer.Length;
            }
            catch (OperationCanceledException)
            {
                return 0;
            }
        }
    }

    [Test]
    public async Task interrupt_の読みは時間切れでも取り消さず_遅れて届いた答えを次に渡す()
    {
        var endpoint = new FakeEndpoint();
        var cancels = 0;
        using var pump = new UsbReadPump("test", 64, endpoint.Read, () =>
        {
            cancels++;
            endpoint.Cancelled.Cancel();
        });
        var buffer = new byte[64];

        // 何も届かなければ、待った時間で 0 を返す。出している読みは取り消さない
        await Assert.That(pump.Read(buffer, 10)).IsEqualTo(0);
        await Assert.That(cancels).IsEqualTo(0);

        // 時間切れのあとに届いた答えは、次の読みで受け取れる (落とさない)
        endpoint.Answers.Add([0xA5, 1, 2, 3]);
        await Assert.That(pump.Read(buffer, 1000)).IsEqualTo(4);
        await Assert.That(buffer[0]).IsEqualTo((byte)0xA5);

        // 1回の転送が1つの答え。続けて届いても混ぜない
        endpoint.Answers.Add([1, 1]);
        endpoint.Answers.Add([2, 2, 2]);
        await Assert.That(pump.Read(buffer, 1000)).IsEqualTo(2);
        await Assert.That(pump.Read(buffer, 1000)).IsEqualTo(3);
        await Assert.That(buffer[0]).IsEqualTo((byte)2);

        // 読みの大きさは渡した最大パケット長
        await Assert.That(endpoint.Size).IsEqualTo(64);
    }

    [Test]
    public async Task interrupt_の読みは受け口に入るぶんだけ渡す()
    {
        var endpoint = new FakeEndpoint();
        using var pump = new UsbReadPump("test", 64, endpoint.Read, endpoint.Cancelled.Cancel);
        endpoint.Answers.Add([1, 2, 3, 4, 5, 6, 7, 8]);
        var small = new byte[4];
        await Assert.That(pump.Read(small, 1000)).IsEqualTo(4);
        await Assert.That(small).IsEquivalentTo(new byte[] { 1, 2, 3, 4 });
        // 残りは捨てる (Linux・Windows の1回の読みと同じ)
        await Assert.That(pump.Read(small, 10)).IsEqualTo(0);
    }

    [Test]
    public async Task interrupt_の読みが失敗したら_届いていた答えを渡してから投げる()
    {
        var answers = new Queue<Func<byte[], int>>();
        answers.Enqueue(buffer =>
        {
            buffer[0] = 7;
            return 1;
        });
        answers.Enqueue(_ => throw new UsbGoneException("usb 1-2 が抜かれました"));
        var stopped = new ManualResetEventSlim();
        using var pump = new UsbReadPump("test", 64, buffer =>
        {
            if (answers.TryDequeue(out var next)) return next(buffer);
            stopped.Wait();
            return 0;
        }, stopped.Set);
        var received = new byte[64];
        await Assert.That(pump.Read(received, 1000)).IsEqualTo(1);
        await Assert.That(received[0]).IsEqualTo((byte)7);
        // 抜けたことは種類ごと伝わる (Zd1jBoard が開き直すかを決める)
        Assert.Throws<UsbGoneException>(() => pump.Read(received, 1000));
    }

    [Test]
    public async Task 閉じると出している読みを取り消して_スレッドが戻る()
    {
        var endpoint = new FakeEndpoint();
        var pump = new UsbReadPump("test", 64, endpoint.Read, endpoint.Cancelled.Cancel);
        // 読みが出ているところまで待つ
        for (var i = 0; i < 200 && Volatile.Read(ref endpoint.Reads) == 0; i++) Thread.Sleep(5);
        pump.Dispose();
        await Assert.That(endpoint.Cancelled.IsCancellationRequested).IsTrue();
        // 取り消して戻った読みのあとは、もう出さない
        var reads = Volatile.Read(ref endpoint.Reads);
        Thread.Sleep(50);
        await Assert.That(Volatile.Read(ref endpoint.Reads)).IsEqualTo(reads);
        Assert.Throws<ObjectDisposedException>(() => pump.Read(new byte[64], 10));
    }

    [Test]
    public async Task interrupt_の溜めは上限を越えたら古いものから捨てる()
    {
        var endpoint = new FakeEndpoint();
        using var pump = new UsbReadPump("test", 64, endpoint.Read, endpoint.Cancelled.Cancel);
        for (var i = 0; i < UsbReadPump.Capacity + 3; i++) endpoint.Answers.Add([(byte)i]);
        // 全部を読み終えて次の読みを出すまで待つ
        for (var i = 0; i < 400 && Volatile.Read(ref endpoint.Reads) <= UsbReadPump.Capacity + 3; i++) Thread.Sleep(5);
        var buffer = new byte[64];
        await Assert.That(pump.Read(buffer, 1000)).IsEqualTo(1);
        await Assert.That(buffer[0]).IsEqualTo((byte)3);
    }

    [Test]
    public async Task 取り消しても戻らない読みは_戻らなかったと知らせる()
    {
        var release = new ManualResetEventSlim();
        var pump = new UsbReadPump("test", 64, _ =>
        {
            release.Wait();
            return 0;
        }, () => { });
        // インターフェースを手放してよいかを、呼ぶ側 (IoKitDevice.Dispose) が決める
        await Assert.That(pump.Stop()).IsFalse();
        release.Set();
        await Assert.That(pump.Stop()).IsTrue();
    }
}
