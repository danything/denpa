using System.Buffers.Text;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json.Nodes;

namespace Denpa.Agent;

/// <summary>
/// **denpa とお互いを証明書で確かめる** (docs/agent.md「denpa とは TLS で組む」)。
///
/// <para>
/// 普通のポート (<c>AGENT_PORT</c>) は HTTPS だけで、クライアント証明書を必須にする。TLS の段ではどの証明書も受け、
/// 見分けるのは HTTP の段 (<see cref="Decide"/>)。証明書の指紋が <c>clients</c> にある相手 (組んだ denpa) だけ通す。
/// 組んでいない相手が使えるのは <c>POST /denpa/pair</c> だけで、合言葉から作った proof を出せば組める (<see cref="Pair"/>)。
/// </para>
///
/// <para>
/// 置き場は tuners.json の隣の <c>tls/</c> (コンテナなら <c>/config/tls</c>)。
/// </para>
/// <list type="bullet">
/// <item><c>agent.key</c> / <c>agent.crt</c>: 自分の鍵と自己署名の証明書。**一度作ったら作り直さない** (denpa が証明書そのものを保存するので)</item>
/// <item><c>pair-token</c>: 合言葉。<c>AGENT_PAIR_TOKEN</c> を渡していれば作らない</item>
/// <item><c>clients</c>: 組んだ denpa の証明書の指紋。1 行に 1 つ</item>
/// </list>
///
/// <para>
/// 鍵を配るポート (<c>CARD_SHARE_PORT</c>) はここに関わらず平文のまま (CardShareServer.cs)。
/// </para>
/// </summary>
public sealed class AgentTls
{
    public const string PairPath = "/denpa/pair";

    public const string NotPaired = "この denpa とはまだ組んでいません。denpa の設定の「エージェントを追加」に登録用の URL を貼るか、TUNER_AGENT_URL に #pair=… を付けてください (docs/agent.md)";
    public const string WrongClient = "証明書が名乗りと違います";
    public const string WrongProof = "合言葉が違います";

    public string Dir { get; }

    /// <summary>自分の証明書 (鍵付き)。Kestrel に渡す</summary>
    public X509Certificate2 Certificate { get; }

    /// <summary>A = F(自分の証明書)</summary>
    public string Fingerprint { get; }

    public string Token { get; }

    public PairedClients Clients { get; }

    private AgentTls(string dir, X509Certificate2 certificate, string token, PairedClients clients)
    {
        Dir = dir;
        Certificate = certificate;
        Fingerprint = FingerprintOf(certificate);
        Token = token;
        Clients = clients;
    }

    /// <summary>置き場を読む。鍵・証明書・合言葉が無ければここで作る</summary>
    public static AgentTls Load(string dir, string? envToken)
    {
        Directory.CreateDirectory(dir);
        var certificate = LoadOrCreateCertificate(dir);
        var token = ResolveToken(envToken, Path.Combine(dir, "pair-token"));
        return new AgentTls(dir, certificate, token, new PairedClients(Path.Combine(dir, "clients")));
    }

    /// <summary>組むときの URL。denpa の <c>TUNER_AGENT_URL</c> にそのまま書ける</summary>
    public string PairUrl(int port) => $"https://{Environment.MachineName}:{port}#pair={Token}";

    // --- 言葉 ----------------------------------------------------------------

    /// <summary>指紋 F(cert): DER の SHA-256 を小文字の 16 進で (コロン無し、64 字)</summary>
    public static string FingerprintOf(X509Certificate2 certificate) => FingerprintOf(certificate.RawData);

    public static string FingerprintOf(byte[] der) => Convert.ToHexStringLower(SHA256.HashData(der));

    /// <summary>
    /// 組むときの proof。<paramref name="role"/> は <c>client</c> (denpa が出す) か <c>agent</c> (こちらが返す)。
    /// base64url(HMAC-SHA256(合言葉, "denpa-pair/&lt;role&gt;\n" + A + "\n" + D))
    /// </summary>
    public static string Proof(string token, string role, string agent, string client) =>
        Base64Url.EncodeToString(HMACSHA256.HashData(
            Encoding.UTF8.GetBytes(token),
            Encoding.UTF8.GetBytes($"denpa-pair/{role}\n{agent}\n{client}")));

    /// <summary>合言葉を新しく作る。32 バイトの乱数を base64url で (43 字)</summary>
    public static string NewToken() => Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));

    /// <summary>合言葉: 環境変数が空でなければそれ。無ければファイル (無ければ作る)</summary>
    public static string ResolveToken(string? envToken, string file)
    {
        if (envToken?.Trim() is { Length: > 0 } given) return given;
        if (File.Exists(file) && File.ReadAllText(file).Trim() is { Length: > 0 } kept) return kept;
        var token = NewToken();
        WritePrivate(file, token + "\n");
        return token;
    }

    // --- 通すかどうか ------------------------------------------------------------------

    public enum Gate
    {
        /// <summary>組んだ相手。普通の API へ通す</summary>
        Pass,
        /// <summary>組む API に回す (組んだ相手からでも受ける)</summary>
        Pair,
        /// <summary>組んでいない。403</summary>
        Refuse,
    }

    /// <summary>
    /// 普通のポートに来たものをどうするか。<paramref name="peer"/> は相手の証明書の指紋
    /// (クライアント証明書は必須なので TLS の段を越えていれば必ずあるが、無ければ組んでいない扱い)
    /// </summary>
    public Gate Decide(string? peer, string method, string path)
    {
        if (string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase) && path == PairPath) return Gate.Pair;
        /*
         * **自分の証明書で来た相手も通す** (`--status`)。agent.key を読めるのはこの機械の管理者だけなので、組んだ denpa と同じに扱ってよい
         */
        return peer is not null && (peer == Fingerprint || Clients.Contains(peer)) ? Gate.Pass : Gate.Refuse;
    }

    /// <summary>
    /// <c>denpa-agent --status</c>: 動いているエージェントに自分の証明書で繋いで <c>/denpa/tuners</c> を読み、
    /// 返った JSON をそのまま標準出力に出す (インストーラが結果を確かめるため)。サーバの証明書が agent.crt と同じかも確かめる。
    /// 繋がらなければ理由を標準エラーに出して 1
    /// </summary>
    public static async Task<int> Status(string dir, string host, int port)
    {
        if (!File.Exists(Path.Combine(dir, "agent.crt")) || !File.Exists(Path.Combine(dir, "agent.key")))
        {
            Console.Error.WriteLine($"{dir} に agent.key / agent.crt がありません (エージェントを一度起動すると作られます)");
            return 1;
        }
        using var certificate = LoadCertificate(dir);
        var expected = FingerprintOf(certificate);
        using var handler = new SocketsHttpHandler
        {
            SslOptions =
            {
                ClientCertificates = [certificate],
                RemoteCertificateValidationCallback = (_, server, _, _) =>
                    server is not null && FingerprintOf(server.GetRawCertData()) == expected,
            },
        };
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(10) };
        var url = $"https://{(host.Contains(':') ? $"[{host}]" : host)}:{port}/denpa/tuners";
        try
        {
            using var response = await client.GetAsync(url);
            var body = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode)
            {
                Console.Error.WriteLine($"{url}: {(int)response.StatusCode} {body}");
                return 1;
            }
            Console.Out.WriteLine(body);
            return 0;
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or IOException)
        {
            Console.Error.WriteLine($"{url} に繋がりません: {error.GetBaseException().Message}");
            return 1;
        }
    }

    /// <summary>
    /// <c>POST /denpa/pair</c> の本文の上限 (バイト)。中身は指紋 (64 字) と proof (43 字) だけで 130 バイトほど。
    /// **組む前の相手からも受ける**ので、Kestrel の既定 (30MB) のままにせず、要る大きさに余裕を足したところで切る
    /// </summary>
    public const int PairBodyLimit = 1024;

    public const string PairBodyTooLarge = "本文が大きすぎます";

    /// <summary>
    /// <c>POST /denpa/pair</c> の本文を読む。<see cref="PairBodyLimit"/> を越えたら読むのをやめて <c>TooLarge</c>
    /// (<paramref name="length"/> は Content-Length。越えていれば読まない)。JSON でなければ null
    /// </summary>
    public static async Task<(JsonNode? Body, bool TooLarge)> ReadPairBody(Stream body, long? length)
    {
        if (length > PairBodyLimit) return (null, true);
        // 1 バイト多く読めたら越えている
        var buffer = new byte[PairBodyLimit + 1];
        var filled = 0;
        try
        {
            while (filled < buffer.Length)
            {
                var read = await body.ReadAsync(buffer.AsMemory(filled));
                if (read == 0) break;
                filled += read;
            }
        }
        catch (IOException)
        {
            return (null, false);
        }
        if (filled > PairBodyLimit) return (null, true);
        try
        {
            return (JsonNode.Parse(buffer.AsSpan(0, filled)), false);
        }
        catch (System.Text.Json.JsonException)
        {
            return (null, false);
        }
    }

    /// <summary>
    /// <c>DELETE /denpa/pair</c>: 呼んだ denpa の指紋を <c>clients</c> から消す (denpa の設定でエージェントを削除したとき)。
    /// ここへ来るのは組んだ相手だけ (<see cref="Decide"/>)。消したら true
    /// </summary>
    public bool Unpair(string? peer)
    {
        if (peer is null || !Clients.Remove(peer)) return false;
        Log.Write($"denpa ({peer[..Math.Min(16, peer.Length)]}) の登録を消しました");
        return true;
    }

    /// <summary><c>POST /denpa/pair</c> の応答。断ったら <c>Error</c>、組めたら返す <c>Proof</c> が入る</summary>
    public readonly record struct PairResult(int Status, string? Error, string? Proof);

    /// <summary>
    /// 組む。<paramref name="peer"/> は接続の相手の証明書の指紋、<paramref name="body"/> は
    /// <c>{"client":"&lt;D&gt;","proof":"…"}</c>。合えば D を <c>clients</c> に足す
    /// </summary>
    public PairResult Pair(string? peer, JsonNode? body)
    {
        var client = (body as JsonObject)?["client"] is JsonValue c && c.TryGetValue<string>(out var cs) ? cs : null;
        var proof = (body as JsonObject)?["proof"] is JsonValue p && p.TryGetValue<string>(out var ps) ? ps : null;
        if (client is null || proof is null) return new(400, "client と proof が必要です", null);
        if (peer is null || client != peer) return new(403, WrongClient, null);

        var expected = Proof(Token, "client", Fingerprint, client);
        if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(proof)))
        {
            return new(403, WrongProof, null);
        }

        if (Clients.Add(client))
        {
            Log.Write($"denpa ({client[..Math.Min(16, client.Length)]}) と組みました");
            /*
             * 2 つの denpa が同じエージェントを使うと、チューナーの取り合いの約束 (1 つの denpa が全部の利用者を出す) が崩れる。
             * 断りはしない (denpa を別の機械へ移すときに、新旧が並ぶため)
             */
            if (Clients.Count > 1) Log.Write($"ほかの denpa とも組んでいます ({Clients.Count} 台)。チューナーを使う denpa は 1 つにしてください");
        }
        return new(200, null, Proof(Token, "agent", Fingerprint, client));
    }

    // --- 鍵と証明書 ----------------------------------------------------------

    private static X509Certificate2 LoadOrCreateCertificate(string dir)
    {
        var keyFile = Path.Combine(dir, "agent.key");
        var certFile = Path.Combine(dir, "agent.crt");
        /*
         * 片方だけ残っているのは、作っている途中で落ちたとき。証明書を書く前なので、それを保存した denpa は無い
         */
        if (!File.Exists(keyFile) || !File.Exists(certFile))
        {
            var (key, cert) = CreatePem();
            WritePrivate(keyFile, key);
            WritePrivate(certFile, cert);
            Log.Write($"自分の鍵と証明書を作りました ({dir})");
        }

        return LoadCertificate(dir);
    }

    private static X509Certificate2 LoadCertificate(string dir)
    {
        using var pem = X509Certificate2.CreateFromPemFile(Path.Combine(dir, "agent.crt"), Path.Combine(dir, "agent.key"));
        /*
         * **PKCS#12 を通して読み直す。** PEM から読んだ鍵は使い捨ての形で、Windows の SChannel はそれでは TLS を張れない
         * (「資格情報がありません」)。PKCS#12 から読めばどの OS でも OS の TLS が使える形の鍵になる
         */
        return X509CertificateLoader.LoadPkcs12(pem.Export(X509ContentType.Pkcs12), null);
    }

    /// <summary>
    /// 鍵 (PKCS#8 PEM、EC P-256) と自己署名の証明書 (PEM、CN=denpa-agent、前日から 100 年、serverAuth) を作る。
    ///
    /// <para>
    /// **拡張は serverAuth と SKI だけ。** denpa はこの証明書そのものを ca に渡して確かめる。basicConstraints の CA:FALSE があると
    /// Bun (BoringSSL) はそれを信頼の起点にできず、検証に失敗する (UNABLE_TO_VERIFY_LEAF_SIGNATURE)。keyUsage も付けない
    /// (付けて keyCertSign が無いと、自分で自分を発行したと見なされなくなる)
    /// </para>
    /// </summary>
    private static (string Key, string Certificate) CreatePem()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=denpa-agent", key, HashAlgorithmName.SHA256);
        var ski = new X509SubjectKeyIdentifierExtension(request.PublicKey, critical: false);
        request.CertificateExtensions.Add(ski);
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([new Oid("1.3.6.1.5.5.7.3.1")], critical: false));
        var now = DateTimeOffset.UtcNow;
        using var cert = request.CreateSelfSigned(now.AddDays(-1), now.AddYears(100));
        return (key.ExportPkcs8PrivateKeyPem() + "\n", cert.ExportCertificatePem() + "\n");
    }

    /// <summary>
    /// 書きかけを読ませずに書く (一時ファイルから rename)。Unix では持ち主だけ読み書きできるように (0600)
    /// </summary>
    internal static void WritePrivate(string path, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        var working = $"{path}.writing";
        // 前に途中で止まって残った書きかけは、権限 (0600) が当たらないまま開き直すことになるので先に消す
        File.Delete(working);
        var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        using (var stream = new FileStream(working, options))
        using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
        {
            writer.Write(text);
        }
        File.Move(working, path, overwrite: true);
    }
}

/// <summary>
/// 組んだ denpa の指紋 (<c>tls/clients</c>。1 行に 1 つ)。読むのは起動したときだけで、足すたびに丸ごと書き直す
/// </summary>
public sealed class PairedClients
{
    private readonly string _file;
    private readonly HashSet<string> _known;
    private readonly Lock _gate = new();

    public PairedClients(string file)
    {
        _file = file;
        _known = File.Exists(file)
            ? [.. File.ReadAllLines(file).Select(line => line.Trim().ToLowerInvariant()).Where(line => line.Length > 0)]
            : [];
    }

    public bool Contains(string fingerprint)
    {
        lock (_gate) return _known.Contains(fingerprint);
    }

    public int Count
    {
        get
        {
            lock (_gate) return _known.Count;
        }
    }

    /// <summary>消す。無ければ何もしない (false)</summary>
    public bool Remove(string fingerprint)
    {
        lock (_gate)
        {
            if (!_known.Remove(fingerprint)) return false;
            AgentTls.WritePrivate(_file, string.Concat(_known.Order().Select(line => line + "\n")));
            return true;
        }
    }

    /// <summary>足す。もうあれば何もしない (false)</summary>
    public bool Add(string fingerprint)
    {
        lock (_gate)
        {
            if (!_known.Add(fingerprint)) return false;
            AgentTls.WritePrivate(_file, string.Concat(_known.Order().Select(line => line + "\n")));
            return true;
        }
    }
}
