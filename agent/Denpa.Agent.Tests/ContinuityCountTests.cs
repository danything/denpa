namespace Denpa.Agent.Tests;

/*
 * TS の連続性の飛び (ContinuityCount.cs)。PID と continuity_counter だけを持つパケットを並べて数える
 */
public class ContinuityCountTests
{
    private static byte[] Packet(int pid, int counter, bool payload = true, bool error = false)
    {
        var packet = new byte[188];
        packet[0] = 0x47;
        packet[1] = (byte)((error ? 0x80 : 0) | (pid >> 8));
        packet[2] = (byte)pid;
        packet[3] = (byte)((payload ? 0x10 : 0x20) | (counter & 0x0F));
        if (!payload) packet[4] = 0;
        return packet;
    }

    private static readonly TimeSpan Late = TimeSpan.FromSeconds(5);

    [Test]
    public async Task 一つずつ進めば飛びにしない_重送とペイロードの無いものも()
    {
        var count = new ContinuityCount();
        foreach (var (counter, payload) in new[] { (14, true), (15, true), (15, true), (0, true), (0, false), (1, true) })
            count.Push(Packet(0x100, counter, payload), Late);
        await Assert.That(count.Jumps).IsEqualTo(0);
    }

    [Test]
    public async Task 近くで飛んだ_PID_はまとめて_1_か所にする()
    {
        var count = new ContinuityCount();
        foreach (var pid in new[] { 0x100, 0x110, 0x111 }) count.Push(Packet(pid, 0), Late);
        foreach (var pid in new[] { 0x100, 0x110, 0x111 }) count.Push(Packet(pid, 5), Late + TimeSpan.FromMilliseconds(10));
        count.Push(Packet(0x100, 9), Late + TimeSpan.FromSeconds(3));
        await Assert.That(count.Jumps).IsEqualTo(4);
        await Assert.That(count.Places.Count).IsEqualTo(2);
        await Assert.That(count.Places[0].Pids).IsEqualTo(3);
        await Assert.That(count.Places[1].Pids).IsEqualTo(1);
        // 1 つの PID だけが飛んだか所は、その PID も書く
        await Assert.That(ContinuityCount.Describe(count.Places[0])).IsEqualTo("5.0s(3 PID)");
        await Assert.That(ContinuityCount.Describe(count.Places[1])).IsEqualTo("8.0s(PID 0x0100)");
    }

    [Test]
    public async Task 誤りのあるパケットの数も数える()
    {
        var tracker = new ContinuityTracker();
        tracker.Push(Packet(0x100, 0));
        await Assert.That(tracker.Push(Packet(0x100, 1, error: true))).IsEqualTo(-1);
        // 誤りのあるパケットは見ないので、その次で飛ぶ
        await Assert.That(tracker.Push(Packet(0x100, 2))).IsEqualTo(0x100);
        await Assert.That(tracker.Errors).IsEqualTo(1);
        await Assert.That(tracker.Jumps).IsEqualTo(1);
    }

    [Test]
    public async Task 最初の_1_秒と誤りのあるパケットと_NULL_は数えない()
    {
        var count = new ContinuityCount();
        count.Push(Packet(0x100, 0), TimeSpan.Zero);
        count.Push(Packet(0x100, 7), TimeSpan.FromMilliseconds(500));
        count.Push(Packet(0x100, 3, error: true), Late);
        count.Push(Packet(0x1FFF, 0), Late);
        count.Push(Packet(0x1FFF, 9), Late);
        await Assert.That(count.Jumps).IsEqualTo(0);
    }
}
