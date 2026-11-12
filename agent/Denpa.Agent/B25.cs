using System.Buffers;
using System.Buffers.Binary;
using System.Diagnostics;

namespace Denpa.Agent;

/// <summary>
/// ARIB STD-B25 を復号する。**TS を読んで ECM を取り出し、鍵を受け取って MULTI2 で復号する** (Cas.cs)。
///
/// <para>
/// 経路は PAT → PMT → CA 記述子。CA 記述子 (番組全体、または ES ごと) が「この ES の鍵は
/// この PID の ECM から」を示すので、ES の PID から ECM を引く表を作る。
/// **libaribb25 と同じく、ストリームの順に 1 パケットずつ読み、ECM の中身が変わったらその場で鍵を受け取る**
/// (<see cref="IKeySource.Ecm"/>)。後ろのパケットはその鍵で復号する。応答を待つあいだ次のパケットへ
/// 進まないので、鍵とストリームの位置が食い違いようがない。カードが固まっても読み出しを止めないのは
/// 呼ぶ側の仕事 (TunerPool.cs は読み出しと別のスレッドで復号する)。
/// </para>
///
/// <para>
/// **復号できないものは落とさずに素通しする。** 録れないよりまし、で、復号できなかったことは
/// <see cref="Undecodable"/> と <see cref="LastError"/> で分かる。鍵の出どころが失敗しても投げずに、
/// 鍵を捨てて素通しし (古い鍵で化けたものを「復号できた」として流さない)、少し置いて同じ ECM で問い合わせ直す。
/// </para>
///
/// <para>
/// 1 つの実体は**1 本のストリームからだけ**呼ぶ。実体どうしで共有するものは無いので、チューナーが
/// 何台あっても壊し合わない (libaribb25 の頃は 1 つの実体に 2 本入ってプロセスごと落ちた)。
/// 数 (<see cref="Decoded"/> など) だけは他のスレッドから読んでよい。
/// </para>
///
/// <para>
/// **鍵の要らない利用者しかいなければ、カードに問い合わせない** (<paramref name="keysWanted"/>)。番組表・ロゴ・スキャンが
/// 読むのはスクランブルされていない SI だけなので、復号もせず溜めもせずに流す。ライブ視聴や録画とカードのロック
/// (<see cref="BCas"/>) を取り合わない。途中で鍵の要る利用者が来たら、溜め直して最初の鍵から復号する (<see cref="Rehold"/>)。
/// </para>
///
/// <para>
/// **選局では契約の更新 (EMM) も取り出す** (<paramref name="emm"/>)。CAT (PID 0x0001) の CA 記述子から EMM の PID を読み取り、
/// EMM セクション (0x84) を組み立てて渡し先に渡す。自分宛てかを比べるのは渡し先で、ここではカードに送らず応答も待たない。
/// 鍵の要らない利用者だけのときも読むので、番組表・ロゴ・スキャンの選局でも EMM はカードに届く。
/// </para>
///
/// <para>
/// **観る局が決まっていれば、その局の PMT と ECM の答えがそろった時点で溜めるのをやめる** (<paramref name="services"/>)。ライブは 1 局しか観ないので、
/// ワンセグやデータ放送の局の PMT を待たない。まだ PMT か ECM の答えが無い局のスクランブルされたパケットは、そろうまで捨てる (<see cref="Drops"/>)。
/// 局を決めない利用者 (録画) がいれば、今までどおり PAT の全部の局を待つ。
/// </para>
///
/// <para>
/// **観る局の PAT と PMT を覚えていれば、本物を待たずにそれで流し始める** (<paramref name="memory"/>。<see cref="PsiMemory"/>)。
/// 覚えたバイト列を本物と同じ <see cref="OnPat"/>・<see cref="OnPmt"/> に通して経路を組み、覚えた PMT が挙げる ECM の答えがそろえば流し始める。
/// 出力の先頭には覚えた PAT と PMT のパケットを 1 組差し込む (サーバとクライアントは PMT を読むまで何も出さないため)。
/// 本物が届いたら必ず突き合わせ、違えば本物で作り直す。確かめ終わるまでは、復号できないパケットと、どの PMT も挙げていない PID の
/// スクランブルされたパケットを流さずに捨てる (<see cref="Check"/>)。使うのは、鍵の要る利用者がみな局を決めているときだけ
/// </para>
/// </summary>
/// <param name="keysWanted">
/// いま鍵が要るか。塊を受けるたびに呼ぶ。null は「どちらとも決まらない」(利用者がいない) で、今のままにする。
/// 渡さなければいつも要る (録れたものの復号・実機での試験)
/// </param>
/// <param name="emm">
/// 契約の更新 (EMM) の渡し先 (<see cref="Emm"/>)。渡したときだけ CAT と EMM を読む。チューナーの選局 (TunerPool.cs) だけが渡し、
/// 録れたものの復号と実機での試験は渡さない (古い録画の EMM は期限切れや古い更新番号で、渡す意味が無い)
/// </param>
/// <param name="services">
/// 先頭で溜めるのをやめる前にそろえる局 (program_number)。塊を受けるたびに呼ぶ。null か空なら PAT の全部の局を待つ。
/// PAT に無い局があっても全部を待つ。渡さなければいつも全部 (録れたものの復号・実機での試験)
/// </param>
/// <param name="memory">
/// このチャンネルの覚えた PAT・PMT。読んだ本物の PAT・PMT をここに覚え、次の選局で使う。チューナーの選局 (TunerPool.cs) だけが渡し、
/// 録れたものの復号と実機での試験は渡さない (チャンネルが無い)
/// </param>
public sealed class Descrambler(
    IKeySource source, Stopwatch? clock = null, Func<bool?>? keysWanted = null, Emm? emm = null, Func<IReadOnlySet<int>?>? services = null,
    PsiMemory.Slot? memory = null)
{
    /// <summary>いま鍵を問い合わせて復号しているか (<c>keysWanted</c>)</summary>
    private bool _keys = true;

    private const int PacketSize = 188;
    private const byte SyncByte = 0x47;

    /// <summary>
    /// 先頭で溜める上限。**超えたら揃うのを待たずに流し始める。** PAT・PMT・ECM はどれも 0.1 秒ほどの
    /// 間隔で来るので普通は 1MB も溜まらない。揃わないのはカードに合わない局か壊れた TS で、
    /// 待ち続けると何も出てこなくなる。8MB は衛星の中継器まるごと (6MB/秒ほど) でも 1 秒ちょっと
    /// </summary>
    public const int HoldLimit = 8 * 1024 * 1024;

    /// <summary>B-CAS の CA_system_id。カードから読み取れるまではこれで CA 記述子を選ぶ</summary>
    private const int BcasSystemId = 0x0005;

    /// <summary>
    /// 鍵を受け取れなかった ECM を同じ中身のまま問い合わせ直すまでのパケット数 (地上波の 2 秒ほど)。**時計ではなく
    /// 読んだ量で数える。** ファイルは実時間より速く読むので、時計で待つと数分ぶんがスクランブルされたまま残る
    /// </summary>
    private const long RetryPackets = 25_000;

    private byte[] _carry = new byte[PacketSize * 2];
    private int _carryLength;
    private bool _synced;
    private long _packets;

    /// <summary>先頭で溜めている間は true。溜めたパケットは <see cref="_hold"/> に <see cref="_held"/> 個</summary>
    private bool _holding = true;
    private byte[]? _hold;
    private int _held;
    /// <summary>溜めたぶんの前に書き出す、覚えた PAT と PMT のパケット (<see cref="Head"/>)。書き出したら null</summary>
    private byte[]? _head;

    /// <summary>いまそろえる局 (<c>services</c>)。塊を受けるたびに読み直す。null なら全部</summary>
    private IReadOnlySet<int>? _services;
    /// <summary>
    /// **観る局だけで溜めるのをやめたあと、ほかの局の PMT と ECM の答えがそろうまでの間は true。** この間は、PMT か ECM の答えがまだ無い
    /// スクランブルされたパケットを捨てる (<see cref="Drops"/>)。そろったら、または <see cref="_drainUntil"/> を過ぎたらやめる
    /// </summary>
    private bool _draining;
    /// <summary>捨てるのをやめる位置 (読んだパケットの数)。溜める上限 (<see cref="HoldLimit"/>) と同じ量を過ぎたら、そろわなくても流す</summary>
    private long _drainUntil;
    /// <summary>捨てたパケットの数</summary>
    private long _dropped;
    /// <summary>観る局だけで溜めるのをやめたときの局 (<see cref="HeldAt"/> に出す)。全部を待ったなら null</summary>
    private string? _settledFor;

    /// <summary>覚えた PAT・PMT を使うかを決めた (最初の塊で 1 回だけ。<see cref="Recall"/>)</summary>
    private bool _recallTried;
    /// <summary>覚えた PAT・PMT を <see cref="OnPat"/>・<see cref="OnPmt"/> に通している間は true。時刻を測らず、覚え直さない</summary>
    private bool _recalling;
    /// <summary>いまの PAT が覚えたもので、本物がまだ来ていない</summary>
    private bool _patRecalled;
    /// <summary>覚えた PAT・PMT を読み込んだ。それで流し始めたかは <see cref="_settledOnRecall"/></summary>
    private bool _recallLoaded;
    /// <summary>覚えた PMT で、本物がまだ来ていない局 (program_number → 覚えた PMT の PID)</summary>
    private readonly Dictionary<int, int> _recalledPmts = [];
    /// <summary>覚えた PAT・PMT の、どれかが本物と違った</summary>
    private bool _recallDiffered;
    /// <summary>覚えた PAT・PMT を使った選局で、本物の PAT が来た時刻と、観る局の本物の PMT が最後に来た時刻 (ミリ秒。まだなら -1)</summary>
    private long _realPatMs = -1, _realPmtMs = -1;
    /// <summary>本物で確かめ終わる前に、覚えた PAT・PMT で溜めるのをやめた (出力の先頭に差し込んだ)</summary>
    private bool _settledOnRecall;
    /// <summary>
    /// **覚えた PAT・PMT で流し始め、本物で確かめ終わるまでの間は true。** この間は、復号できないパケットと、
    /// どの PMT も挙げていない PID のスクランブルされたパケットを捨てる (<see cref="Check"/>)
    /// </summary>
    private bool _checking;
    /// <summary>確かめ待ちで捨てるのをやめる位置 (読んだパケットの数)。<see cref="_drainUntil"/> と同じく、溜める上限と同じ量</summary>
    private long _checkUntil;
    /// <summary>確かめ待ちで捨てたパケットの数</summary>
    private long _discarded;
    /// <summary>確かめ終わったときの 1 行 (<see cref="TakeChecked"/>)</summary>
    private string? _checked;

    private readonly Section _pat = new(null);
    private byte[]? _patLast;
    /// <summary>program_number → PMT の PID</summary>
    private readonly Dictionary<int, int> _programs = [];
    /// <summary>PMT の PID → 組み立て中のセクション (1 つの PID に複数の番組が入ることもある)</summary>
    private readonly Dictionary<int, Section> _pmtSections = [];
    /// <summary>program_number → 最後に受けた PMT。CA の方式が変わったら読み直せるように丸ごと持つ</summary>
    private readonly Dictionary<int, byte[]> _pmts = [];
    /// <summary>program_number → その PMT が挙げた ECM の PID。観る局だけを待つとき (<see cref="Waits"/>) に引く</summary>
    private readonly Dictionary<int, HashSet<int>> _programEcms = [];
    /// <summary>
    /// PAT の PMT がみな来た / PAT が変わってから同じ PMT がもう一度来た (1 周で来ない PMT は来ない。ただし <see cref="_stray"/> が無いときだけ)
    /// </summary>
    private bool _allPmts, _pmtRepeated;
    /// <summary>どの PMT が挙げた ES か (PID ごと)。挙げた ES は、ECM が無くても <see cref="_stray"/> に入れない</summary>
    private readonly bool[] _listed = new bool[8192];
    /// <summary>
    /// **溜めている間に来た、どの PMT も挙げていない PID のスクランブルされたパケット。** その番組の PMT がまだ来ていないだけなので、
    /// これがある間は来ていない PMT を待ち続ける (<see cref="PmtsReady"/>)。PMT の来ない番組 (地上波の臨時の番組) は ES も流れていないとみなす
    /// (確かめたのは本番の記録とテストの並びまで)。PMT の無いままスクランブルされた ES が流れ続ける TS でも、待つのは <see cref="HoldLimit"/>
    /// (地上波で 3 秒ほど) までで、そこで流し始める
    /// </summary>
    private readonly HashSet<int> _stray = [];
    private readonly Dictionary<int, Ecm> _ecms = [];
    /// <summary>ES の PID → 鍵。表を引くだけにして、パケットごとの手間を無くす</summary>
    private readonly Ecm?[] _route = new Ecm?[8192];
    /// <summary>
    /// ECM が 1 本だけなら、PMT に載っていない PID もそれで復号する。**PAT の PMT がみな来てから**にして、
    /// 来ていない番組の ES を別の ECM の鍵で復号しない
    /// </summary>
    private Ecm? _only;

    /// <summary>
    /// ES の PID → PES を運ぶか (PMT の stream_type)。**PES の先頭は <c>00 00 01</c> なので、復号した結果で鍵が合っているかを確かめられる**
    /// (<see cref="Unscramble"/>)
    /// </summary>
    private readonly bool[] _pes = new bool[8192];
    /// <summary>ES の PID → いまの PES の先頭で鍵が合わなかった。次の PES の先頭まで、その PID は復号せずに流す</summary>
    private readonly bool[] _garbled = new bool[8192];
    /// <summary>最後に記録へ出した、鍵の合わなかった理由。同じものを続けて出さない</summary>
    private string? _mismatch;

    /// <summary>
    /// PES を運ぶ stream_type (映像・音声)。**0x06 は入れない。** 字幕 (PES) とデータ (セクション) の両方に使われ、
    /// セクションを PES の先頭と比べると、合っている鍵でも「合わない」と数えてしまう
    /// </summary>
    private static readonly HashSet<int> PesTypes = [0x01, 0x02, 0x03, 0x04, 0x0F, 0x11, 0x1B, 0x24];

    /// <summary>
    /// **PAT・PMT より先に来た ECM** (PID → ECM)。溜めている間だけ、PAT・PMT にまだ無い PID のセクションも先頭の
    /// table_id を読み、ECM なら中身を取っておく。**カードに問い合わせるのは PMT がその PID を挙げてから** (<see cref="Rebuild"/>)。
    /// 挙げなければ問い合わせずに捨てる
    /// </summary>
    private readonly Dictionary<int, Ecm> _earlyEcms = [];
    /// <summary>PAT より先に来た PMT を組み立てる場所 (PID → セクション)</summary>
    private readonly Dictionary<int, Section> _earlyPmtSections = [];
    /// <summary>PAT より先に揃った PMT (program_number → PID と中身)。PAT が来たら、その PID でよかったかを確かめてから使う</summary>
    private readonly Dictionary<int, (int Pid, byte[] Section)> _earlyPmts = [];

    /// <summary>先回りして読む PID の数の上限。壊れた TS で表が膨らまないように</summary>
    private const int EarlyLimit = 32;

    /// <summary>CAT の PID</summary>
    private const int CatPid = 0x0001;

    /// <summary>CAT と EMM を組み立てる場所。<c>emm</c> を渡したときだけ作る</summary>
    private readonly Section? _cat = emm is null ? null : new(null), _emmSection = emm is null ? null : new(null);
    private byte[]? _catLast;
    /// <summary>CAT が挙げた、このカードの方式の EMM の PID。CAT が来ていない・挙げていなければ -1</summary>
    private int _emmPid = -1;

    private CardInit? _init;
    private int _caSystemId = BcasSystemId;
    private string? _logged;
    private long _decoded, _undecodable;

    /// <summary>復号したパケットの数</summary>
    public long Decoded => Volatile.Read(ref _decoded);

    /// <summary>
    /// スクランブルされていたのに鍵が無い・鍵が合わないので**そのまま流した**パケットの数 (契約の無いものは数えない)。
    /// 鍵が合わないと分かるのは PES の先頭だけで、その PES の残りも数える (<see cref="Unscramble"/>)
    /// </summary>
    public long Undecodable => Volatile.Read(ref _undecodable);

    /// <summary>最後に鍵を受け取れなかった理由。**録画がスクランブルされたままだったときに表示する**</summary>
    public string? LastError { get; private set; }

    /// <summary>溜めている間の内訳を測る時計。選局の時計を渡せば、選局の内訳と同じ物差しで並ぶ (TunerPool.cs)</summary>
    private readonly Stopwatch _clock = clock ?? Stopwatch.StartNew();

    /// <summary>溜めている間に、PAT が来た・PMT がそろった・最後のカードの応答が来た時刻 (ミリ秒。まだなら -1)</summary>
    private long _patMs = -1, _pmtMs = -1, _ecmMs = -1;
    /// <summary>最後にカードの応答が来た ECM の PID</summary>
    private int _lastEcm = -1;
    /// <summary>
    /// 溜めるのをやめたときに待っていた ECM (観る局の PMT が挙げたもの) のうち、最初のセクションがいちばん遅く届いた時刻とその PID (<see cref="Arrived"/>)。
    /// PMT を待たずにカードへ問い合わせたらどれだけ縮むかを、本番の記録から割るため (カードの応答の時刻とは別)
    /// </summary>
    private long _arrivedMs = -1;
    private int _arrivedEcm = -1;
    /// <summary>
    /// 溜めている間に鍵の出どころへ問い合わせた回数・キャッシュした応答を使った回数・未契約の回数と、往復とロックの待ちの合計・
    /// カードの定数を受け取るのにかかった時間
    /// </summary>
    private int _asks, _cached, _unentitledAnswers;
    private long _askMs, _waitedMs, _initMs = -1;

    /// <summary>
    /// **先頭で溜めていた間の内訳。** 選局して最初に送り出したときの 1 行に足す (docs/stream.md「本番の記録で割る」)。
    /// 時刻は渡された時計から。数えるのは溜めている間だけ
    /// </summary>
    public string HeldAt()
    {
        var last = _lastEcm < 0 ? "" : $" (0x{_lastEcm:X4})";
        var arrived = _arrivedEcm < 0 ? "" : $" (0x{_arrivedEcm:X4})";
        var only = _settledFor is null ? "" : $" (局 {_settledFor})";
        // 覚えた PAT・PMT で流し始めたら「覚えたもの」。本物の時刻は確かめ終わったときの 1 行 (TakeChecked) に出す
        var pat = _settledOnRecall && _patMs < 0 ? "覚えたもの" : At(_patMs);
        var pmt = _settledOnRecall ? "覚えたもの" : At(_pmtMs);
        // 覚えたものを読み込んだが、本物の PAT・PMT が先にそろって本物で流し始めた。PAT・PMT の時刻は本物のもの
        var loaded = _recallLoaded && !_settledOnRecall ? " / 覚えた PAT・PMT は読み込み済み (本物で開始)" : "";
        return $"PAT {pat} / PMT {pmt}{only} / ECM 着 {At(_arrivedMs)}{arrived} / カード応答 {At(_ecmMs)}{last}{loaded}";
    }

    /// <summary>
    /// **覚えた PAT・PMT で流し始めた選局で、本物で確かめ終わったときの 1 行。** 1 回だけ返し、あとは null。
    /// 本物と同じだったか・違って作り直したか・確かめられないまま上限を読んだかと、本物が来た時刻、捨てたパケットの数
    /// </summary>
    public string? TakeChecked()
    {
        var line = _checked;
        _checked = null;
        return line;
    }

    /// <summary>
    /// **覚えた PAT・PMT を使えるなら、本物を待たずに経路を組む。** 選局して最初の塊で 1 回だけ決める。使うのは、鍵の要る利用者が
    /// みな局を決めていて (<c>services</c> が null でない)、その局のどれも PMT を覚えていて、覚えた PAT が同じ PID で挙げているときだけ。
    /// 覚えたものは本物と同じ <see cref="OnPat"/>・<see cref="OnPmt"/> に通す (読み方を 2 つにしない)
    /// </summary>
    private void Recall()
    {
        _recallTried = true;
        if (memory is null || !_keys || !_holding || _packets > 0 || _services is not { Count: > 0 } wanted) return;
        if (memory.Recall(wanted) is not { } recalled) return;
        _recalling = true;
        OnPat(recalled.Pat);
        foreach (var (_, (pid, section)) in recalled.Pmts) OnPmt(pid, section);
        _recalling = false;
        _patRecalled = true;
        _recallLoaded = true;
        foreach (var (number, (pid, _)) in recalled.Pmts) _recalledPmts[number] = pid;
    }

    /// <summary>覚えた PAT・PMT のうち、本物がまだ来ていないものがあるか</summary>
    private bool Unconfirmed() => _patRecalled || _recalledPmts.Count > 0;

    /// <summary>
    /// 本物で確かめ終わったか。本物の PAT と、観る局の本物の PMT がそろい、観る局の ECM がどれも答えを受けた。
    /// 本物の PMT で ECM が変わったら、新しい ECM の答えが来るまでを確かめ待ちに含める
    /// </summary>
    private bool Confirmed()
    {
        if (Unconfirmed() || !TablesReady()) return false;
        foreach (var ecm in _ecms.Values)
        {
            if (Waits(ecm) && ecm.Last is null) return false;
        }
        return true;
    }

    /// <summary>
    /// 確かめ待ちの 1 パケット。捨てるなら true。どの PMT も挙げていない PID のスクランブルされたパケットを捨てる (覚えた PMT に無い新しい ES かもしれない)。
    /// 復号できなかったパケットは、復号してから捨てる (<see cref="Take"/>)。本物で確かめ終わるか、溜める上限と同じ量を読んだらやめる
    /// </summary>
    private bool Check(ReadOnlySpan<byte> packet)
    {
        if (!_keys)
        {
            _checking = false;
            return false;
        }
        if (Confirmed())
        {
            FinishCheck(_recallDiffered ? "覚えた PAT・PMT が本物と違ったので、本物で作り直しました" : "覚えた PAT・PMT は本物と同じでした");
            return false;
        }
        if (_packets >= _checkUntil)
        {
            FinishCheck($"覚えた PAT・PMT を本物で確かめられないまま {HoldLimit / 1024 / 1024}MB 読んだので、捨てずに流します");
            return false;
        }
        if (!Unlisted(packet)) return false;
        _discarded++;
        return true;
    }

    /// <summary>どの PMT も挙げていない PID の、スクランブルされたパケットか</summary>
    private bool Unlisted(ReadOnlySpan<byte> packet) =>
        (packet[1] & 0x80) == 0 && packet[3] >> 6 != 0 && !_listed[((packet[1] & 0x1F) << 8) | packet[2]];

    private void FinishCheck(string result)
    {
        _checking = false;
        _checked = $"{result} (本物の PAT {At(_realPatMs)}・PMT {At(_realPmtMs)}・捨てたのは {_discarded} パケット)";
    }

    /// <summary>
    /// 出力の先頭に差し込む、いまの PAT と観る局の PMT のパケット。覚えたものを本物で作り直していれば本物。
    /// 連続性カウンタは、溜めたぶんにその PID のパケットがあれば、そこへ続く値にする (無ければ 0 から)
    /// </summary>
    private byte[] Head(IReadOnlySet<int> wanted)
    {
        var head = new List<byte>();
        Append(0, _patLast!);
        foreach (var number in wanted.Order())
        {
            if (_pmts.TryGetValue(number, out var pmt) && _programs.TryGetValue(number, out var pid)) Append(pid, pmt);
        }
        return [.. head];

        void Append(int pid, byte[] section)
        {
            var count = (section.Length + 1 + PacketSize - 5) / (PacketSize - 4);
            var counter = FirstCounter(pid) is { } next ? next - count : 0;
            var at = 0;
            for (var index = 0; index < count; index++)
            {
                var packet = new byte[PacketSize];
                Array.Fill(packet, (byte)0xFF);
                packet[0] = SyncByte;
                packet[1] = (byte)((index == 0 ? 0x40 : 0) | (pid >> 8));
                packet[2] = (byte)pid;
                packet[3] = (byte)(0x10 | ((counter + index) & 0x0F));
                var start = 4;
                // pointer_field 0
                if (index == 0) packet[start++] = 0;
                var take = Math.Min(PacketSize - start, section.Length - at);
                section.AsSpan(at, take).CopyTo(packet.AsSpan(start));
                at += take;
                head.AddRange(packet);
            }
        }
    }

    /// <summary>溜めたぶんで最初に来た、その PID のパケットの連続性カウンタ。無ければ null</summary>
    private int? FirstCounter(int pid)
    {
        for (var at = 0; at < _held; at++)
        {
            var packet = _hold.AsSpan(at * PacketSize, PacketSize);
            if ((((packet[1] & 0x1F) << 8) | packet[2]) == pid) return packet[3] & 0x0F;
        }
        return null;
    }

    /// <summary>溜めている間に鍵の出どころへ問い合わせた回数と往復の合計 (ロックの待ちを含む)。<see cref="HeldAt"/> と同じ 1 行に足す</summary>
    public string CardUse() => !_keys
        ? "カード 使わない"
        : $"カード {_asks} 回 計 {_askMs}ms (待ち {_waitedMs}ms・キャッシュ {_cached} 回・未契約 {_unentitledAnswers} 回・準備 {At(_initMs)})";

    private static string At(long ms) => ms < 0 ? "-" : $"{ms}ms";

    /// <summary>
    /// 読んだぶんを復号して <paramref name="output"/> に書く。188 バイトに満たない尻尾は次まで残し、
    /// 先頭は揃うまで溜めるので、入れた長さと出る長さは揃わない (<see cref="HoldLimit"/>)
    /// </summary>
    public void Decode(ReadOnlySpan<byte> input, IBufferWriter<byte> output)
    {
        if (keysWanted?.Invoke() is { } wanted && wanted != _keys)
        {
            if (wanted) Rehold();
            else StopKeys(output);
        }
        if (services is not null) _services = services();
        if (!_recallTried) Recall();
        if (_carryLength > 0)
        {
            // 前の尻尾 (188 バイト以下) に続けて読む
            var total = _carryLength + input.Length;
            if (total > _carry.Length) Array.Resize(ref _carry, total);
            input.CopyTo(_carry.AsSpan(_carryLength));
            input = _carry.AsSpan(0, total);
        }
        var used = Scan(input, output);
        input[used..].CopyTo(_carry);
        _carryLength = input.Length - used;
    }

    /// <summary>
    /// 録れたものを丸ごと復号して書く (<c>/denpa/decode</c> と <c>--decode-file</c>)。書いたバイト数を返す。
    /// <paramref name="read"/> は読んだそのままの塊を受け取る (復号する前にスクランブルされていたパケットを数える)
    /// </summary>
    public long DecodeAll(Stream input, Stream output, Action<ReadOnlySpan<byte>>? read = null)
    {
        var buffer = new byte[PacketSize * 1024];
        var decoded = new ArrayBufferWriter<byte>();
        long written = 0;
        int count;
        while ((count = input.Read(buffer)) > 0)
        {
            read?.Invoke(buffer.AsSpan(0, count));
            decoded.ResetWrittenCount();
            Decode(buffer.AsSpan(0, count), decoded);
            output.Write(decoded.WrittenSpan);
            written += decoded.WrittenCount;
        }
        decoded.ResetWrittenCount();
        Flush(decoded);
        output.Write(decoded.WrittenSpan);
        return written + decoded.WrittenCount;
    }

    /// <summary>溜めているぶんを書き出す。**終わりに 1 回**。尻尾の半端なバイトは捨てる</summary>
    public void Flush(IBufferWriter<byte> output)
    {
        var whole = _carryLength >= PacketSize && _carry[0] == SyncByte;
        if (whole) Take(_carry.AsSpan(0, PacketSize), output);
        _carryLength = 0;
        if (_holding) Settle();
        Release(output);
    }

    /// <summary>188 バイトずつ切り出す。読み進めたバイト数を返す (残りは 188 バイト以下)</summary>
    private int Scan(ReadOnlySpan<byte> data, IBufferWriter<byte> output)
    {
        var at = 0;
        while (data.Length - at >= PacketSize)
        {
            if (_synced && data[at] == SyncByte)
            {
                Take(data.Slice(at, PacketSize), output);
                at += PacketSize;
                continue;
            }
            // 並びが崩れた。**0x47 が 188 バイトおきに 2 つ続くところ**で合わせ直す (1 つだけだと中身の 0x47 に合わせてしまう)
            _synced = false;
            var found = at;
            while (found + PacketSize < data.Length && (data[found] != SyncByte || data[found + PacketSize] != SyncByte)) found++;
            at = found;
            // 最後の 188 バイトの中の 0x47 は、次が来るまで同期バイトか決まらない
            if (found + PacketSize >= data.Length) return at;
            _synced = true;
        }
        return at;
    }

    /// <summary>
    /// 1 パケット。セクションを読み (ECM ならここで鍵を受け取る)、溜めている間は溜めたパケットの後ろへ、
    /// そうでなければ出力へ写してその場で復号する (**写すのは 1 回だけ**)
    /// </summary>
    private void Take(ReadOnlySpan<byte> packet, IBufferWriter<byte> output)
    {
        _packets++;
        // 誤りの印が立っているものは中身を読まない
        if ((packet[1] & 0x80) == 0 && packet[3] >> 6 == 0) Parse(packet);

        var held = _holding;
        if (held)
        {
            _hold ??= new byte[PacketSize * 1024];
            if ((_held + 1) * PacketSize > _hold.Length) Array.Resize(ref _hold, _hold.Length * 2);
            packet.CopyTo(_hold.AsSpan(_held++ * PacketSize));
            if ((packet[1] & 0x80) == 0 && packet[3] >> 6 != 0)
            {
                var ecm = Route(packet);
                // どの PMT もまだ挙げていない ES。その PMT を待つ (PmtsReady)
                if (ecm is null) _stray.Add(((packet[1] & 0x1F) << 8) | packet[2]);
                // ECM のあとで最初に来た、その鍵の ES のパケット (Settle)
                else if (ecm is { Seen: >= 0, After: int.MaxValue }) ecm.After = _held - 1;
            }
            if (Ready(out var narrowed)) Settle(narrowed);
        }
        Release(output);
        if (held) return;
        if (_draining && Drain(packet)) return;
        if (_checking && Check(packet)) return;

        var room = output.GetSpan(PacketSize)[..PacketSize];
        packet.CopyTo(room);
        if (Unscramble(room, Route(room), usable: true))
        {
            // 確かめ待ちの間は、復号できなかったものを流さない (書きかけの場所は進めずに捨てる)
            if (_checking)
            {
                _discarded++;
                return;
            }
            _undecodable++;
        }
        output.Advance(PacketSize);
    }

    private Ecm? Route(ReadOnlySpan<byte> packet) => _route[((packet[1] & 0x1F) << 8) | packet[2]] ?? _only;

    /// <summary>
    /// スクランブルされていたら復号する。誤りの印が立っているものは触らない。
    ///
    /// <para>
    /// **映像・音声の PES の先頭 (payload_unit_start) では、復号した中身が <c>00 00 01</c> で始まるかで鍵が合っているかを確かめる。**
    /// 確かめずに印を下ろすと、合わない鍵で化けた中身を「復号できた」として流し、契約の復号テストもそれで通ってしまう
    /// (PIX-DT295 で TS が欠けていた頃、CS の局で起きた。#2414)。偶奇の対応は STD-B25 のとおり 0b10 が偶数、0b11 が奇数の鍵で固定し、
    /// ほかの鍵は試さない。合わなければスクランブルされたまま流し、その PES の残りも
    /// 次の PES の先頭までスクランブルされたまま流す
    /// </para>
    ///
    /// <para>
    /// 復号できずにスクランブルされたまま残したら true。呼ぶ側が <see cref="Undecodable"/> に数えるか、確かめ待ちなら捨てる (<see cref="Check"/>)
    /// </para>
    /// </summary>
    private bool Unscramble(Span<byte> packet, Ecm? ecm, bool usable)
    {
        // 鍵の要らない利用者だけなら触らない (スクランブルされたままとしても数えない)
        if (!_keys || (packet[1] & 0x80) != 0 || packet[3] >> 6 == 0) return false;
        var start = PayloadStart(packet);
        if (start == PacketSize)
        {
            // 中身の無いパケット (アダプテーションだけ) は、印を下ろすだけで済む
            packet[3] &= 0x3F;
            _decoded++;
            return false;
        }
        // 契約が無い (同じ TS に入っている有料局)。復号の失敗には数えずにそのまま流す
        if (ecm is { Unentitled: true }) return false;
        if (start < 0 || !usable || ecm?.Cipher is not { HasKeys: true } cipher) return true;
        var pid = ((packet[1] & 0x1F) << 8) | packet[2];
        var control = packet[3] >> 6;
        var payload = packet[start..];
        var unitStart = _pes[pid] && (packet[1] & 0x40) != 0;
        if (!unitStart || payload.Length < 3)
        {
            // 先頭が短くて確かめられない PES は、前の PES が合わなかったことを引き継がずに、今の鍵で復号する
            if (unitStart) _garbled[pid] = false;
            if (_garbled[pid]) return true;
            cipher.Decrypt(ecm.Even(control), payload);
        }
        else if (!Verify(payload, ecm, control, pid))
        {
            _garbled[pid] = true;
            return true;
        }
        packet[3] &= 0x3F;
        _decoded++;
        return false;
    }

    /// <summary>
    /// PES の先頭を復号し、<c>00 00 01</c> で始まるかで鍵が合っているかを確かめる (<see cref="Unscramble"/>)。合えば復号したまま true、
    /// 合わなければスクランブルされた中身に戻して false
    /// </summary>
    private bool Verify(Span<byte> payload, Ecm ecm, int control, int pid)
    {
        Span<byte> original = stackalloc byte[PacketSize];
        original = original[..payload.Length];
        payload.CopyTo(original);
        _garbled[pid] = false;

        ecm.Cipher!.Decrypt(ecm.Even(control), payload);
        if (payload[0] == 0 && payload[1] == 0 && payload[2] == 1) return true;
        original.CopyTo(payload);
        LastError = $"PID 0x{pid:X4} の鍵が合いません (ECM 0x{ecm.Pid:X4})";
        Note(LastError);
        return false;
    }

    /// <summary>鍵が合わなかったことを記録に出す。同じ文を続けて出さない</summary>
    private void Note(string message)
    {
        if (_mismatch == message) return;
        _mismatch = message;
        Log.Write(message);
    }

    /// <summary>
    /// 溜めるのをやめてよいか。**PAT と、その PMT がみな来て、どの ECM も 1 回は応答を受け取った** (libaribb25 と同じ)
    /// うえで、ECM のあとにその鍵の ES のパケットが 1 つ来た (<see cref="Settle"/>)。
    /// 来ない PMT は 1 周で待つのをやめ (<see cref="PmtsReady"/>)、PMT がそろってから同じ ECM が 2 回来たら来ない ECM も待たない (<see cref="OnEcm"/>)。
    /// 観る局が決まっていれば、PAT とその局の PMT、その PMT が挙げた ECM だけを待つ (<see cref="TablesReady"/>・<see cref="Waits"/>)。
    /// そうして溜めるのをやめたら <paramref name="narrowed"/> が true
    /// </summary>
    private bool Ready(out bool narrowed)
    {
        narrowed = false;
        if ((long)_held * PacketSize >= HoldLimit)
        {
            Log.Write($"PAT・PMT・ECM が揃う前に {HoldLimit / 1024 / 1024}MB 溜まったので、待たずに流します");
            return true;
        }
        if (!TablesSettle()) return false;
        if (_pmtMs < 0 && !Unconfirmed()) _pmtMs = _clock.ElapsedMilliseconds;
        foreach (var ecm in _ecms.Values)
        {
            if (!Waits(ecm)) continue;
            if (ecm.Last is null || (ecm.Seen >= 0 && ecm.After == int.MaxValue)) return false;
        }
        narrowed = Narrowed() is not null;
        return true;
    }

    /// <summary>
    /// **観る局だけを待つときの、その局の並び。** 全部を待つなら null。局が決まっていない・PAT が来ていない・PAT に無い局がある
    /// (別のチャンネルの番号を渡された・臨時の番組が終わった) ときも null で、全部を待つ
    /// </summary>
    private IReadOnlySet<int>? Narrowed()
    {
        if (_services is not { Count: > 0 } wanted || _patLast is null) return null;
        foreach (var number in wanted)
        {
            if (!_programs.ContainsKey(number)) return null;
        }
        return wanted;
    }

    /// <summary>
    /// 溜めるのをやめる前に待つ PAT・PMT がそろったか。観る局が決まっていれば PAT とその局の PMT、決まっていなければ全部の局 (<see cref="PmtsReady"/>)
    /// </summary>
    private bool TablesReady()
    {
        if (_patLast is null) return false;
        if (Narrowed() is not { } wanted) return PmtsReady();
        foreach (var number in wanted)
        {
            if (!_pmts.ContainsKey(number)) return false;
        }
        return true;
    }

    /// <summary>
    /// 溜めるのをやめてよい PAT・PMT か (<see cref="TablesReady"/>)。**全部の局を待つ (録画がいる) なら、覚えたものでは流し始めない。**
    /// 覚えた PAT・PMT を使うのは観る局だけで溜めるのをやめるときに限る。録画は本物の PAT・PMT がそろうのを待つ
    /// </summary>
    private bool TablesSettle() => TablesReady() && (Narrowed() is not null || !Unconfirmed());

    /// <summary>
    /// 溜めるのをやめる前に答えを待つ ECM か。PMT が挙げた ECM のうち、観る局が決まっていればその局の PMT が挙げたものだけ。
    /// 先回りして取っておいただけのもの (<see cref="Early"/>) は待たない
    /// </summary>
    private bool Waits(Ecm ecm)
    {
        if (_ecms.GetValueOrDefault(ecm.Pid) != ecm) return false;
        if (Narrowed() is not { } wanted) return true;
        foreach (var number in wanted)
        {
            if (_programEcms.TryGetValue(number, out var pids) && pids.Contains(ecm.Pid)) return true;
        }
        return false;
    }

    /// <summary>全部の局の PMT がそろい、どの ECM も 1 回は答えを受けたか。観る局だけで溜めるのをやめたあと、捨てるのをやめる合図 (<see cref="Drain"/>)</summary>
    private bool AllReady()
    {
        if (!PmtsReady()) return false;
        foreach (var ecm in _ecms.Values)
        {
            if (ecm.Last is null) return false;
        }
        return true;
    }

    /// <summary>
    /// **まだ PMT か ECM の答えが無いので鍵を持てない、スクランブルされたパケットか。** 観る局だけで溜めるのをやめたあと、ほかの局の ES を
    /// スクランブルされたまま流さずに捨てる。ライブのサーバは 1 局に絞るので読まず、同じ選局をあとから共有した録画には、
    /// スクランブルされたままの ES が混ざるより途中から始まるほうが扱いやすい。鍵を受け取れなかった・契約が無い ECM の ES は、今までどおりそのまま流す
    /// </summary>
    private bool Drops(ReadOnlySpan<byte> packet) =>
        (packet[1] & 0x80) == 0 && packet[3] >> 6 != 0 && Route(packet) is not { Last: not null };

    /// <summary>
    /// 溜めるのをやめたあとの 1 パケット。捨てるなら true。ほかの局の PMT と ECM の答えがそろったら捨てるのをやめる。
    /// どの PMT も挙げていない PID のスクランブルされたパケットは <see cref="_stray"/> に入れ、来ない PMT を待つかを決める (<see cref="PmtsReady"/>)
    /// </summary>
    private bool Drain(ReadOnlySpan<byte> packet)
    {
        var drop = _keys && Drops(packet);
        if (drop && Route(packet) is null) _stray.Add(((packet[1] & 0x1F) << 8) | packet[2]);
        if (!_keys || AllReady())
        {
            StopDraining();
        }
        else if (_packets >= _drainUntil)
        {
            Log.Write($"ほかの局の PMT・ECM がそろわないので、捨てずに流します (捨てたのは {_dropped} パケット)");
            StopDraining();
        }
        if (!_draining || !drop) return false;
        _dropped++;
        return true;
    }

    private void StopDraining()
    {
        _draining = false;
        _stray.Clear();
    }

    /// <summary>
    /// **PAT と、来る PMT がそろったか。** PAT の PMT がみな来たらそろった。来ない PMT (地上波の臨時の番組) は、PAT が変わってから
    /// 同じ PMT がもう一度来たら待つのをやめる。**ただし、どの PMT も挙げていない PID のスクランブルされたパケットが来ていたら待ち続ける**
    /// (<see cref="_stray"/>)。PMT の間隔は番組ごとに違い、本番の地上波ではワンセグの PMT が番組の PMT より先にくり返し来ていた。
    /// そこで待つのをやめると、番組の ES をスクランブルされたまま流す
    /// </summary>
    private bool PmtsReady()
    {
        if (_patLast is null) return false;
        if (_allPmts) return true;
        if (!_pmtRepeated) return false;
        _stray.RemoveWhere(pid => _listed[pid]);
        return _stray.Count == 0;
    }

    /// <summary>
    /// 溜めたぶんを最初の鍵で復号しておく (出すのは <see cref="Release"/>)。溜めている間に来る中身は
    /// ECM ごとに 1 つだけ (2 つ目が来る前にここへ来る) なので、鍵は取り違えない。
    ///
    /// <para>
    /// **ECM より前のパケットは、ECM を挟んで続いている偶奇の並びだけ復号する。** ECM が持つのは今と次の
    /// 鍵で、ECM のあとに流れる鍵はそのどちらか。並びが途切れる前は前の鍵かもしれず、復号すると化けたものを
    /// 「復号できた」として流す (libaribb25 は溜めた先頭を丸ごと復号していた)。切り替わった直後に来た ECM はもう前の鍵を
    /// 持っていないので、ECM の手前で途切れた並びも復号しない。後ろから読み、ECM ごとに「この先で最初に
    /// 偶奇が変わる位置」を持って、それが ECM のあとの最初のパケット (<see cref="Ecm.After"/>) より後ろなら
    /// 復号する。**並びは ES ごとでなく ECM ごとに確かめる。** 音声のように疎らな ES だけで確かめると、偶奇が切り替わって
    /// 戻ったのを検出できない
    /// </para>
    /// </summary>
    private void Settle(bool narrowed = false)
    {
        _holding = false;
        _settledFor = narrowed ? string.Join("・", Narrowed()!.Order()) : null;
        Arrived();
        // 先回りして取っておいたもので、PAT・PMT が挙げなかったものは使わない
        _earlyEcms.Clear();
        _earlyPmtSections.Clear();
        _earlyPmts.Clear();
        _stray.Clear();
        // 観る局だけで溜めるのをやめた。ほかの局の PMT と ECM の答えがそろうまで、鍵を持てないものは捨てる (Drops)
        _draining = narrowed && _keys && !AllReady();
        _drainUntil = _packets + HoldLimit / PacketSize;
        // 覚えた PAT・PMT で流し始めた。本物で確かめ終わるまで、復号できないものを捨てる (Check)
        var recalled = narrowed && _keys && Unconfirmed();
        _checking = recalled;
        _checkUntil = _packets + HoldLimit / PacketSize;
        if (_held == 0) return;
        var usable = new bool[_held];
        for (var at = _held - 1; at >= 0; at--)
        {
            var packet = _hold.AsSpan(at * PacketSize, PacketSize);
            var control = packet[3] >> 6;
            if ((packet[1] & 0x80) != 0 || control == 0) continue;
            var ecm = Route(packet);
            if (ecm is not null)
            {
                if (ecm.Parity != control) ecm.Change = ecm.Next;
                ecm.Parity = control;
                ecm.Next = at;
            }
            usable[at] = ecm is { Seen: >= 0 } && (at > ecm.Seen || ecm.Change > ecm.After);
        }
        // 復号するのは前から。PES の先頭で鍵が合わなかったら、その PES の残りも復号しない (Unscramble)。鍵を持てないほかの局のものは詰めて捨てる
        var kept = 0;
        for (var at = 0; at < _held; at++)
        {
            var packet = _hold.AsSpan(at * PacketSize, PacketSize);
            if (_draining && Drops(packet))
            {
                _dropped++;
                continue;
            }
            if (_checking && Unlisted(packet))
            {
                _discarded++;
                continue;
            }
            if (Unscramble(packet, Route(packet), usable[at]))
            {
                if (_checking)
                {
                    _discarded++;
                    continue;
                }
                _undecodable++;
            }
            if (kept != at) packet.CopyTo(_hold.AsSpan(kept * PacketSize));
            kept++;
        }
        _held = kept;
        // サーバとクライアントは PMT を読むまで何も出さないので、覚えた PAT と PMT を溜めたぶんの前に置く (1 回だけ)
        if (recalled && !_settledOnRecall)
        {
            _settledOnRecall = true;
            _head = Head(Narrowed()!);
        }
    }

    /// <summary>
    /// 待っていた ECM (<see cref="Waits"/>) の届いた時刻のうち、いちばん遅いもの (<see cref="_arrivedMs"/>)。
    /// まだ届いていないものがあれば、時刻は「-」にしてその PID を出す。待つ ECM が無ければ両方「-」
    /// </summary>
    private void Arrived()
    {
        _arrivedMs = -1;
        _arrivedEcm = -1;
        foreach (var ecm in _ecms.Values.OrderBy(ecm => ecm.Pid))
        {
            if (!Waits(ecm)) continue;
            if (ecm.ArrivedMs < 0)
            {
                _arrivedMs = -1;
                _arrivedEcm = ecm.Pid;
                return;
            }
            if (ecm.ArrivedMs < _arrivedMs) continue;
            _arrivedMs = ecm.ArrivedMs;
            _arrivedEcm = ecm.Pid;
        }
    }

    /// <summary>
    /// **鍵の要らない利用者だけになった。** 溜めていたらスクランブルされたまま書き出し、鍵を捨てて、ECM で問い合わせるのをやめる。
    /// PAT・PMT は読み続ける (鍵の要る利用者が来たら、すぐ溜め直せるように)
    /// </summary>
    private void StopKeys(IBufferWriter<byte> output)
    {
        _keys = false;
        if (_holding) Settle();
        StopDraining();
        _checking = false;
        Release(output);
        foreach (var ecm in _ecms.Values) Forget(ecm);
    }

    /// <summary>
    /// **鍵の要る利用者が来た。** 先頭と同じように、どの ECM も応答を受け取るまで溜め直す (<see cref="Ready"/>)。
    /// 溜めたぶんは最初の鍵で復号する (<see cref="Settle"/>) ので、来た利用者には先頭から復号したものが届く
    /// </summary>
    private void Rehold()
    {
        /*
         * **内訳 (_patMs・_asks など) は戻さない。** 記録に出すのは選局して最初に送り出したときの 1 回だけ
         * (TunerPool.Descramble) で、溜め直しのあとには読まれない。PAT・PMT は持ったままで受け直さないので、
         * 戻すとそこは「-」のまま残り、かえって分かりにくい
         */
        _keys = true;
        _holding = true;
        StopDraining();
        _checking = false;
        foreach (var ecm in _ecms.Values) Forget(ecm);
    }

    /// <summary>ECM を受ける前の状態に戻す。次に来た ECM で問い合わせ直す</summary>
    private static void Forget(Ecm ecm)
    {
        ecm.Last = null;
        ecm.Pending = false;
        ecm.Cipher?.Clear();
        ecm.Unentitled = false;
        ecm.Told = false;
        ecm.RetryAt = long.MaxValue;
        ecm.Seen = -1;
        ecm.After = int.MaxValue;
        ecm.Parity = 0;
        ecm.Next = ecm.Change = int.MaxValue;
    }

    private void Release(IBufferWriter<byte> output)
    {
        if (_holding) return;
        if (_head is not null)
        {
            output.Write(_head);
            _head = null;
        }
        if (_held == 0) return;
        output.Write(_hold.AsSpan(0, _held * PacketSize));
        _hold = null;
        _held = 0;
    }

    /// <summary>中身の始まり。中身が無ければ 188、アダプテーションの長さが壊れていれば -1</summary>
    private static int PayloadStart(ReadOnlySpan<byte> packet)
    {
        var control = (packet[3] >> 4) & 0x03;
        if ((control & 0x01) == 0) return PacketSize;
        if ((control & 0x02) == 0) return 4;
        var start = 5 + packet[4];
        return start <= PacketSize ? start : -1;
    }

    private void Parse(ReadOnlySpan<byte> packet)
    {
        var start = PayloadStart(packet);
        if (start is < 0 or PacketSize) return;
        var pid = ((packet[1] & 0x1F) << 8) | packet[2];
        var unitStart = (packet[1] & 0x40) != 0;
        var section = pid == 0 ? _pat
            : _pmtSections.TryGetValue(pid, out var pmt) ? pmt
            : _ecms.TryGetValue(pid, out var ecm) ? ecm.Section
            : pid == CatPid && _cat is not null ? _cat
            : pid == _emmPid ? _emmSection
            : Early(pid, packet[start..], unitStart);
        if (section is not null) Feed(section, pid, packet[start..], unitStart);
    }

    /// <summary>
    /// **PAT・PMT にまだ無い PID を先に読む。** 溜めている間だけ、セクションの先頭 (payload_unit_start が立ったもの) の
    /// table_id が ECM (0x82) か、PAT より前なら PMT (0x02) のときに組み立て始める。
    ///
    /// <para>
    /// PAT → PMT → ECM → カードと順に待つと、それぞれの間隔 (どれも 0.1 秒ほど) が積み上がる。先に来たものを
    /// 取っておけば、PMT が来たその場でカードに問い合わせられる (次の ECM を待たない)。**経路と、溜めるのをやめる条件、カードに問い合わせるかは
    /// 確かめた PMT だけで決める** (<see cref="Rebuild"/> / <see cref="Ready"/>)。
    /// </para>
    ///
    /// <para>
    /// **先に読んだだけの ECM でその場でカードに問い合わせない。** 地上波には B-CAS のカードが断る ECM も流れていて、断られるまでに
    /// 短い応答の送り直し (<see cref="BCas"/>) ごと 0.4 秒ほどかかる。その間は次のパケットへ進まないので、PAT・PMT が
    /// そろうのも送り出しもそのぶん遅れていた (本番の地上波で、選局から送り出しまで毎回 1 秒ほど)。
    /// </para>
    ///
    /// <para>
    /// ES の PES は先頭が <c>00 00 01</c> なので、pointer_field 0・table_id 0x00 と読めて、ここでは ECM として読まない
    /// (スクランブルされた PES はそもそも読まない。<see cref="Take"/>)。
    /// </para>
    /// </summary>
    private Section? Early(int pid, ReadOnlySpan<byte> payload, bool unitStart)
    {
        if (!_holding) return null;
        if (_earlyEcms.TryGetValue(pid, out var known)) return known.Section;
        if (_earlyPmtSections.TryGetValue(pid, out var pmt)) return pmt;
        if (!unitStart || _earlyEcms.Count + _earlyPmtSections.Count >= EarlyLimit) return null;
        var table = 1 + payload[0];
        if (table >= payload.Length) return null;
        if (payload[table] == 0x82)
        {
            var ecm = new Ecm(pid);
            _earlyEcms[pid] = ecm;
            return ecm.Section;
        }
        if (payload[table] != 0x02 || _patLast is not null) return null;
        var section = new Section(null);
        _earlyPmtSections[pid] = section;
        return section;
    }

    /// <summary>
    /// パケットの中身をセクションに組み立てる。セクションはパケットを跨ぐし、1 つのパケットに
    /// 幾つも入ることもある (pointer_field が次のセクションの先頭を指す)
    /// </summary>
    private void Feed(Section section, int pid, ReadOnlySpan<byte> payload, bool unitStart)
    {
        if (!unitStart)
        {
            if (section.Active) Fill(section, pid, payload);
            return;
        }
        var pointer = payload[0];
        payload = payload[1..];
        // pointer_field の手前は前のセクションの続き。そこで揃わなければ捨てる
        if (section.Active && pointer <= payload.Length) Fill(section, pid, payload[..pointer]);
        section.Drop();
        if (pointer > payload.Length) return;
        // 揃ったセクションは捨てられるので、揃わないセクション (次のパケットへ続く) に当たるまで読む。0xFF は詰め物で、その先にセクションは無い
        for (payload = payload[pointer..]; !payload.IsEmpty && payload[0] != 0xFF && !section.Active;)
        {
            section.Start();
            payload = payload[Fill(section, pid, payload)..];
        }
    }

    /// <summary>セクションに足し、揃ったら読む。取り込んだバイト数を返す</summary>
    private int Fill(Section section, int pid, ReadOnlySpan<byte> data)
    {
        var taken = section.Append(data);
        if (section.Complete) Complete(section, pid);
        return taken;
    }

    private void Complete(Section section, int pid)
    {
        var bytes = section.Bytes;
        section.Drop();
        // PAT・PMT・ECM・CAT・EMM はどれも CRC を持つ形式。**化けたセクションで鍵を問い合わせ直さない・カードに渡さない**
        if ((bytes[1] & 0x80) == 0 || bytes.Length < 12 || Crc32(bytes) != 0) return;
        if (pid == 0) OnPat(bytes);
        else if (section.Owner is { } ecm) OnEcm(ecm, bytes);
        else if (section == _cat) OnCat(bytes);
        else if (section == _emmSection) OnEmm(bytes);
        else OnPmt(pid, bytes);
    }

    private void OnPat(ReadOnlySpan<byte> section)
    {
        if (section[0] != 0x00) return;
        if (_patRecalled && !_recalling && !ConfirmPat(section)) return;
        if (_patLast is not null && section.SequenceEqual(_patLast)) return;
        _patLast = section.ToArray();
        if (!_recalling)
        {
            if (_holding && _patMs < 0) _patMs = _clock.ElapsedMilliseconds;
            memory?.Pat(section);
        }
        _programs.Clear();
        var loop = section[8..^4];
        for (var at = 0; at + 4 <= loop.Length; at += 4)
        {
            var number = BinaryPrimitives.ReadUInt16BigEndian(loop[at..]);
            // 番組 0 は NIT の PID。PMT ではない
            if (number != 0) _programs[number] = BinaryPrimitives.ReadUInt16BigEndian(loop[(at + 2)..]) & 0x1FFF;
        }
        foreach (var pid in _pmtSections.Keys.Except(_programs.Values).ToList()) _pmtSections.Remove(pid);
        foreach (var pid in _programs.Values) _pmtSections.TryAdd(pid, new Section(null));
        foreach (var number in _pmts.Keys.Except(_programs.Keys).ToList()) _pmts.Remove(number);
        // 番組が変わった。来ていない PMT をもう一度待つ
        _pmtRepeated = false;
        Rebuild();
        /*
         * PAT より先に揃っていた PMT を、PAT が挙げた PID と突き合わせてから使う (Early)。
         * 違う PID から来ていたものは捨てる。組み立てかけのものは、これからは PAT の PID で組み立てる
         */
        _earlyPmtSections.Clear();
        foreach (var (number, (pid, early)) in _earlyPmts.ToList())
        {
            if (_programs.TryGetValue(number, out var expected) && expected == pid) OnPmt(pid, early);
        }
        _earlyPmts.Clear();
    }

    /// <summary>
    /// **覚えた PAT のあとに来た、最初の本物の PAT。** 同じなら確かめ終わりで、false を返す (読み直さない)。違えば、覚えた PMT のうち
    /// 本物が同じ PID で挙げていない局のもの (transport_stream_id が違えば全部) を捨てて true を返し、本物を読む。覚えておく側も同じように捨てる (<see cref="PsiMemory"/>)
    /// </summary>
    private bool ConfirmPat(ReadOnlySpan<byte> section)
    {
        _patRecalled = false;
        _realPatMs = _clock.ElapsedMilliseconds;
        if (_holding && _patMs < 0) _patMs = _realPatMs;
        if (section.SequenceEqual(_patLast)) return false;
        _recallDiffered = true;
        var moved = PsiMemory.Tsid(section) != PsiMemory.Tsid(_patLast);
        var programs = PsiMemory.Programs(section);
        foreach (var (number, pid) in _recalledPmts.ToList())
        {
            if (!moved && programs.TryGetValue(number, out var listed) && listed == pid) continue;
            _pmts.Remove(number);
            _recalledPmts.Remove(number);
        }
        return true;
    }

    private void OnPmt(int pid, ReadOnlySpan<byte> section)
    {
        if (section[0] != 0x02) return;
        var number = BinaryPrimitives.ReadUInt16BigEndian(section[3..]);
        // PAT より先に来た。PAT が来るまで取っておく (Early)
        if (_patLast is null)
        {
            _earlyPmts[number] = (pid, section.ToArray());
            return;
        }
        if (!_programs.TryGetValue(number, out var expected) || expected != pid) return;
        // PMT が届いた時刻は、取っておいた ECM を問い合わせる (Rebuild) 前に測る。後で測るとカードの往復が入る
        var arrived = _clock.ElapsedMilliseconds;
        // 覚えた PMT のあとに来た、その局の最初の本物の PMT。同じなら確かめ終わりで、作り直さない
        var recalled = !_recalling && _recalledPmts.Remove(number);
        if (recalled) _realPmtMs = arrived;
        if (_pmts.TryGetValue(number, out var last) && section.SequenceEqual(last))
        {
            // 覚えたものと同じだったのは、PAT が変わってからのくり返しではない
            if (!recalled) _pmtRepeated = true;
            else if (_holding && _pmtMs < 0 && !Unconfirmed() && TablesReady()) _pmtMs = arrived;
            return;
        }
        if (recalled) _recallDiffered = true;
        _pmts[number] = section.ToArray();
        if (!_recalling) memory?.Pmt(number, pid, section);
        Rebuild();
        /*
         * 覚えた PMT を読み込んでいる間は測らない。_patRecalled はまだ立っていないので Unconfirmed では弾けず、
         * 読み込んだ時刻が PMT の時刻に入って、本物の PAT より前の時刻が出ていた
         */
        if (!_recalling && _holding && _pmtMs < 0 && !Unconfirmed() && TablesReady()) _pmtMs = arrived;
    }

    /// <summary>
    /// ES → ECM の表を作り直す。PAT か PMT か、カードの方式が変わったとき (まれ) だけ。
    /// 作り直すと次の ECM が来るまで復号できなくなるので、引き続き要る ECM は鍵ごと残す
    /// </summary>
    private void Rebuild()
    {
        var streams = new List<(int Es, int Ecm, int Type)>();
        var wanted = new HashSet<int>();
        Array.Clear(_listed);
        _programEcms.Clear();
        foreach (var (number, pmt) in _pmts)
        {
            var own = new HashSet<int>();
            Streams(pmt, _caSystemId, streams, own, _listed);
            _programEcms[number] = own;
            wanted.UnionWith(own);
        }
        foreach (var pid in _ecms.Keys.Except(wanted).ToList()) _ecms.Remove(pid);
        // PMT より先に来ていた ECM なら、取っておいた中身ごと引き取る (Early)
        foreach (var pid in wanted) _ecms.TryAdd(pid, _earlyEcms.Remove(pid, out var early) ? early : new Ecm(pid));
        Array.Clear(_route);
        Array.Clear(_pes);
        Array.Clear(_garbled);
        foreach (var (es, ecm, type) in streams)
        {
            _route[es] = _ecms[ecm];
            _pes[es] = PesTypes.Contains(type);
        }
        _allPmts = _patLast is not null && _programs.Keys.All(_pmts.ContainsKey);
        _only = _allPmts && _ecms.Count == 1 ? _ecms.Values.First() : null;
        // 取っておいた中身で、PMT が挙げたいま問い合わせる。Ask の中で作り直すこともあるので、引き取ったままのものだけ
        foreach (var ecm in _ecms.Values.ToList())
        {
            if (!ecm.Pending || _ecms.GetValueOrDefault(ecm.Pid) != ecm) continue;
            ecm.Pending = false;
            Ask(ecm);
        }
    }

    /// <summary>
    /// PMT から、スクランブルされた ES とその ECM の PID を読み取る。**ES ごとの CA 記述子が番組全体のものより優先する**。
    /// ECM の有無によらず、挙げた ES の PID は <paramref name="listed"/> に印を付ける
    /// </summary>
    private static void Streams(ReadOnlySpan<byte> pmt, int caSystemId, List<(int Es, int Ecm, int Type)> streams, HashSet<int> ecms, bool[] listed)
    {
        var end = pmt.Length - 4;
        var at = 12 + (BinaryPrimitives.ReadUInt16BigEndian(pmt[10..]) & 0x0FFF);
        if (at > end) return;
        var common = CaPid(pmt[12..at], caSystemId);
        if (common >= 0) ecms.Add(common);
        while (at + 5 <= end)
        {
            var type = pmt[at];
            var es = BinaryPrimitives.ReadUInt16BigEndian(pmt[(at + 1)..]) & 0x1FFF;
            var length = BinaryPrimitives.ReadUInt16BigEndian(pmt[(at + 3)..]) & 0x0FFF;
            at += 5;
            if (at + length > end) return;
            var own = CaPid(pmt.Slice(at, length), caSystemId);
            at += length;
            listed[es] = true;
            var ecm = own >= 0 ? own : common;
            if (ecm < 0) continue;
            ecms.Add(ecm);
            streams.Add((es, ecm, type));
        }
    }

    /// <summary>
    /// CAT。CA 記述子 (0x09) のうち、このカードの方式の CA_PID が EMM の PID (libaribb25 の <c>proc_cat</c>)。
    /// CA 記述子の形は PMT の ECM と同じ
    /// </summary>
    private void OnCat(ReadOnlySpan<byte> section)
    {
        if (section[0] != 0x01 || (_catLast is not null && section.SequenceEqual(_catLast))) return;
        _catLast = section.ToArray();
        FindEmm();
    }

    /// <summary>持っている CAT から EMM の PID を決め直す。**PID が替わったら、組み立てかけのセクションを捨てる**</summary>
    private void FindEmm()
    {
        if (_catLast is null) return;
        var pid = CaPid(_catLast.AsSpan(8, _catLast.Length - 12), _caSystemId);
        if (pid != _emmPid) _emmSection?.Drop();
        _emmPid = pid;
    }

    /// <summary>
    /// EMM の PID に来たセクション。EMM (0x84) だけを渡し先に渡し、自分宛てかはそこで比べる (<see cref="Emm.Section"/>)。
    /// EMM メッセージ (0x85) は契約を変えないので読み飛ばす。**鍵の要らない利用者だけのときも渡す**
    /// </summary>
    private void OnEmm(ReadOnlySpan<byte> section)
    {
        if (section[0] == 0x84) emm!.Section(section);
    }

    /// <summary>CA 記述子 (0x09) から、このカードの方式の ECM (CAT なら EMM) の PID。無ければ -1</summary>
    private static int CaPid(ReadOnlySpan<byte> descriptors, int caSystemId)
    {
        for (var at = 0; at + 2 <= descriptors.Length; at += 2 + descriptors[at + 1])
        {
            var length = descriptors[at + 1];
            var body = descriptors[(at + 2)..];
            if (descriptors[at] != 0x09 || length < 4 || length > body.Length) continue;
            if (BinaryPrimitives.ReadUInt16BigEndian(body) != caSystemId) continue;
            var pid = BinaryPrimitives.ReadUInt16BigEndian(body[2..]) & 0x1FFF;
            // 0x1FFF は「無い」の意味で置かれる
            return pid is 0 or 0x1FFF ? -1 : pid;
        }
        return -1;
    }

    /// <summary>
    /// ECM を受けた。**中身が変わっていたら、その場で鍵を受け取る。** 同じ中身なら、受け取れなかったものだけ
    /// 少し置いて問い合わせ直す。溜めている間に、PMT がそろってから同じ PID の ECM がもう一度来たら、そこで溜めるのをやめる。
    /// 1 周しても来ない ECM は来ないし、中身が変わる前に溜めたぶんを最初の鍵で復号しておく (<see cref="Settle"/>)。
    ///
    /// <para>
    /// **PMT がそろうまでは、ECM がもう一度来ても溜めるのをやめない** (<see cref="PmtsReady"/>)。ECM は PMT より短い間隔で来ることがあり、
    /// 本番の地上波では、まだ PMT の来ていない番組の ES をスクランブルされたまま流していた。待つ間に中身が変わったら、
    /// 新しい中身を受けた位置から数え直す (それより前は、新しい ECM を挟んで続く偶奇の並びだけを新しい鍵で復号する)
    /// </para>
    /// </summary>
    private void OnEcm(Ecm ecm, ReadOnlySpan<byte> section)
    {
        if (section[0] != 0x82) return;
        // 届いた時刻は、PMT が挙げる前に先回りして取っておいたもの (Early) でも数える
        if (_holding && ecm.ArrivedMs < 0) ecm.ArrivedMs = _clock.ElapsedMilliseconds;
        // 鍵の要らない利用者だけならカードに問い合わせない (Rehold で問い合わせ直す)
        if (!_keys) return;
        var listed = _ecms.GetValueOrDefault(ecm.Pid) == ecm;
        // 溜めるのをやめる合図にするのは、待っている PMT が挙げた ECM だけ。先回りして取っておいただけのもの (Early) は PAT・PMT を待たせない
        if (_holding && ecm.Last is not null && Waits(ecm) && TablesSettle()) Settle(Narrowed() is not null);
        if (ecm.Last is { } last && section.SequenceEqual(last))
        {
            if (_packets >= ecm.RetryAt) Ask(ecm);
            return;
        }
        ecm.Last = section.ToArray();
        if (_holding)
        {
            ecm.Seen = _held;
            ecm.After = int.MaxValue;
        }
        // PMT がまだ挙げていないものは取っておくだけ。挙げたら Rebuild が問い合わせる
        if (listed) Ask(ecm);
        else ecm.Pending = true;
    }

    /// <summary>
    /// 鍵を受け取って入れる。古い鍵で復号し続けると化けたものを流すので、**失敗したら鍵を捨てる。**
    /// **渡すのはセクションの先頭 8 バイトと末尾の CRC 4 バイトを除いた中身。** libaribb25 と同じ切り方で、
    /// 拠点を跨いで鍵を受け取るとき (CardShare.cs) もこれを運ぶ。変えると古いエージェントとやり取りできなくなる
    /// </summary>
    private void Ask(Ecm ecm)
    {
        ecm.RetryAt = long.MaxValue;
        ecm.Unentitled = false;
        ecm.Cipher?.Clear();
        try
        {
            if (_init is null)
            {
                var opening = _clock.ElapsedMilliseconds;
                _init = source.Init();
                if (_holding) _initMs = _clock.ElapsedMilliseconds - opening;
                // A-CAS など B-CAS 以外のカードなら、CA 記述子を選び直す (この ECM はもう要らないかもしれない)
                if (_init.CaSystemId != _caSystemId)
                {
                    _caSystemId = _init.CaSystemId;
                    ecm.Last = null;
                    FindEmm();
                    Rebuild();
                    return;
                }
            }
            var section = ecm.Last!;
            var asked = _clock.ElapsedMilliseconds;
            var answer = source.Ecm(section.AsSpan(8, section.Length - 12));
            var entitled = answer.Code is 0x0200 or 0x0400 or 0x0800;
            if (_holding)
            {
                _ecmMs = _clock.ElapsedMilliseconds;
                _lastEcm = ecm.Pid;
                _asks++;
                _askMs += _ecmMs - asked;
                _waitedMs += answer.WaitedMs;
                if (answer.Cached) _cached++;
                if (!entitled) _unentitledAnswers++;
            }
            // 0x0200・0x0400・0x0800 が「視聴できる」。それ以外は契約が無い
            if (!entitled)
            {
                // 同じ TS の有料局は鍵が変わるたびにここへ来るので、記録は ECM ごとに 1 回だけ出す。
                // Report を通すと、受け取れた局の「受け取れるようになりました」と交互に出続ける
                ecm.Unentitled = true;
                LastError = $"カードが鍵を返しません (未契約か、別の方式の局です: 0x{answer.Code:X4})";
                if (!ecm.Told) Log.Write($"鍵を受け取れません: {LastError} (ECM 0x{ecm.Pid:X4})");
                ecm.Told = true;
                return;
            }
            ecm.Cipher ??= new Multi2(_init.SystemKey, _init.InitCbc);
            ecm.Cipher.SetKeys(answer.Odd, answer.Even);
            if (_logged is not null) Log.Write("鍵を受け取れるようになりました");
            _logged = null;
        }
        catch (Exception error)
        {
            ecm.RetryAt = _packets + RetryPackets;
            Report(error.Message);
        }
    }

    private void Report(string message)
    {
        LastError = message;
        if (_logged != message) Log.Write($"鍵を受け取れません: {message}");
        _logged = message;
    }

    /// <summary>MPEG-2 の CRC32。セクションの末尾の CRC まで含めて回すと 0 になる</summary>
    internal static uint Crc32(ReadOnlySpan<byte> data)
    {
        var crc = 0xFFFFFFFFu;
        foreach (var value in data) crc = (crc << 8) ^ CrcTable[(crc >> 24) ^ value];
        return crc;
    }

    private static readonly uint[] CrcTable = Enumerable.Range(0, 256).Select(index =>
    {
        var crc = (uint)index << 24;
        for (var bit = 0; bit < 8; bit++) crc = (crc & 0x80000000) != 0 ? (crc << 1) ^ 0x04C11DB7 : crc << 1;
        return crc;
    }).ToArray();

    /// <summary>1 本の ECM と、その鍵</summary>
    private sealed class Ecm
    {
        public Ecm(int pid)
        {
            Pid = pid;
            Section = new Section(this);
        }

        public int Pid { get; }

        public Section Section { get; }
        /// <summary>最後に受けた中身 (その鍵を問い合わせた中身)</summary>
        public byte[]? Last;
        /// <summary><see cref="Last"/> でまだカードに問い合わせていない (PMT が挙げる前に来た。<see cref="Early"/>)</summary>
        public bool Pending;
        /// <summary>鍵。受け取れなかったら空 (<see cref="Multi2.HasKeys"/>)</summary>
        public Multi2? Cipher;
        /// <summary>カードが「契約が無い」と返した</summary>
        public bool Unentitled;
        /// <summary>契約が無いことを記録に出した。その ECM を忘れる (<c>Forget</c>) まで 1 回だけ出す (問い合わせ直しのたびに出すと、鍵が変わるたびに記録が並ぶ)</summary>
        public bool Told;
        /// <summary>鍵を受け取れなかった。読んだパケットの数がここを過ぎたら、同じ中身でも問い合わせ直す</summary>
        public long RetryAt = long.MaxValue;
        /// <summary>溜めている間に最初のセクションが届いた時刻 (ミリ秒。まだなら -1)。<see cref="Forget"/> でも戻さない (記録に出すのは選局して最初の 1 回だけ)</summary>
        public long ArrivedMs = -1;
        /// <summary>溜めている間に最初の中身を受けた位置 (溜めたパケットの中の番号)。まだなら -1</summary>
        public int Seen = -1;
        /// <summary>そのあとで最初に来た、この鍵の ES のパケットの位置</summary>
        public int After = int.MaxValue;
        /// <summary><see cref="Settle"/> が後ろから読む間だけ使う。すぐ後ろの偶奇と位置、その先で最初に偶奇が変わる位置</summary>
        public int Parity, Next = int.MaxValue, Change = int.MaxValue;
        /// <summary>transport_scrambling_control に使う鍵が偶数か。0b10 が偶数、0b11 が奇数 (0b01 は使われないが、奇数の鍵で復号する)</summary>
        public bool Even(int control) => control == 2;
    }

    /// <summary>組み立て中のセクション。長さは先頭 3 バイトで決まる (最長 3 + 4095)。長さが -1 なら組み立てていない</summary>
    private sealed class Section(Ecm? owner)
    {
        private readonly byte[] _buffer = new byte[3 + 0x0FFF];
        private int _length = -1;

        public Ecm? Owner => owner;
        public bool Active => _length >= 0;
        private int Total => _length < 3 ? 3 : 3 + (((_buffer[1] & 0x0F) << 8) | _buffer[2]);
        public bool Complete => _length >= 3 && _length == Total;
        public ReadOnlySpan<byte> Bytes => _buffer.AsSpan(0, _length);
        public void Start() => _length = 0;
        public void Drop() => _length = -1;

        /// <summary>要るぶんだけ取り込み、取り込んだバイト数を返す</summary>
        public int Append(ReadOnlySpan<byte> data)
        {
            var taken = 0;
            while (taken < data.Length && _length < Total) _buffer[_length++] = data[taken++];
            return taken;
        }
    }
}
