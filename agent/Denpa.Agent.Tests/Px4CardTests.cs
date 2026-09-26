using System.Buffers.Binary;
using System.Net.Sockets;
using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * px4d の制御ソケット越しのカード (Px4Card.cs)。
 *
 * px4d は無い。同じ場所に Unix ソケットを開いて px4d のふりをし、
 * **線に乗るバイト列が SPEC 6 節の通りか**を見る。
 */
public class Px4CardTests
{
    private const string Id = "00001205000960";

    private sealed record Frame(ushort Type, ushort Flags, uint RequestId, byte[] Payload);

    /// <summary>px4d のふり。頼まれたものを残し、<c>answer</c> が返したものを返す (null なら切る)</summary>
    private sealed class FakePx4d : IDisposable
    {
        private readonly Socket _listener;
        private readonly Task _serving;

        public DirectoryInfo Runtime { get; } = Directory.CreateTempSubdirectory("px4");
        public List<Frame> Received { get; } = [];
        public string SocketPath { get; }

        public FakePx4d(Func<Frame, (ushort Flags, byte[] Payload)?> answer)
        {
            var dir = Path.Combine(Runtime.FullName, "px4-userland", Id);
            Directory.CreateDirectory(dir);
            SocketPath = Path.Combine(dir, "control.sock");
            _listener = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            _listener.Bind(new UnixDomainSocketEndPoint(SocketPath));
            _listener.Listen();
            _serving = Task.Run(() =>
            {
                using var client = _listener.Accept();
                while (true)
                {
                    var header = new byte[20];
                    if (!Read(client, header)) return;
                    var payload = new byte[BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(16))];
                    if (!Read(client, payload)) return;
                    var frame = new Frame(
                        BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(8)),
                        BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(10)),
                        BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(12)),
                        payload);
                    lock (Received) Received.Add(frame);
                    if (answer(frame) is not { } reply) return;
                    client.Send(Encode(frame.Type, reply.Flags, frame.RequestId, reply.Payload));
                }
            });
        }

        private static bool Read(Socket socket, Span<byte> into)
        {
            while (into.Length > 0)
            {
                var got = socket.Receive(into);
                if (got == 0) return false;
                into = into[got..];
            }
            return true;
        }

        public static byte[] Encode(ushort type, ushort flags, uint requestId, byte[] payload)
        {
            var frame = new byte[20 + payload.Length];
            "PX4U"u8.CopyTo(frame);
            BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(4), 1);
            BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(8), type);
            BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(10), flags);
            BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(12), requestId);
            BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(16), (uint)payload.Length);
            payload.CopyTo(frame, 20);
            return frame;
        }

        /// <summary>全部済むまで待つ (相手が切ったら終わる)</summary>
        public void Wait() => _serving.Wait(TimeSpan.FromSeconds(5));

        public void Dispose()
        {
            _listener.Dispose();
            Runtime.Delete(true);
        }
    }

    private static readonly byte[] Atr = [0x3b, 0xf0, 0x12, 0x00, 0xff, 0x91, 0x81, 0xb1, 0x7c, 0x45, 0x1f, 0x03, 0x99];
    private const ulong Handle = 0x0102030405060708;

    private static byte[] HelloOk(uint capabilities = 0b10)
    {
        var payload = new byte[8];
        BinaryPrimitives.WriteUInt16LittleEndian(payload, 1);
        BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(4), capabilities);
        return payload;
    }

    private static byte[] Error(uint code, string detail = "")
    {
        var text = System.Text.Encoding.UTF8.GetBytes(detail);
        var payload = new byte[6 + text.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(payload, code);
        BinaryPrimitives.WriteUInt16LittleEndian(payload.AsSpan(4), (ushort)text.Length);
        text.CopyTo(payload, 6);
        return payload;
    }

    /// <summary>ちゃんと答える px4d</summary>
    private static (ushort, byte[])? Healthy(Frame frame)
    {
        switch (frame.Type)
        {
            case 0x0001:
                return (1, HelloOk());
            case 0x0031:
            {
                var payload = new byte[9 + Atr.Length];
                BinaryPrimitives.WriteUInt64LittleEndian(payload, Handle);
                payload[8] = (byte)Atr.Length;
                Atr.CopyTo(payload, 9);
                return (1, payload);
            }
            case 0x0034:
                return (1, [(byte)Atr.Length, .. Atr]);
            case 0x0035:
            {
                // 送られた APDU の INS を返し、SW 90 00 を付ける
                byte[] response = [frame.Payload[13], 0x90, 0x00];
                var payload = new byte[4 + response.Length];
                BinaryPrimitives.WriteUInt32LittleEndian(payload, (uint)response.Length);
                response.CopyTo(payload, 4);
                return (1, payload);
            }
            case 0x0033:
                return (1, []);
            default:
                return null;
        }
    }

    [Test]
    public async Task 起きているpx4dの筐体を挙げる()
    {
        using var px4d = new FakePx4d(Healthy);
        Directory.CreateDirectory(Path.Combine(px4d.Runtime.FullName, "px4-userland", "000000000012345"));  // ソケットが無い
        Directory.CreateDirectory(Path.Combine(px4d.Runtime.FullName, "px4-userland", "tmp"));

        var found = Px4Card.Find(px4d.Runtime.FullName);

        await Assert.That(found.Select(c => c.Name)).IsEquivalentTo(new[] { "px4-userland 0960 Internal Card Reader" });
        await Assert.That(Px4Card.Find(Path.Combine(px4d.Runtime.FullName, "none"))).IsEmpty();
    }

    [Test]
    public async Task HELLOからAPDUまで仕様の通りに送る()
    {
        using var px4d = new FakePx4d(Healthy);
        var link = Px4Card.Find(px4d.Runtime.FullName)[0].Open();

        var atr = link.Reset();
        var answer = link.Transmit([0x90, 0x30, 0x00, 0x00, 0x00]);
        var again = link.Reset();
        link.Dispose();
        px4d.Wait();

        await Assert.That(atr).IsEquivalentTo(Atr);
        await Assert.That(again).IsEquivalentTo(Atr);
        await Assert.That(answer).IsEquivalentTo(new byte[] { 0x30, 0x90, 0x00 });

        var sent = px4d.Received;
        await Assert.That(sent.Select(f => f.Type)).IsEquivalentTo(new ushort[] { 0x0001, 0x0031, 0x0035, 0x0034, 0x0033 });
        await Assert.That(sent.All(f => f.Flags == 0)).IsTrue();
        await Assert.That(sent.Select(f => f.RequestId)).IsEquivalentTo(new uint[] { 1, 2, 3, 4, 5 });

        // HELLO: min 1.0 / max 1.0 / CARD
        await Assert.That(sent[0].Payload).IsEquivalentTo(new byte[] { 1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0 });
        // CARD_CONNECT: 共有
        await Assert.That(sent[1].Payload).IsEquivalentTo(new byte[] { 1 });
        // CARD_TRANSMIT: handle, u32 長さ, APDU
        await Assert.That(sent[2].Payload).IsEquivalentTo(
            new byte[] { 8, 7, 6, 5, 4, 3, 2, 1, 5, 0, 0, 0, 0x90, 0x30, 0x00, 0x00, 0x00 });
        // CARD_RESET: handle
        await Assert.That(sent[3].Payload).IsEquivalentTo(new byte[] { 8, 7, 6, 5, 4, 3, 2, 1 });
        // CARD_DISCONNECT: handle, leave
        await Assert.That(sent[4].Payload).IsEquivalentTo(new byte[] { 8, 7, 6, 5, 4, 3, 2, 1, 0 });
    }

    [Test]
    public async Task エラーの答えは理由を付けて投げる()
    {
        using var px4d = new FakePx4d(frame => frame.Type == 0x0031 ? (3, Error(12, "slot empty")) : Healthy(frame));
        using var link = Px4Card.Find(px4d.Runtime.FullName)[0].Open();

        var error = Assert.Throws<IOException>(() => link.Reset());
        await Assert.That(error.Message).Contains("カードが刺さっていません");
        await Assert.That(error.Message).Contains("slot empty");
    }

    [Test]
    public async Task カードを扱わないpx4dには繋がない()
    {
        using var px4d = new FakePx4d(frame => frame.Type == 0x0001 ? (1, HelloOk(0)) : null);
        var candidate = Px4Card.Find(px4d.Runtime.FullName)[0];

        var error = Assert.Throws<IOException>(() => candidate.Open());
        await Assert.That(error.Message).Contains("カードを扱いません");
    }

    [Test]
    public async Task 途中で切れたらIOException()
    {
        using var px4d = new FakePx4d(frame => frame.Type == 0x0035 ? null : Healthy(frame));
        using var link = Px4Card.Find(px4d.Runtime.FullName)[0].Open();
        link.Reset();

        var error = Assert.Throws<IOException>(() => link.Transmit([0x90, 0x34]));
        await Assert.That(error.Message).Contains("px4d");
    }

    [Test]
    public async Task 起きていないpx4dはIOException()
    {
        var error = Assert.Throws<IOException>(() => Px4Card.Open("none", "/nonexistent/control.sock"));
        await Assert.That(error.Message).Contains("px4d に繋がりません");
    }

    [Test]
    public async Task 崩れた答えは受けない()
    {
        using var px4d = new FakePx4d(frame => frame.Type == 0x0001 ? ((ushort)1, HelloOk()) : ((ushort)1, new byte[] { 0 }));
        using var link = Px4Card.Find(px4d.Runtime.FullName)[0].Open();

        // CARD_CONNECT の答えとして 1 バイトしか来ない
        var error = Assert.Throws<IOException>(() => link.Reset());
        await Assert.That(error.Message).Contains("崩れています");
    }
}
