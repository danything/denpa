using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Denpa.Agent.Tests;

/*
 * 配る側との間で契約の更新 (EMM) を運ぶ (CardShare.cs の RemoteCard と、CardShareServer.cs の /denpa/card/emm)。
 *
 * 配る側の側は、本文の長さの確認 (400) とカードへの受け渡しを、HTTP を通さずに確かめる。
 * 相手のアドレスと往復時間で断る (403) のは、パスを読む前の共通の確認 (CardLanTests)。
 * カードが無い・読めないときは例外を送出し、ほかの API と同じく 503 になる (CardShareServer.Reply)。
 * 受け取る側 (RemoteCard) は、ループバックで応答する小さな HTTP サーバに繋ぐ。
 */
public class CardShareEmmTests
{
    private static readonly byte[] Payload = EmmTests.Payload(0x0000_1111_2222, 1);

    private sealed class Card(Func<int> code) : IKeySource
    {
        public List<byte[]> Sent { get; } = [];

        public CardInit Init() => throw new NotSupportedException();

        public EcmAnswer Ecm(ReadOnlySpan<byte> ecm) => throw new NotSupportedException();

        public int Confirm(ReadOnlySpan<byte> verificationData, ushort dateMjd) => throw new NotSupportedException();

        public int Emm(ReadOnlySpan<byte> payload)
        {
            Sent.Add(payload.ToArray());
            return code();
        }
    }

    [Test]
    public async Task 配る側は空と短すぎる本文と長すぎる本文を断る()
    {
        await Assert.That(Emm.Problem([])).IsEqualTo("EMM が入っていません");
        await Assert.That(Emm.Problem(new byte[12])).IsEqualTo("EMM が短すぎます (13 バイト以上)");
        // 255 バイトを超えたところで読むのをやめる (CardWire.ReadUpTo は null を返す)
        await Assert.That(Emm.Problem(null)).IsEqualTo("EMM が長すぎます (255 バイトまで)");
        await Assert.That(Emm.Problem(new byte[13])).IsNull();
        await Assert.That(Emm.Problem(new byte[255])).IsNull();
    }

    [Test]
    public async Task 配る側の本文の上限は_255_バイト()
    {
        await Assert.That(await CardWire.ReadUpTo(new MemoryStream(new byte[255]), Emm.MaxPayload)).IsNotNull();
        await Assert.That(await CardWire.ReadUpTo(new MemoryStream(new byte[256]), Emm.MaxPayload)).IsNull();
    }

    [Test]
    public async Task 配る側は受けた_EMM_を手元のカードに渡し_受け入れたら自分の_denpa_にも知らせる()
    {
        var notified = 0;
        var accepting = new Card(() => 0x2100);
        await Assert.That(CardWire.ReadCode(CardWire.Pack(Emm.Forwarded(accepting, Payload, () => notified++)), "EMM ")).IsEqualTo(0x2100);
        await Assert.That(accepting.Sent.Single().SequenceEqual(Payload)).IsTrue();
        await Assert.That(notified).IsEqualTo(1);

        var refusing = new Card(() => 0xA107);
        await Assert.That(Emm.Forwarded(refusing, Payload, () => notified++)).IsEqualTo(0xA107);
        await Assert.That(notified).IsEqualTo(1);

        // カードが無ければ例外を送出する (503 になる)
        var absent = new Card(() => throw new CardAbsentException("カードが挿さっていません"));
        Assert.Throws<CardAbsentException>(() => Emm.Forwarded(absent, Payload, () => notified++));
    }

    [Test]
    public async Task 配る側に渡して返り値を受け取る()
    {
        using var share = new Share((_, _) => (200, CardWire.Pack(0x2100)));
        var remote = new RemoteCard(share.Url, 1);

        await Assert.That(remote.Emm(Payload)).IsEqualTo(0x2100);
        await Assert.That(share.Requests.Single().Path).IsEqualTo("/denpa/card/emm");
        await Assert.That(share.Requests.Single().Body.SequenceEqual(Payload)).IsTrue();
    }

    [Test]
    public async Task 配る側が古ければ_1_回だけ記録に出し_それからは送らない()
    {
        using var share = new Share((_, _) => (404, Encoding.UTF8.GetBytes("""{"error":"not found"}""")));
        var remote = new RemoteCard(share.Url, 1);

        Assert.Throws<NotSupportedException>(() => remote.Emm(Payload));
        Assert.Throws<NotSupportedException>(() => remote.Emm(Payload));

        await Assert.That(share.Requests.Count).IsEqualTo(1);
        var logged = Log.Recent.Snapshot().Count(line => line.Text.Contains("契約の更新 (EMM) を受け取れません") && line.Text.Contains(share.Url));
        await Assert.That(logged).IsEqualTo(1);
    }

    [Test]
    public async Task 配る側のカードが読めなければ理由ごと例外にする()
    {
        using var share = new Share((_, _) => (503, Encoding.UTF8.GetBytes("""{"error":"カードリーダーが見つかりません"}""")));
        var remote = new RemoteCard(share.Url, 1);

        var error = Assert.Throws<ShareRefusedException>(() => remote.Emm(Payload));
        await Assert.That(error.Message).Contains("カードリーダーが見つかりません");
    }

    /// <summary>ループバックで 1 回ずつ応答する HTTP サーバ (配る側の代わり)</summary>
    private sealed class Share : IDisposable
    {
        private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
        private readonly Func<string, byte[], (int Status, byte[] Body)> _answer;
        private readonly List<(string Path, byte[] Body)> _requests = [];

        public Share(Func<string, byte[], (int Status, byte[] Body)> answer)
        {
            _answer = answer;
            _listener.Start();
            _ = Task.Run(Loop);
        }

        public string Url => $"http://127.0.0.1:{((IPEndPoint)_listener.LocalEndpoint).Port}";

        public List<(string Path, byte[] Body)> Requests
        {
            get
            {
                lock (_requests) return [.. _requests];
            }
        }

        private async Task Loop()
        {
            while (true)
            {
                TcpClient client;
                try
                {
                    client = await _listener.AcceptTcpClientAsync();
                }
                catch (Exception error) when (error is SocketException or ObjectDisposedException)
                {
                    return;
                }
                _ = Task.Run(() => Serve(client));
            }
        }

        private async Task Serve(TcpClient client)
        {
            using (client)
            {
                var stream = client.GetStream();
                var header = new List<byte>();
                while (header.Count < 4 || !header.TakeLast(4).SequenceEqual("\r\n\r\n"u8.ToArray()))
                {
                    var next = stream.ReadByte();
                    if (next < 0) return;
                    header.Add((byte)next);
                }
                var lines = Encoding.ASCII.GetString([.. header]).Split("\r\n");
                var path = lines[0].Split(' ')[1];
                var length = lines
                    .Where(line => line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
                    .Select(line => int.Parse(line["Content-Length:".Length..].Trim()))
                    .FirstOrDefault();
                var body = new byte[length];
                await stream.ReadExactlyAsync(body);
                lock (_requests) _requests.Add((path, body));
                var (status, reply) = _answer(path, body);
                var head = $"HTTP/1.1 {status} Answer\r\nContent-Type: application/octet-stream\r\nContent-Length: {reply.Length}\r\nConnection: close\r\n\r\n";
                await stream.WriteAsync(Encoding.ASCII.GetBytes(head));
                await stream.WriteAsync(reply);
            }
        }

        public void Dispose() => _listener.Stop();
    }
}
