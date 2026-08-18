/**
 * ライブ視聴の受け側。**WebSocket で受けて MSE へ流す。**
 *
 * MSE は取ってこない。`appendBuffer()` に渡すバイト列をどこから持ってくるかは
 * こちら次第で、denpa は WebSocket から受ける ([stream.md](../../docs/stream.md) §5.3)。
 * 同じ1本に字幕もデータ放送も相乗りする作りなので、種別で振り分ける。
 */

import type { AudioTrack } from '$lib/arib';
import { eachFrame } from '$lib/components/player/frames';
import { clearOverlay, drawOverlay } from '$lib/components/player/paint';
import { forget, read, write } from '$lib/keep';
import {
    type CaptionTrack,
    CHANNEL,
    type Command,
    type HybridcastLink,
    LAST_COOKIE,
    type LiveCodec,
    type Notice,
    SOCKET_PATH,
    type Tuned,
} from '$lib/live';
import { CLOCK, type Cue, currentCue, insertCue, trimCues } from '$lib/ts/captions';
import { CEILING, FLOOR, nextTarget, pacing } from '$lib/ts/pacing';
import type { ResponseMessage } from '$lib/vendor/web-bml/server/ws_api';

export type LiveState = 'idle' | 'connecting' | 'playing' | 'error';

/**
 * 遅れて見られる長さ (秒)。**止めている間も受け取り続けるので、上限が要る。**
 *
 * ブラウザが抱えられる量には上限があり、超えると `appendBuffer` が落ちる。
 * 5分あれば、電話に出て戻ってくるくらいは追いつける。
 */
const KEEP = 300;
/**
 * 抱えてよい量 (バイト)。**時間だけで切ると、太い絵で溢れる。**
 *
 * 5分は「毎秒 3Mbit なら 110MB」のつもりで決めた値だった。ところが焼き方は
 * 選べるようになっていて (`LiveCodec`)、H.264 は絵を優先するので実測 35.9Mbit/s
 * ある — そのまま5分持つと **1.3GB** で、ブラウザの上限 (数百MB) を軽く超える。
 * 超えると `appendBuffer` が `QuotaExceededError` で落ち、**そこから絵が出ない**。
 *
 * なので**時間とバイト数の小さいほう**で切る。太ければ戻れる幅が縮むだけで、
 * 映らなくなるよりはるかにいい
 */
const BUDGET = 120 * 1024 * 1024;
/** 戻れる幅の下限 (秒)。ここまで縮めても足りないなら、そもそも抱えられない */
const KEEP_LEAST = 20;
/** 貯める量を決め直す間隔 (ms)。塊は毎秒20個来るので、そのたびには回さない */
const SETTLE_EVERY = 5_000;
/**
 * 選局や跳んだ直後、詰まりを数えない間 (ms)。
 *
 * **自分で起こした詰まりで貯める量を増やさない。** 器を作り直せば必ず
 * `waiting` が上がるし、跳べば読み込み直しになる。宅外で本当に届かない
 * のとは別ものなので、混ぜると遅延が伸びたまま戻らない
 */
const GRACE = 3_000;
/**
 * 前の絵を貼っておく上限 (ms)。**次が出なくても、いつかは剥がす。**
 *
 * 貼りっぱなしにすると、選局に失敗したときに「前のチャンネルが止まっている」
 * 画面が残る。壊れているのに動いて見えるのがいちばん悪い
 */
const HOLD_MOST = 6_000;
/**
 * 繋ぎが切れたときに待つ時間 (ms)。**倍々に伸ばして、この上限で頭打ち。**
 *
 * いちばん多いのは**サーバの入れ替え** (デプロイ)。器ごと作り直すので数十秒
 * 帰ってこないが、帰ってくることは分かっている。切れた時点で諦めていた頃は、
 * 観ている最中に「選んでください」に戻って**自分で選び直す**ことになっていた
 */
const RETRY_FIRST = 1_000;
const RETRY_MOST = 10_000;
/**
 * 絵だけがこれだけ遅れたら跳び直す (秒)。**口の動きが合わなくなる境目。**
 *
 * 1コマ (0.017秒) 遅れるのは普通で、そこで跳び直すと跳んでばかりになる。
 * 声と口のずれが分かりはじめるのは 0.1 秒あたり、はっきり分かるのが 0.2 秒。
 * その手前で直す。
 *
 * **0.15 から下げた。** 実機 (Chromium・切り替えと途切れを起こしながら 18000 コマ)
 * で測ると、無事なときの遅れは中央 -0.015 秒・最大 0.058 秒でした。0.15 は
 * 「はっきり分かる」に近すぎて、**分かるのに直らない帯**が残る
 */
const SLIP_MOST = 0.1;
/** 跳び直す間隔の下限 (ms)。**復号が追いつかない状態は跳んでも直らない** */
const UNSLIP_EVERY = 3_000;
/*
 * **コマ落ちでは跳び直さない。**
 *
 * 実機の Windows Edge (152) を CDP で動かして測ると、落ち着いたあとでも
 * **絶えず 5.6% 落ちて**いました (10秒で 600コマ中 34コマ。選局の直後だけ
 * もっと多い)。止まないものを合図にすると、**3秒ごと (`UNSLIP_EVERY` の上限)
 * に跳び続ける** — 実測で跳び直しが 90秒に 31回、途切れだけを合図にすると
 * 同じ 90秒で 1回でした。跳ぶたびに音が 0.02 秒飛ぶので、癖になっては困る。
 *
 * **コマ落ちが増えるわけではありません** (跳ぶ版と跳ばない版で 12秒あたり
 * 118〜134 と変わらなかった)。合図として使えないだけです
 */
/** 跳び直すときに進める幅 (秒)。**1コマぶん** — 音が飛んだと分かる長さではない */
const FRAME = 0.02;

/**
 * データ放送の知らせを、器ができるまでに取っておく数 (`heldData`)。
 *
 * **待つのは 700KB を落とす間だけ**なので、実測 (毎秒20通ほど) からすれば
 * 数十で足りる。それでも上限を置くのは、**モジュールは1通が 100KB を超える**
 * ことがあるため — 器がついに立たなかったときに、際限なく抱え込ませない
 */
const HOLD_DATA = 300;

/**
 * 見ている局を覚える。**置き場は cookie 1つ。**
 *
 * **読むのはサーバ** (`live/+page.server.ts`)。次に開いたとき、画面が繋いで
 * くるのを待たずに焼きはじめるため (`server/live.ts` の `warm`)。localStorage
 * にも持っていた頃があるが、**二重に持つと決め方がずれる** — 先に焼いたものが
 * 使われず、画面は別の局を開く、という形で静かに壊れる。
 *
 * **音声も覚える。** 番組が変われば構成も変わる (二カ国語の映画が終われば
 * ステレオに戻る) が、サーバは無いものを頼まれたら先頭に落とす
 * (`arib.pickTrack`) ので、古い合言葉が残っていても困らない
 */
function remember(target: Tuned): void {
    const value = encodeURIComponent(JSON.stringify(target));
    document.cookie = `${LAST_COOKIE}=${value}; path=/live; max-age=31536000; samesite=lax`;
}

/**
 * 覚えておく「これより下へは貯めない量」の置き場 (`ts/pacing` の `nextTarget`)。
 *
 * **端末ごとに覚える。** 開くたびに `FLOOR` (0.2秒) から始めていた頃は、
 * **開いて30秒以内に必ず1回止まって**いた — 0.2秒はどの経路でも足りないので、
 * 毎回そこから当たりを探し直すことになる。前に落ち着いた高さから始めれば、
 * 探し直しは経路が変わったときだけになる。
 *
 * サーバではなく端末に置く。**これは経路の性質**で、同じ人でも宅内のPCと
 * 出先のタブレットでは別の値になる (続きの位置 `resume_ms` とは逆の理由)
 */
const FLOOR_KEY = 'live-floor';

function storedFloor(): number {
    // 読めない繋ぎ (プライベート窓) では下限から始める (`keep.read`)
    const saved = Number(read(FLOOR_KEY));
    if (!Number.isFinite(saved)) return FLOOR;
    return Math.min(CEILING, Math.max(FLOOR, saved));
}

function rememberFloor(seconds: number): void {
    write(FLOOR_KEY, String(seconds));
}

/**
 * 忘れる。**まっさらな端末と同じ状態に戻す** (`relearn`)。
 *
 * 下限を書き込むのではなく消す。「一度も測っていない」と「測って下限だった」
 * を分けて持つ意味が無い
 */
function clearFloor(): void {
    forget(FLOOR_KEY);
}

export function livePlayer() {
    let state = $state<LiveState>('idle');
    let message = $state('');
    let tuned = $state<Tuned | null>(null);
    /** 音を止められているか。**自動再生を断られたときだけ立つ** */
    let silenced = $state(false);
    /**
     * 放送からどれだけ遅れているか (秒)。**受け取った最後の絵と、いま映して
     * いる絵の差。** ここが遅延の大半で、焼き方より効く。出しているのは、
     * 詰まりが増えていないかを見ながら詰めていくため
     */
    let delay = $state<number | null>(null);
    /** 止めているか。**押して止めた間も受け取り続ける** */
    let paused = $state(false);
    /** 放送の今に張り付いているか。離れていれば「ライブへ」を出す */
    let live = $state(true);
    /**
     * 追っかけ再生か。**わざと遅れて見ている状態。**
     *
     * 止めたときと、帯を後ろへ戻したときに立つ。立っている間は放送の今を
     * 追いかけず (跳ばない)、選ばれた速さで進む。追いついたら自分で下りる
     */
    let chasing = $state(false);
    /** 追っかけ中の速さ。ライブに戻れば 1 に戻す */
    let speed = $state(1);
    /**
     * 縮めるときの行き先の下限 (秒)。**止まった高さを覚えている** (`nextTarget`)。
     *
     * 選局しても持ち越す — 変わったのは映すものであって、経路ではない。
     * **開き直しても持ち越す** (`storedFloor`)。0.2秒から始めていた頃は、
     * 開いて30秒以内に必ず1回止まっていた
     */
    const initialFloor = storedFloor();
    let floor = $state(initialFloor);
    /**
     * どれだけ貯めているか (秒)。詰まると伸び、無事が続くと縮む。
     * **始まりは下限と同じで、あとは別々に動く** (`floor` を写すのは最初だけ。
     * `$state(floor)` と書くと Svelte が「初期値しか写さないが良いか」と聞く — 良い)
     */
    let target = $state(initialFloor);
    /**
     * どこまで戻れて、いまどこに居るか。**操作の帯を描くのに使う。**
     *
     * 0.1秒刻みで入れ直す。塊は毎秒20個来るので、そのたびに動かすと
     * 画面を無駄に描き直すことになる
     */
    let oldest = $state(0);
    let newest = $state(0);
    let position = $state(0);
    /** 選べる音声。1つしか無ければ画面は切り替えを出さない */
    let audios = $state<AudioTrack[]>([]);
    /** いま鳴らしている音声 (`AudioTrack.id`) */
    let audio = $state('');
    /** いま焼いてもらっている形。**サーバが返してきたものを持つ** */
    let codec = $state<LiveCodec>('h264');
    /**
     * 断り書き。**失敗ではないが、頼まれたとおりにできなかったとき。**
     *
     * いまのところ「AV1 を出せない端末なので H.264 に戻した」の1つだけ。
     * `message` と分けてあるのは、あちらが選局のたびに消えるため — 戻した理由は
     * 戻した先が映り始めても残っていないと、なぜ変わったのか分からない
     */
    let warning = $state('');
    /** 前の絵を貼っているか。**次の絵が出るまでの黒を埋める** */
    let holding = $state(false);
    /**
     * データ放送を出すか。**押して切り替える** (テレビの d ボタン)。
     *
     * サーバは頼まれてから解くので (`server/live.ts` の `wantData`)、押すまでは
     * 何も届かない。**局を変えても押したままにする** — 押した人にとっては
     * 「出している」が続いているので、そのつど押し直させる筋合いが無い
     */
    let showData = $state(false);
    /** データ放送の知らせを渡す先。**描いているものが居るときだけ** */
    let onData: ((message: ResponseMessage) => void) | null = null;
    /**
     * 器ができるまでの控え。**押した直後のぶんを捨てない。**
     *
     * サーバは押された瞬間に、番組・PMT・溜まっているモジュールをまとめて
     * 送ってくる。ところが描く側は 700KB を落としてから立ち上がるので、
     * **その間に来たぶんが宛先の無いまま捨てられていた**。入口の BML は
     * 番組 (`programInfo`) を待ってから開くので、それを落とすと**押しても
     * 何も出ない**。しかも捨てたものは二度と来ない (カルーセルが一周する
     * までモジュールは繰り返すが、番組は一度きり)。
     *
     * 実機では「1局目は出ないのに、局を変えると出る」形で出た —
     * 2度目は落とし済みで待ちが無いので、間に合っていた
     */
    let heldData: ResponseMessage[] = [];
    /** 字幕を出すか。**押して切り替えられる** (テレビの字幕ボタン) */
    let captions = $state(true);
    /**
     * 選べる字幕。**1枚も届いていなくても分かる。**
     *
     * 届いてから切り替えを出していた頃は、**間隔の空く番組を開くとボタンが
     * 出なかった** (実機の「みんなの手話」。番組表には [字] と出ているのに)。
     * 放送が字幕を持っているかどうかはサーバが入口で読んでいる
     */
    let captionTracks = $state<CaptionTrack[]>([]);
    /** いま出している字幕 (`CaptionTrack.index`) */
    let captionTrack = $state(0);
    /**
     * この番組に載っている Hybridcast。**在ることを言うだけ。**
     *
     * denpa は動かさない — 押すと別のタブで開くだけで、受信機の API は
     * 用意していない ([docs/stream.md](../../docs/stream.md#58-hybridcast))
     */
    let hybridcast = $state<HybridcastLink[]>([]);
    /**
     * 追っかけ再生 ([issue #16](https://github.com/danything/denpa/issues/16))。
     * 観ている録画と、**いまの ffmpeg が 0 と数える位置** (base 秒)。
     * シークで焼き直すたびに base が変わる。画面に見せる位置は base + position
     */
    let chase = $state<{ recordingId: number; base: number } | null>(null);
    /** 追っかけの物差し (`timeline` の知らせ)。録画中は右端を壁時計で伸ばして読む */
    let chaseTimeline = $state<{
        recordedSec: number;
        totalSec: number;
        finished: boolean;
        since: number;
    } | null>(null);
    /** 追っかけが録れているところまで読み切ったか */
    let chaseEnded = $state(false);
    /** 読み切ったら、流し残しが尽きたところで器を締める (`finishStream`) */
    let ending = false;

    let socket: WebSocket | null = null;
    let source: MediaSource | null = null;
    let buffer: SourceBuffer | null = null;
    /** いま鳴らしている器。押して音を出すのに要る */
    let element: HTMLVideoElement | null = null;
    /** 前の絵の写し先。画面から預かる */
    let still: HTMLCanvasElement | null = null;
    /** 字幕を重ねる先。画面から預かる */
    let overlay: HTMLCanvasElement | null = null;
    /** 貼りっぱなしを避けるための目覚まし */
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    /**
     * 待たせている字幕。**時刻の順に並べておく** ([ts/captions.ts](./ts/captions.ts))。
     *
     * 時刻はサーバが添えてくる — **映像と同じ ffmpeg が付けた、mp4 の物差し**
     * なので、再生位置と直に比べられる。焼く手間のぶん字幕のほうが先に届くので、
     * 再生位置が追いつくまで持っておく
     */
    let cues: Cue[] = [];
    /** いま重ねている1枚。同じものを描き直さない */
    let shown: Cue | null = null;
    /**
     * 選局の代。**絵にし終わる頃には局が変わっていることがある。**
     *
     * PNG を `ImageBitmap` にするのは非同期なので、その間に選び直されると
     * 前の局の字幕が新しい局の上に出る。番号が変わっていたら捨てる
     */
    let generation = 0;
    /** もう再生を始めたか。始めるまでは貯める */
    let running = false;
    /**
     * 描かれずに捨てられたコマの数。**画面に出す** (`live/+page.svelte`)。
     *
     * **「音と字幕は合っているのに、絵だけ遅れる」の切り分けに要る。**
     * 出しているのは `currentTime` に合う字幕なので、音・字幕・再生位置は
     * 同じ時計の上に乗っている。**絵だけが遅れるなら、遅れているのは復号**で、
     * 貯め方でも運び方でもない (どちらも遅れれば時計ごと遅れる)。
     *
     * 遅延の数字にも出ない — あれは「放送の今と再生位置の差」なので、
     * 絵が何コマ遅れて出ていても変わらない。**それでこの数が要る**
     */
    let dropped = $state(0);
    /**
     * 映した1枚が、再生位置からどれだけ遅れているか (秒)。**絵だけの遅れ。**
     *
     * 音と字幕は再生位置 (`currentTime`) に乗っているので、ここが開くと
     * **口の動きだけが合わなくなる**。開いたままにしない (`unslip`)
     */
    let slip = $state(0);
    /** 跳び直した回数。**画面に出す** — 直し続けているなら、まだ足りていない */
    let slips = $state(0);
    /**
     * 絵の遅れの、これまでの最大 (秒)。**器を作り直すと 0 に戻る。**
     *
     * いまの値 (`slip`) だけでは役に立ちません — 見て「ずれている」と思った
     * ときには、たいてい `unslip` が既に直しています。**跳び直す前にどこまで
     * 開いたか**が、口の合わなさの正体かどうかを分ける唯一の数です。
     *
     * ここが 0 のままなのに絵と音が合わないなら、遅れているのは**描く側では
     * なく中身のほう** (焼いた時点で映像と音声がずれている) で、跳び直しても
     * 直りません
     */
    let slipMost = $state(0);
    /** 次に跳び直してよい時刻 */
    let unslipAfter = 0;
    /*
     * **絵の遅れは JS からは見えないことがある。** `mediaTime` で分かるのは
     * 「合成器へ渡したコマ」で、Windows の Chrome / Edge はそれを DOM とは
     * 別の面に出すため、**面のほうが遅れていても数字には出ません**。実機では
     * 「絵と音がずれるのに『絵の遅れ直し』は一度も出ない、読み直すと直る」
     * という形で出ていました。
     *
     * 見えないものは測れないので、**起きる条件のほうで引きます** — 途切れ
     * (`stalled`) です。跳び直しの元手は `unslip` の1コマぶんで、どのみち
     * 絵が止まった直後なので余計には見えない。コマ落ちを合図にしない理由は
     * `DROP_BURST` を置いていたところ (上) に
     */
    /** 繋ぎ直しの目覚まし。**待っている間だけ入っている** */
    let retry: ReturnType<typeof setTimeout> | null = null;
    /**
     * 続けて何回繋ぎ直しに失敗したか。**待ち時間を伸ばすのと、諦め方の分かれ目。**
     *
     * 0 でなければ「繋ぎ直しの最中」。その間は繋げなくても失敗にしない —
     * サーバが帰ってくるのを待っているのだから、繋がらないのは当たり前
     */
    let attempts = $state(0);
    /** 画面を離れた。**もう繋ぎ直さない** */
    let left = false;
    /** 最後に詰まった時刻。無事が続いたかを見る */
    let lastStall = 0;
    /** 前回 `nextTarget` を回してから詰まったか */
    let stalled = false;
    /**
     * 選局してから何回詰まったか。**画面に出す** (`live/+page.svelte`)。
     *
     * 「LAN内なのに一瞬止まって遅延が増えていく」を追うために置いた。送り出す
     * 側は入口 (TLS) まで含めて測ってあり **0.5秒以上の間が1回も無い**ので、
     * 止まっているならこちら側だと分かる — その切り分けにこの数が要った
     * ([stream.md](../../docs/stream.md) §4 に実測)。
     *
     * **見つかった原因は貯め方だった** (`ts/pacing.ts` の `nextTarget`)。
     * 直ったあとも出しておく — 経路が荒れているかどうかは、遅延の値より
     * この数のほうが早く出る
     */
    let stalls = $state(0);
    /** 最後に `nextTarget` を回した時刻 */
    let lastSettled = 0;
    /** 下限を最後に動かした時刻。**下げ直すのはゆっくり** (`pacing` の `FORGET`) */
    let lastFloor = 0;
    /**
     * この時刻まで、詰まっても数えない。**自分で起こした詰まりを数えないため。**
     *
     * 選局した直後と、跳んだ直後は必ず `waiting` が上がる。数えていた頃は
     * それだけで貯める量が増え、遅延が伸びたまま戻らなかった — 詰まりは
     * **一度に 0.6 秒**伸ばし、しかも**伸ばした先が下限として残る**ので
     * (`pacing.ts` の `PROBE`)、自分で起こした1回がずっと効いてしまう。
     */
    let quiet = 0;
    /**
     * 追加待ちの列。**`appendBuffer` は1つずつしか受け付けない** —
     * 前のが終わる前に呼ぶと `InvalidStateError` で止まる
     */
    const pending: Uint8Array[] = [];
    /** 受け取った映像の量と、数えはじめた時刻。**戻れる幅を決めるのに使う** */
    let received = 0;
    let receivedFrom = 0;

    /**
     * 前の絵を写して、次が出るまで貼っておく。**切り替えの間の黒を埋める。**
     *
     * 切り替えにかかる時間は、ほとんどが**こちらの都合では動かないもの**
     * ([stream.md](../../docs/stream.md) §4 に実測の内訳)。復調器のロック 0.32秒、
     * スクランブル解除が ECM を待つ 0.24秒、ffmpeg の立ち上がり 0.53秒、
     * 放送の I フレーム待ち 0〜0.50秒。
     * **待ち時間そのものは変わらないが、黒い画面を見せずに済む。**
     *
     * 器を作り直すと `<video>` は何も映さなくなるので、その前に1枚だけ
     * canvas へ写し取って上に重ねる。動画ではなく静止画なので、止まって見える —
     * それは正しい。実際に止まっている
     */
    function freeze(): void {
        if (element === null || still === null) return;
        // まだ1枚も出ていない (初めて開いたとき)。写すものが無い
        if (element.readyState < 2 || element.videoWidth === 0) return;
        const ctx = still.getContext('2d');
        if (ctx === null) return;
        still.width = element.videoWidth;
        still.height = element.videoHeight;
        ctx.drawImage(element, 0, 0, still.width, still.height);
        holding = true;
        if (holdTimer !== null) clearTimeout(holdTimer);
        holdTimer = setTimeout(thaw, HOLD_MOST);
    }

    /** 剥がす。**次の絵が実際に出てから** (`onFrame`) */
    function thaw(): void {
        if (holdTimer !== null) {
            clearTimeout(holdTimer);
            holdTimer = null;
        }
        if (holding) holding = false;
    }

    /**
     * 次の絵が画面に出たら呼ぶ。
     *
     * `play()` が返っただけでは**まだ何も映っていない**ので、そこで剥がすと
     * 一瞬黒くなる。`requestVideoFrameCallback` は「1枚映した」ところで来る。
     * 持っていないブラウザでは `timeupdate` で代える (1枚ぶん遅いが実害は無い)
     */
    function onFrame(video: HTMLVideoElement, done: () => void): void {
        const request = (video as HTMLVideoElement & { requestVideoFrameCallback?(cb: () => void): number })
            .requestVideoFrameCallback;
        if (typeof request === 'function') request.call(video, done);
        else video.addEventListener('timeupdate', done, { once: true });
    }

    /** 字幕を貼り直し続けている映像。**1つにつき1本** */
    let following: HTMLVideoElement | null = null;

    /**
     * 字幕を、**映した1枚ごとに**貼り直す。
     *
     * 貼り直しを `pace` に相乗りさせていた頃は、**塊が届いたときにしか
     * 貼り直していなかった**。塊は 0.05秒ごとなので、ずれるのは**遅れる方向
     * だけ** — 実機で測ると、狙った 507ms に対して実際に出るのは平均 522ms・
     * 最大 560ms だった。字幕は 1〜2秒で入れ替わるので、これが「次の表示が
     * 気持ち遅い」として出る。
     *
     * 映した1枚ごとに追わせれば ([frames.ts](components/player/frames.ts))、
     * 貼り直す時刻が見えている絵と揃う。
     *
     * **止めて見ている間は来ない。** 片付け (`sweep`) は `pace` に置いたままに
     * してあるので、待たせているぶんが溜まりっぱなしにはならない。
     * `paint` は出すものが変わっていなければその場で戻るので、空回りは安い
     */
    function follow(video: HTMLVideoElement): void {
        if (following === video) return;
        following = video;
        eachFrame(video, (frame) => {
            // 別の映像に移ったら、こちらは畳む
            if (following !== video) return false;
            /*
             * **映した1枚の時刻と、再生位置の差。** ここが「絵だけ遅れる」の
             * 正体 (`slip` の項)。`requestVideoFrameCallback` を持っている
             * ブラウザでだけ測れる
             */
            if (frame !== undefined) {
                const late = video.currentTime - frame.mediaTime;
                slip = late > 0 ? late : 0;
                if (slip > slipMost) slipMost = slip;
                if (slip > SLIP_MOST) unslip(video);
            }
            paint(video.currentTime);
            return true;
        });
    }

    /**
     * 絵だけ遅れているのを直す。**その場へ跳び直すだけ。**
     *
     * 復号が間に合わないと、**音と字幕は合っているのに絵だけ遅れる** — 再生位置
     * (音の時計) は進み続け、映る絵だけが取り残される。しかも**戻らない**ので、
     * 実機では「開き直すと直る」という形で出ていた。
     *
     * 跳び直すと復号器は積み残しを捨てて、いまの位置から出し直す。開き直しと
     * 同じことを、繋ぎも溜まりもそのままでやる。
     *
     * **連発させない** (`UNSLIP_EVERY`)。復号が追いつかない状態そのものは
     * 直らないので、間を置かないと跳び続けることになる
     */
    function unslip(video: HTMLVideoElement): void {
        const now = Date.now();
        if (now < unslipAfter || video.paused || video.seeking) return;
        unslipAfter = now + UNSLIP_EVERY;
        slips++;
        slip = 0;
        /*
         * **これで起きる詰まりは数えない。** 跳べば復号器は読み込み直しになり、
         * 必ず `waiting` が上がる。数えると**自分で跳んだぶんだけ貯める量が
         * 増えて**、絵を直すたびに遅延が伸びていくことになる
         */
        quiet = now + GRACE;
        // **1コマぶんだけ前へ。** 同じ値を入れ直すのは跳んだことにならない
        video.currentTime += FRAME;
    }

    /**
     * 字幕を重ねる。**再生位置に合う1枚だけ描く。**
     *
     * 字幕は次が来るまで出しっぱなしなので、選ぶのは「時刻が再生位置を
     * 追い越していない中の、最後の1つ」([ts/captions.ts](./ts/captions.ts))。
     * 跳んだ直後もこれで追いつく。
     *
     * **絵は画面まるごとの大きさで来る** (1920x1080)。canvas を映像と同じ枠に
     * 敷いて、そこへ引き伸ばして描くので、位置合わせはブラウザ任せでよい
     */
    function paint(at: number): boolean {
        if (overlay === null) return false;
        // 消しているときは何も選ばない (下で clearRect に落ちる)
        const next = captions ? currentCue(cues, at) : null;
        if (next === shown) return false;
        shown = next;

        /*
         * 置き方は観る画面と同じ (`components/player/paint.ts`)。
         * **こちらの絵は画面まるごと**なので、置くのは左上 (0,0) になる
         */
        const bitmap = next?.bitmap ?? null;
        drawOverlay(
            overlay,
            bitmap === null
                ? null
                : {
                      x: 0,
                      y: 0,
                      videoWidth: bitmap.width,
                      videoHeight: bitmap.height,
                      source: bitmap,
                  },
        );
        return true;
    }

    /** 待たせているぶんを片付ける。**いま出している1枚は残す** (出しっぱなしのため) */
    function sweep(at: number): void {
        const kept = trimCues(cues, at);
        if (kept.length === cues.length) return;
        for (const cue of cues) {
            if (kept.includes(cue) || cue === shown) continue;
            cue.bitmap?.close();
        }
        cues = kept;
    }

    function drain(): void {
        if (buffer === null || buffer.updating || pending.length === 0) {
            // 追っかけを読み切っていて、流し残しも無ければ、ここで器を締める
            finishStream();
            return;
        }
        const next = pending.shift();
        if (next === undefined) return;
        try {
            buffer.appendBuffer(next as BufferSource);
        } catch {
            // 追いつけなくなった。次の init から入り直す
            pending.length = 0;
        }
    }

    /**
     * 追っかけを読み切ったら器を締める (`MediaSource.endOfStream`)。
     * 締めないと、バッファの端で「読み込み中」のまま止まって見える。
     * 流し残し (`pending`) があるうちは待つ — 締めると残りが入らなくなる
     */
    function finishStream(): void {
        if (!ending || source === null || source.readyState !== 'open') return;
        if (buffer === null || buffer.updating || pending.length > 0) return;
        try {
            source.endOfStream();
        } catch {
            // 追加中だった。次の updateend の drain で締め直す
        }
    }

    /**
     * 再生位置を面倒みる。**届いた端でそのまま出すと、絶えず止まる。**
     *
     * 少し貯めてから始め、離れたら速めて詰める ([pacing.ts](./ts/pacing.ts))。
     * 別のタブへ行って戻ってきたときだけ跳ぶ — 跳ぶと音が切れるので、
     * 常用するとそれ自体が「かくつき」になる。
     */
    function pace(video: HTMLVideoElement): void {
        if (buffer === null || buffer.updating || buffer.buffered.length === 0) return;
        const end = buffer.buffered.end(buffer.buffered.length - 1);
        const behind = end - video.currentTime;
        /*
         * **0.1秒刻みにする。** 塊は毎秒20個届くので、そのたびに書き換えると
         * 画面を無駄に描き直すことになる
         */
        const rounded = running ? Math.round(behind * 10) / 10 : null;
        if (rounded !== delay) delay = rounded;
        // 放送の今に張り付いているか。少しの揺れでは離れたことにしない
        const atLive = behind <= target + 1.5;
        if (atLive !== live) live = atLive;

        const tenth = (value: number) => Math.round(value * 10) / 10;
        if (tenth(buffer.buffered.start(0)) !== oldest) oldest = tenth(buffer.buffered.start(0));
        if (tenth(end) !== newest) newest = tenth(end);
        if (tenth(video.currentTime) !== position) position = tenth(video.currentTime);

        /*
         * **片付けは毎回する。** 待たせているぶんは先の時刻に積まれるので、
         * 止めて見ている間は出す番が来ない。変わったときだけ片付けていた頃は、
         * そのぶんが際限なく溜まった (1枚 1920x1080 なので、止めっぱなしだと効く)。
         *
         * 貼り直しもここでする。**普段効いているのは `follow` のほう**だが、
         * 止めて見ている間は映した1枚が来ないので、こちらが要る
         */
        paint(video.currentTime);
        sweep(video.currentTime);

        trim(end);
        settle();

        /*
         * **押して止めている間は動かさない。** 受け取りは続けているので溜まって
         * いくが、そこへ跳ばせると「止めた所から見る」ができなくなる。
         * 追いかけ直すのは「ライブへ」を押されたとき (`goLive`)
         */
        if (paused) return;

        /*
         * **追っかけは放送の今を追いかけない。** 右端は「録れているところ」で、
         * 貯まりは倍速の送り込み (`server/chase.ts`) でどんどん伸びる。跳びも
         * 詰めもせず、少し貯まったら選んだ速さで進むだけ。読み切った後は
         * 貯まりを待たない (もう来ない)
         */
        if (chase !== null) {
            if (!running && (end - video.currentTime >= 0.8 || chaseEnded)) {
                running = true;
                state = 'playing';
                void play(video);
                onFrame(video, thaw);
            }
            if (running && video.playbackRate !== speed) video.playbackRate = speed;
            return;
        }

        const next = pacing({
            start: buffer.buffered.start(0),
            end,
            at: video.currentTime,
            playing: running,
            target,
            chasing,
            speed,
        });

        /*
         * **追いついたらライブに戻す。** 押してもらう必要は無い — 追いついた
         * ところで選んだ速さのまま進むと放送を追い越し、溜まりを使い切って止まる
         */
        if (next.caught) {
            chasing = false;
            speed = 1;
        }
        if (next.seek !== null) {
            video.currentTime = next.seek;
            quiet = Date.now() + GRACE;
        }
        if (next.rate !== null) video.playbackRate = next.rate;
        if (next.play && !running) {
            running = true;
            state = 'playing';
            void play(video);
            // 1枚映ってから前の絵を剥がす。ここで剥がすと一瞬黒くなる
            onFrame(video, thaw);
        }
    }

    /**
     * どれだけ戻れるか (秒)。**太い絵ほど短くなる。**
     *
     * 受け取っている速さから、`BUDGET` に収まる長さを出す。まだ測れていない
     * 間は今までどおり 5 分。
     */
    function keepFor(): number {
        const seconds = (Date.now() - receivedFrom) / 1000;
        if (receivedFrom === 0 || seconds < 2 || received === 0) return KEEP;
        const perSecond = received / seconds;
        return Math.max(KEEP_LEAST, Math.min(KEEP, BUDGET / perSecond));
    }

    /**
     * 溜まりすぎを刈る。**止めている間も受け取り続けるので、放っておくと際限なく太る。**
     *
     * ブラウザが抱えられる量には上限があり、超えると `appendBuffer` が
     * `QuotaExceededError` で落ちる。落ちるとそこから絵が出なくなるので、
     * 遅れて見られる長さに上限を設けて、古いほうから捨てる。
     */
    function trim(end: number): void {
        if (buffer === null || buffer.updating || buffer.buffered.length === 0) return;
        const cut = end - keepFor();
        if (buffer.buffered.start(0) >= cut) return;
        try {
            buffer.remove(0, cut);
        } catch {
            // 追加中だった。次の機会に
        }
    }

    /** 貯める量を決め直す。**止まったら伸ばし、無事が続いたら縮める** */
    function settle(): void {
        const now = Date.now();
        if (!stalled && now - lastSettled < SETTLE_EVERY) return;
        // 捨てられたコマも同じ間隔で読む。**選局からの通し** (器を作り直すと 0 に戻る)
        dropped = element?.getVideoPlaybackQuality?.().droppedVideoFrames ?? dropped;
        /*
         * **途切れたら跳び直す** (`seenDropped` の説明)。測れた遅れ (`slip`) を
         * 待たない — あれは見えないことがある
         */
        if (stalled && element !== null) unslip(element);
        const next = nextTarget(
            { target, floor },
            stalled,
            (now - lastStall) / 1000,
            (now - lastFloor) / 1000,
        );
        stalled = false;
        lastSettled = now;
        if (next.floor !== floor) {
            floor = next.floor;
            lastFloor = now;
            // 次に開いたときはここから始める。探し直しは経路が変わったときだけ
            rememberFloor(floor);
        }
        if (next.target !== target) target = next.target;
    }

    /**
     * 鳴らす。**断られたら、音を諦めて絵だけ出す。**
     *
     * 前回のチャンネルで勝手に始める作りなので、開いた直後は「押した」ことに
     * なっていない。その状態で音ありの再生を求めると、ブラウザは丸ごと断る —
     * 黙って諦めると、絵も出ないまま黒い画面が残る。
     */
    async function play(video: HTMLVideoElement): Promise<void> {
        video.muted = silenced;
        try {
            await video.play();
        } catch {
            video.muted = true;
            silenced = true;
            try {
                await video.play();
            } catch {
                // それでも駄目。備え付けの再生ボタンを押してもらう
            }
        }
    }

    /** 音を出す。**押されて呼ばれる** — ここまで来ればブラウザは断らない */
    function unmute(): void {
        silenced = false;
        if (element === null) return;
        element.muted = false;
        void element.play().catch(() => {
            /* 押したのに断られることはない */
        });
    }

    /** 音を止める。備え付けの操作を出さないので、こちらで用意する */
    function mute(): void {
        silenced = true;
        if (element !== null) element.muted = true;
    }

    /**
     * 止める・再開する。**止めても受け取りは続く。**
     *
     * 止めた時点で追っかけに入る。再開しても放送の今へは跳ばない
     * (`pacing` が `chasing` の間は跳ばない)。放送に戻りたいときは `goLive`。
     *
     * **印を立てるのは止めるときだけで足りる。** 立てていなかった頃は、
     * 8秒より長く止めて再開すると `pacing` が勝手に放送の今へ跳んでいた —
     * 「止めた所から見られる」と謳っておきながら、実際には戻れなかった
     */
    function toggle(): void {
        if (element === null) return;
        if (paused) {
            paused = false;
            void element.play().catch(() => {
                /* 押されて呼ばれるので断られない */
            });
        } else {
            paused = true;
            chasing = true;
            element.pause();
        }
    }

    /**
     * 覚えた下限を捨てて、測り直す。**経路が変わったときのための出口。**
     *
     * 覚えているのは**その経路の性質**なので (`FLOOR_KEY`)、宅内から出先へ
     * 持ち出したり、線を繋ぎ替えたりすると**前の経路の値のまま**になる。
     * 高すぎる側に外れたときが厄介で、放っておいても下がるが
     * **10分ごとに 0.3秒 ずつ**しか下がらない (`nextTarget` の `FORGET`) —
     * 良い経路に戻ってきたのに、しばらく余計に遅れて見ることになる。
     *
     * 低すぎる側に外れたぶんは放っておいてよい。止まればその場で上がる。
     *
     * **貯めているぶんもその場で下げる。** 下限だけ下げても、縮むのは
     * 15秒ごとに2割なので、1.5秒から下りきるのに2分半かかる。押した人が
     * 見たいのは「いま詰まるかどうか」なので、下限まで詰めて放送の今へ戻す
     */
    function relearn(): void {
        clearFloor();
        floor = FLOOR;
        lastFloor = Date.now();
        target = FLOOR;
        goLive();
    }

    /** 放送の今へ追いつく。**追っかけをやめて、見ていたぶんを飛ばす** */
    function goLive(): void {
        if (element === null || buffer === null || buffer.buffered.length === 0) return;
        const end = buffer.buffered.end(buffer.buffered.length - 1);
        element.currentTime = Math.max(buffer.buffered.start(0), end - target);
        chasing = false;
        speed = 1;
        element.playbackRate = 1;
        quiet = Date.now() + GRACE;
        if (paused) toggle();
    }

    /**
     * 字幕を選び直す。**言語が複数ある放送はたまにある。**
     *
     * **音声と同じで焼き直しになる** — 字幕は映像と同じ ffmpeg で焼いている
     * (そうしないと時刻が揃わない。`server/captions.ts`)。器から作り直すので、
     * 待たせているぶんも映像も捨てる
     */
    function setCaptionTrack(index: number): void {
        if (index === captionTrack) return;
        // 追っかけも同じ理屈で焼き直し。**居た場所から**開き直す
        if (chase !== null && element !== null) {
            captionTrack = index;
            void openChase(element, chase.recordingId, chase.base + position, true);
            return;
        }
        if (tuned === null) return;
        // 一覧は同じ局のものなので残す (`forget`)
        forget(true);
        captionTrack = index;
        const command: Command = { type: 'tune', ...tuned, caption: index };
        if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(command));
    }

    /**
     * 追っかけの速さを選ぶ。**追っかけている間だけ効く。**
     *
     * ライブに張り付いているときに速められては困る (放送より先は無い) ので、
     * ここで選べるのは遅れて見ているときだけ。追いついたら 1 に戻す (`pace`)
     */
    function setSpeed(next: number): void {
        // 追っかけ再生 (`chase`) では常に選べる — 放送の今より先が無いのはライブだけ
        if (!chasing && chase === null) return;
        speed = next;
        if (element !== null) element.playbackRate = next;
    }

    /**
     * 持っている範囲の中で移る。帯を押されたとき。
     *
     * **後ろへ戻したら追っかけに入る。** 入れないと `pacing` が「大きく離れた」と
     * 見て放送の今へ跳ね返すので、戻した先が1秒も映らない
     */
    function seek(to: number): void {
        if (element === null || buffer === null || buffer.buffered.length === 0) return;
        const start = buffer.buffered.start(0);
        const end = buffer.buffered.end(buffer.buffered.length - 1);
        const at = Math.min(end, Math.max(start, to));
        element.currentTime = at;
        // 端の近くへ戻しただけならライブのまま。少しの操作で追っかけにしない
        if (end - at > target + 1.5) chasing = true;
        quiet = Date.now() + GRACE;
    }

    /**
     * 追っかけのシーク。**二段構え。**
     *
     * 手元に残っている範囲なら `video.currentTime` を動かすだけ (一瞬)。
     * 外なら `chase` を送り直してサーバに ffmpeg ごと立て直させる — 生TSに
     * 時間の索引は無いので、跳び先はバイト比例で当たりを付ける (`server/chase.ts`)
     */
    function chaseSeek(to: number): void {
        if (chase === null || element === null) return;
        const local = to - chase.base;
        if (buffer !== null && buffer.buffered.length > 0) {
            const start = buffer.buffered.start(0);
            const end = buffer.buffered.end(buffer.buffered.length - 1);
            if (local >= start && local <= end) {
                element.currentTime = Math.min(end, Math.max(start, local));
                quiet = Date.now() + GRACE;
                return;
            }
        }
        void openChase(element, chase.recordingId, to, true);
    }

    /**
     * 再生の状態だけ初期に戻す。**繋ぎ直さない。**
     *
     * 音声を選び直したときはサーバが焼き直すので、器は作り直すが繋ぎ直す
     * 必要は無い (`setAudio`)。器を作り直す `start` からも通る
     */
    function clear(): void {
        buffer = null;
        source = null;
        running = false;
        delay = null;
        paused = false;
        live = true;
        // 局や音声を選び直したら、追っかけていた場所はもう無い
        chasing = false;
        speed = 1;
        oldest = 0;
        newest = 0;
        position = 0;
        slip = 0;
        slipMost = 0;
        pending.length = 0;
        // 作り直した器は開いている。読み切りの印は次の `ended` が立て直す
        ending = false;
    }

    /** 繋ぎも含めて畳む。**画面を離れるときと、繋ぎ直すとき** */
    function reset(): void {
        socket?.close();
        socket = null;
        forget(false);
    }

    /**
     * 受け取ったものを忘れる。**繋ぎはそのまま。**
     *
     * **待たせている字幕は必ず捨てる。** 焼き直しになれば mp4 の時刻は 0 から
     * 数え直しになるので、前の時刻で待たせているものは**どれも合わなくなる**
     * (音声や焼き方を選び直しただけでも焼き直しになる。`server/live.ts`)。
     *
     * @param keepList 選べる字幕の一覧は残すか。**同じ局の中での選び直しだけ
     *   true** — 局が変われば持っている字幕も変わる (字幕そのものが無い局もある)
     */
    function forget(keepList: boolean): void {
        clearCaptions();
        if (!keepList) {
            captionTracks = [];
            captionTrack = 0;
            // **局ごとのもの。** 局を変えたら、前の局のアプリを出したままにしない
            hybridcast = [];
        }
        clear();
    }

    /** 待たせている字幕を捨てる。**焼き直しのたび** (`forget` の説明) */
    function clearCaptions(): void {
        generation++;
        for (const cue of cues) cue.bitmap?.close();
        cues = [];
        shown = null;
        clearOverlay(overlay);
    }

    /** 画面を離れる。**貼った絵も剥がす** — 戻ってきたときに残っていては困る */
    function stop(): void {
        left = true;
        if (retry !== null) clearTimeout(retry);
        retry = null;
        reset();
        thaw();
    }

    /** 出せなかったことにする。**貼った絵は剥がす** — 動いて見えるほうが悪い */
    function fail(text: string): void {
        state = 'error';
        message = text;
        attempts = 0;
        thaw();
    }

    /**
     * 繋ぎ直す。**待ってから、また繋ぎに行く。**
     *
     * 切れる理由でいちばん多いのはサーバの入れ替え (デプロイ)。数十秒帰って
     * こないが、帰ってくることは分かっているので、こちらから諦める理由が無い。
     * 待ち時間は倍々に伸ばして `RETRY_MOST` で頭打ち。
     *
     * **上限は置かない。** 置くと「席を外している間に切れて、戻ったら止まって
     * いる」が残る — テレビとして使う道具では、点けっぱなしで戻ってきたときに
     * 映っていてほしい
     */
    function reconnect(): void {
        if (retry !== null || left || (tuned === null && chase === null) || element === null) return;
        state = 'connecting';
        message = '';
        const wait = Math.min(RETRY_MOST, RETRY_FIRST * 2 ** attempts);
        attempts++;
        retry = setTimeout(() => {
            retry = null;
            if (left || element === null) return;
            // 追っかけは**居た場所から**繋ぎ直す (焼き直しても通しの位置は分かる)
            if (chase !== null) {
                void openChase(element, chase.recordingId, chase.base + position, true);
                return;
            }
            if (tuned === null) return;
            // 局は変わらないので、選べる字幕の一覧は残す
            void tune(element, tuned, true);
        }, wait);
    }

    /**
     * 音声を選び直す。**繋ぎ直さずに頼み直す。**
     *
     * サーバは音声ごとに別の ffmpeg を回す (`live.ts` の目印) ので、選び直すと
     * 器から作り直しになる。チャンネルは変わらないのでチューナーは掴んだままで、
     * かかるのは焼き始めのぶんだけ。**前の絵は貼っておく**ので、絵は止まるが
     * 黒くはならない
     */
    function setAudio(id: string): void {
        if (element === null || id === audio) return;
        // 追っかけも同じ理屈で焼き直し。**居た場所から**開き直す
        if (chase !== null) {
            audio = id;
            void openChase(element, chase.recordingId, chase.base + position, true);
            return;
        }
        if (tuned === null) return;
        // 局は変わらないので、選べる字幕の一覧はそのまま使える (`forget`)
        void tune(element, { ...tuned, audio: id }, true);
    }

    /**
     * 焼き方を選び直す。**音声とまったく同じ扱い。**
     *
     * サーバは焼き方ごとに別の ffmpeg を回す (`server/live.ts` の目印) ので、
     * 器から作り直しになる。チャンネルは変わらないのでチューナーは掴んだままで、
     * かかるのは焼き始めのぶんだけ。**前の絵は貼っておく**ので、絵は止まるが
     * 黒くはならない。
     *
     * **出るかどうかは端末次第。** AV1 を受け取れないブラウザもあるので、
     * 器を作るところで断られたら、そう言って H.264 に戻せるようにする (`start`)
     */
    function setCodec(next: LiveCodec): void {
        // 選び直したなら、前の断り書きは用済み
        warning = '';
        swapCodec(next);
    }

    /**
     * データ放送を出す・やめる (テレビの d ボタン)。
     *
     * **サーバは頼まれてから解く。** 押すまでは1バイトも届かないかわりに、
     * 押してから出るまでカルーセルが一周するのを待つことになる
     * (`server/databroadcast.ts`)。
     */
    function setData(on: boolean): void {
        if (showData === on) return;
        showData = on;
        // 畳んだら、待たせてあるぶんも捨てる
        if (!on) heldData = [];
        socket?.send(JSON.stringify({ type: 'data', on } satisfies Command));
    }

    /**
     * データ放送の知らせを受け取る先を預かる。**描く側が居るときだけ渡す。**
     *
     * 渡す形は借りものの取り決めそのまま (`ResponseMessage`) なので、
     * ここは素通しでいい ([vendor/web-bml](./vendor/web-bml/README.md))。
     *
     * **預かった時点で、待たせてあるぶんを先に流す** (`heldData`)
     */
    function listenData(handler: ((message: ResponseMessage) => void) | null): void {
        onData = handler;
        const held = heldData;
        heldData = [];
        if (handler === null) return;
        for (const message of held) handler(message);
    }

    /** 中身。**断り書きを消さない**ので、戻すときにも使える */
    function swapCodec(next: LiveCodec): void {
        if (element === null || next === codec) return;
        // 追っかけも同じ理屈で焼き直し。**居た場所から**開き直す
        if (chase !== null) {
            codec = next;
            void openChase(element, chase.recordingId, chase.base + position, true);
            return;
        }
        if (tuned === null) return;
        // 局は変わらないので、選べる字幕の一覧はそのまま使える (`forget`)
        void tune(element, { ...tuned, codec: next }, true);
    }

    /**
     * 重ねるものの置き場を預かる。**画面が組み上がってから1回だけ。**
     *
     * @param frozen 切り替えの間、前の絵を貼っておく先 (`freeze`)
     * @param subtitles 字幕を重ねる先 (`paint`)
     */
    function attach(frozen: HTMLCanvasElement, subtitles: HTMLCanvasElement): void {
        still = frozen;
        overlay = subtitles;
    }

    /**
     * 選局する。**繋がっていれば繋ぎ直さない。**
     *
     * @param keepList 選べる字幕の一覧を残すか。**同じ局の中での選び直しだけ
     *   true** (`forget` の説明)。待たせている字幕はどの道いつも捨てる
     */
    async function tune(video: HTMLVideoElement, target: Tuned, keepList = false): Promise<void> {
        chase = null;
        chaseTimeline = null;
        tuned = target;
        audio = target.audio ?? '';
        codec = target.codec ?? 'h264';
        remember(target);
        await begin(video, keepList);
    }

    /**
     * 追っかけ再生を開く ([issue #16](https://github.com/danything/denpa/issues/16))。
     * **録画中の録画を、いま録れているところまで観る。** 器も繋ぎもライブと
     * 同じで、送る指示だけ違う (`chase`)。範囲の外へのシークもこれ —
     * サーバが ffmpeg ごと立て直す (選局し直しと同じ流儀)
     */
    async function openChase(
        video: HTMLVideoElement,
        recordingId: number,
        at = 0,
        keepList = false,
    ): Promise<void> {
        tuned = null;
        chase = { recordingId, base: Math.max(0, at) };
        chaseEnded = false;
        await begin(video, keepList);
    }

    /**
     * いま頼みたいこと。**繋いだ直後と繋ぎ直しで同じものを送る** —
     * 中身を書き写していた頃は、足したものをどちらかへ足し忘れると
     * 「繋ぎ直したときだけ抜ける」という出方をした
     */
    function wantedCommand(): Command | null {
        if (chase !== null) {
            return {
                type: 'chase',
                recordingId: chase.recordingId,
                at: chase.base,
                audio: audio === '' ? undefined : audio,
                codec,
                caption: captionTrack,
            };
        }
        if (tuned !== null) return { type: 'tune', ...tuned };
        return null;
    }

    /** 繋いで頼む。選局 (`tune`) と追っかけ (`openChase`) の共通の後半 */
    async function begin(video: HTMLVideoElement, keepList: boolean): Promise<void> {
        element = video;
        left = false;
        // 数え直す。焼き直しでも器から作り直しになるので、前の数は続きではない
        stalls = 0;
        // 字幕は映した1枚ごとに貼り直す (`follow`)。2度目からは何もしない
        follow(video);
        // 次の絵が出るまで前の絵を貼る。**閉じる前に写す** (閉じると何も映らなくなる)
        freeze();
        /*
         * **繋がっていれば繋ぎ直さない。**
         *
         * 取り決めは1本の WebSocket に何度でも指示を送れる形になっていて
         * (`server/live.ts` の `attend`)、音声の選び直しは前からそうしていた。
         * 局を変えるときだけ張り直していたのは**ただの取りこぼし**で、実測で
         * 札を取り直すのに 50ms、握手に 50ms 掛かっていた
         */
        const open = socket !== null && socket.readyState === WebSocket.OPEN;
        if (open) forget(keepList);
        else reset();

        state = 'connecting';
        message = '';
        quiet = Date.now() + GRACE;

        if (open) {
            const command = wantedCommand();
            if (command !== null) socket?.send(JSON.stringify(command));
            return;
        }

        /*
         * **札を先に取る。** ブラウザは WebSocket の握手に `Authorization` を
         * 付けてくれないので、認証を通れることをここで示す (`tickets.ts`)
         */
        let ticket: string;
        try {
            const res = await fetch('/api/live/ticket', { method: 'POST' });
            if (!res.ok) throw new Error(String(res.status));
            ticket = ((await res.json()) as { ticket: string }).ticket;
        } catch {
            // 繋ぎ直しの最中なら、サーバがまだ帰っていないだけ。待ち直す
            if (attempts > 0) reconnect();
            else fail('繋がりませんでした');
            return;
        }

        const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${scheme}://${location.host}${SOCKET_PATH}?ticket=${ticket}`);
        ws.binaryType = 'arraybuffer';
        socket = ws;

        ws.onopen = () => {
            // 繋がった。次に切れたときはまた1秒から待ち直す
            attempts = 0;
            // 頼みごとは1箇所で組む (`wantedCommand`)。書き写しは繋ぎ直しで抜ける
            const command = wantedCommand();
            if (command !== null) ws.send(JSON.stringify(command));
            /*
             * **繋ぎ直したら頼み直す。** データ放送を出すかどうかはサーバ側では
             * 繋ぎ (Viewer) に紐づいているので、切れると忘れられる。局を変える
             * だけなら覚えている (`Session.add`)
             */
            if (showData) ws.send(JSON.stringify({ type: 'data', on: true } satisfies Command));
        };

        ws.onerror = () => {
            // 繋ぎ直しの最中。すぐ後ろに `onclose` が来るので、そちらで待ち直す
            if (attempts > 0) return;
            if (state !== 'playing') fail('繋がりませんでした');
        };

        /**
         * **切れたら繋ぎ直す。** いちばん多いのはサーバの入れ替え (デプロイ)。
         *
         * `idle` に戻すだけだった頃は、観ている最中に画面が「選んでください」に
         * なり、**自分で選び直す**ことになっていた
         */
        ws.onclose = () => {
            if (socket !== ws || state === 'error') return;
            socket = null;
            if (left || (tuned === null && chase === null) || element === null) {
                state = 'idle';
                return;
            }
            reconnect();
        };

        ws.onmessage = (event) => {
            const data = event.data as ArrayBuffer;
            const kind = new DataView(data).getUint8(0);
            const body = new Uint8Array(data, 9);

            if (kind === CHANNEL.control) {
                const notice = JSON.parse(new TextDecoder().decode(body)) as Notice;
                if (notice.type === 'error') {
                    fail(notice.message);
                } else if (notice.type === 'captions') {
                    /*
                     * **1枚も届いていなくても、あることは分かる。** 届いてから
                     * 切り替えを出していた頃は、間隔の空く番組でボタンが出なかった
                     */
                    captionTracks = notice.tracks;
                    captionTrack = notice.track;
                } else if (notice.type === 'hybridcast') {
                    hybridcast = notice.apps;
                } else if (notice.type === 'timeline') {
                    /*
                     * 追っかけの物差し。**base はサーバが決めた実際の開始位置に
                     * 合わせ直す** — 頼んだ位置は録れている範囲に収められることがある
                     */
                    if (chase !== null) chase = { ...chase, base: notice.at };
                    chaseTimeline = {
                        recordedSec: notice.recordedSec,
                        totalSec: notice.totalSec,
                        finished: notice.finished,
                        since: Date.now(),
                    };
                } else if (notice.type === 'ended') {
                    // 録れているところまで読み切った。流し残しが尽きたら器を締める
                    chaseEnded = true;
                    ending = true;
                    finishStream();
                } else if (notice.type === 'tuned') {
                    /*
                     * **選べる音声はここで初めて分かる。** どれが選べるかは
                     * いま流れている番組次第なので、局の一覧からは決められない
                     */
                    audios = notice.audios;
                    audio = notice.audio;
                    codec = notice.codec;
                    start(video, notice.codecs, notice.codec);
                }
                return;
            }

            if (kind === CHANNEL.videoInit) {
                /*
                 * **init が来たら作り直す。** チャンネルを変えると器も変わるので、
                 * 前の SourceBuffer に足すと中身が混ざって再生が止まる
                 */
                pending.length = 0;
                if (buffer !== null && source?.readyState === 'open') {
                    try {
                        buffer.abort();
                    } catch {
                        // 追加中でなければ投げる。気にしない
                    }
                }
            }
            /*
             * **データ放送。** 中身は `ResponseMessage` の JSON
             * ([ts/bml.ts](./ts/bml.ts) が組み立てたもの)。
             *
             * **器がまだ無いときは取っておく** (`heldData`)。押した直後に
             * まとめて届くぶんは、器を作るより先に来る
             */
            if (kind === CHANNEL.data) {
                const message = JSON.parse(new TextDecoder().decode(body)) as ResponseMessage;
                if (onData !== null) onData(message);
                // 出すつもりが無いなら取っておく意味も無い
                else if (showData && heldData.length < HOLD_DATA) heldData.push(message);
                return;
            }

            if (kind === CHANNEL.videoInit || kind === CHANNEL.videoMedia) {
                // 戻れる幅を決めるのに、どれだけ来ているかを数える (`keepFor`)
                if (receivedFrom === 0) receivedFrom = Date.now();
                received += body.byteLength;
                pending.push(body);
                drain();
                return;
            }

            /*
             * **字幕。** 中身の頭は `[2:x][2:y][2:w][2:h][PNG...]`
             * ([stream.md](../../docs/stream.md) §5.3)。
             *
             * 置き場所 (x,y,w,h) はいま使わない — 画面まるごとが来るため。
             * **あとで切り抜くようにしてもここを変えずに済む**ように読んでおく
             */
            if (kind === CHANNEL.subtitle || kind === CHANNEL.subtitleClear) {
                if (element === null) return;
                /*
                 * **添えられた時刻に置く** ([ts/captions.ts](./ts/captions.ts))。
                 *
                 * 映像と同じ ffmpeg が付けた mp4 の物差しなので、再生位置と
                 * 直に比べられる ([stream.md](../../docs/stream.md) §5.4)。
                 *
                 * 前は「届いた時点の再生位置」に置いていた。**焼く手間のぶん
                 * 字幕のほうが先に届く**ので、そのぶんだけ早く出ていた —
                 * 時刻で置けば、その量を測ったり当てたりしなくてよくなる
                 */
                const at = Number(new DataView(data).getBigUint64(1)) / CLOCK;

                if (kind === CHANNEL.subtitleClear) {
                    cues = insertCue(cues, { at, bitmap: null });
                    return;
                }
                /*
                 * **絵にするのは非同期。** 待っている間に選局が変わることが
                 * あるので、そのときは捨てる (`generation`)
                 */
                const mine = generation;
                const png = new Uint8Array(data, 9 + 8);
                void createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }))
                    .then((bitmap) => {
                        if (mine !== generation) {
                            bitmap.close();
                            return;
                        }
                        cues = insertCue(cues, { at, bitmap });
                    })
                    .catch(() => {
                        /* 壊れた1枚。次が来る */
                    });
            }
        };
    }

    /**
     * 器を用意する。`codecs` はサーバが焼き方から決めて送ってくる。
     *
     * **受け取れない形なら、H.264 へ戻す。** AV1 を選べるようにしてある以上、
     * 出ない端末で選ばれることは普通に起きる。そこで諦めると**黒いまま**に
     * なるので、確実に出るほうへ落として、そう言う
     */
    function start(video: HTMLVideoElement, codecs: string, baked: LiveCodec): void {
        if (!('MediaSource' in globalThis) || !MediaSource.isTypeSupported(codecs)) {
            if (baked !== 'h264') {
                warning = 'この端末では AV1 を再生できないので、H.264 に戻しました';
                swapCodec('h264');
                return;
            }
            fail('この端末では再生できない形式です');
            return;
        }
        /*
         * **前の器の名残を落とす。** 音声を選び直したときは繋ぎ直さないので
         * (`setAudio`)、ここを通っても `reset` は挟まらない。古い SourceBuffer に
         * 足しに行くと中身が混ざって止まる
         */
        clear();
        // 焼き方が変われば太さも変わる。数え直す
        received = 0;
        receivedFrom = 0;
        const media = new MediaSource();
        source = media;
        video.src = URL.createObjectURL(media);
        media.addEventListener(
            'sourceopen',
            () => {
                URL.revokeObjectURL(video.src);
                /*
                 * **終わりが無いと言っておく。**
                 *
                 * 何も言わないと、MediaSource の尺は「いま持っている中でいちばん
                 * 後ろ」になる。0.05秒ごとに中身が届くたびに尺が伸びるので、
                 * 備え付けの再生位置は右端まで行っては少し左へ戻る、を繰り返す。
                 * 放送に終わりは無いので、そう言うほうが正しい
                 */
                media.duration = Number.POSITIVE_INFINITY;
                buffer = media.addSourceBuffer(codecs);
                /*
                 * **並べ直させない** (`sequence` にしない)。焼いたものの時刻を
                 * そのまま使う。並べ直しは「届いた順に詰める」動きなので、
                 * 1つでも取りこぼすと以降ずっと映像と音声がずれる
                 */
                buffer.mode = 'segments';
                buffer.addEventListener('updateend', () => {
                    drain();
                    pace(video);
                });
                /*
                 * **詰まったことを覚えておく。** 宅内と宅外で必要な貯めの量は
                 * 桁違いに違うのに、どちらから見ているかは分からない。
                 * 実際に止まったかどうかで決める (`nextTarget`)
                 */
                video.addEventListener('waiting', () => {
                    if (paused || Date.now() < quiet) return;
                    stalled = true;
                    stalls += 1;
                    lastStall = Date.now();
                });
                drain();
            },
            { once: true },
        );
    }

    return {
        get state() {
            return state;
        },
        get message() {
            return message;
        },
        get tuned() {
            return tuned;
        },
        /** 音を止められているか。押して出してもらう */
        get silenced() {
            return silenced;
        },
        /** 放送からどれだけ遅れているか (秒)。再生していないときは null */
        get delay() {
            return delay;
        },
        /** 選局してから詰まった回数。0 のときは画面に出さない */
        get stalls() {
            return stalls;
        },
        /** 繋ぎ直しを待っている最中か。**待っていることを画面に出すため** */
        get resuming() {
            return attempts > 0;
        },
        /** 描かれずに捨てられたコマ。**絵だけ遅れるときの切り分けに** */
        get dropped() {
            return dropped;
        },
        /**
         * 覚えている下限 (秒)。**測り直す口を出すかどうかの判断に使う** —
         * 下限のままなら忘れるものが無い (`relearn`)
         */
        get remembered() {
            return floor;
        },
        /** 絵だけの遅れ (秒)。音と字幕は再生位置に乗っているので、ここが開くと口が合わない */
        get slip() {
            return slip;
        },
        /** 絵の遅れを直すために跳び直した回数 */
        get slipMost() {
            return slipMost;
        },
        get slips() {
            return slips;
        },
        /** 押して止めているか */
        get paused() {
            return paused;
        },
        /** 放送の今に張り付いているか */
        get live() {
            return live;
        },
        /** いまどれだけ貯めているか (秒)。詰まると伸びる */
        get buffering() {
            return target;
        },
        /** どこまで戻れるか (いちばん古い時刻) */
        get oldest() {
            return oldest;
        },
        /** 放送の今 (いちばん新しい時刻) */
        get newest() {
            return newest;
        },
        /** いま映している時刻 */
        get position() {
            return position;
        },
        /** 選べる音声。1つしか無ければ切り替えを出さない */
        get audios() {
            return audios;
        },
        /** いま鳴らしている音声 (`AudioTrack.id`) */
        get audio() {
            return audio;
        },
        /** いま焼いてもらっている形 */
        get codec() {
            return codec;
        },
        /** 頼まれたとおりにできなかったときの断り書き。無ければ空 */
        get warning() {
            return warning;
        },
        setCodec,
        /** 前の絵を貼っているか。**切り替えの間の黒を埋めている** */
        get holding() {
            return holding;
        },
        /** 追っかけ再生か。**わざと遅れて見ている** */
        get chasing() {
            return chasing;
        },
        /** 追っかけの速さ。ライブでは常に 1 */
        get speed() {
            return speed;
        },
        setSpeed,
        /** データ放送を出しているか */
        get showData() {
            return showData;
        },
        setData,
        listenData,
        /** 字幕を出しているか */
        get captions() {
            return captions;
        },
        /** 放送が字幕を持っているか。**1枚も届いていなくても分かる** */
        get hasCaptions() {
            return captionTracks.length > 0;
        },
        /** この番組に載っている Hybridcast。**動かさない。行き先を出すだけ** */
        get hybridcast() {
            return hybridcast;
        },
        /** 選べる字幕。2本以上あれば画面は選び直しを出す */
        get captionTracks() {
            return captionTracks;
        },
        /** いま出している字幕 (`CaptionTrack.index`) */
        get captionTrack() {
            return captionTrack;
        },
        setCaptionTrack,
        /** 字幕の出し入れ。テレビの字幕ボタンと同じ */
        toggleCaptions() {
            captions = !captions;
            if (element !== null) paint(element.currentTime);
        },
        attach,
        seek,
        toggle,
        goLive,
        relearn,
        mute,
        tune,
        unmute,
        setAudio,
        stop,
        /* ---- 追っかけ再生 ([issue #16](https://github.com/danything/denpa/issues/16)) ---- */
        openChase,
        chaseSeek,
        /** 追っかけ再生か。録画中の録画を観ている */
        get chaseMode() {
            return chase !== null;
        },
        /** 追っかけの再生位置 (秒)。焼き直しをまたいで通しで数える */
        get chasePosition() {
            return chase === null ? 0 : chase.base + position;
        },
        /** 追っかけの物差し。右端は送られた時点の値 — 録画中は画面が壁時計で伸ばす */
        get chaseTimeline() {
            return chaseTimeline;
        },
        /** 追っかけが録れているところまで読み切ったか */
        get chaseEnded() {
            return chaseEnded;
        },
    };
}
