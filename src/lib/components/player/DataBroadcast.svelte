<script module lang="ts">
    import { denpaFontUrl } from '#lib/font.js';
    import { resolve } from '$app/paths';
    /**
     * **画面の d ボタン。テレビと同じ振る舞い。** 出ている文書が d を聞いていれば
     * (`pressD` が true) 渡して終わり — 局の待機ページはこれでメニューを開く。
     * 聞いていなければ入れ物を出し入れする。ライブと録画の両方がここを通る
     */
    export function pressD(on: boolean, press: (() => boolean) | null, set: (on: boolean) => void): void {
        if (on && press?.() === true) return;
        set(!on);
    }
</script>

<script lang="ts">
    /**
     * データ放送を映像の上に重ねる。**描くのはエンジン** (`src/lib/bml/`)。
     *
     * denpa が作った `ResponseMessage` をそのまま食べさせるだけで、**映像は denpa のまま**。
     * エンジンは映像の object の場所を教えるだけで、映像の入れ物をそこへ寄せるのはこちら
     * (`placeVideo`。[docs/stream.md](../../../../docs/stream.md#56-データ放送の統合))。
     *
     * ## 押されるまで何も読み込まない
     *
     * エンジンは `import()` で押されてから取りに行く。データ放送を見ない人のぶんまで
     * 毎回落とさない。どのみち押してからカルーセルが一周するのを待つので、そこに紛れる。
     *
     * ## エンジンの外でやること
     *
     * 1. **d を BML に渡す** (`knock`)。出す操作は文書にとっての d の1押しで、
     *    `DataButtonPressed` を受けてアプリがメニューを出す。**入れ物を作っただけでは
     *    何も出ない** (NHK は `invisible` のまま d を待ち、日テレ・テレ朝・フジは
     *    待機ページを自分で出してから d を待つ)。しかも文書ができた瞬間に押しても
     *    届かない — `beitem` を `subscribe` にするのはアプリの `onload` なので、
     *    それより前に投げたぶんは誰にも拾われずに消える。**聞いている文書が出て
     *    くるまで見に行き、最初の1つに1回だけ届ける** (2回届けると、開いたメニューを
     *    閉じたり頭に戻したりする局がある)
     * 2. **映像の入れ物を小窓へ寄せ、隠れたら戻す** (`placeVideo`)
     * 3. **960x540 を枠に合わせて伸ばす** (`fit`)。denpa の枠は端末しだいなので
     *    `transform: scale()` で合わせる (`onLoad` が寸法を教えてくれる)
     * 4. **「データ取得中」を出す** (`receiving`)。テレビは電波をずっと拾い続けて
     *    いるので押せばすぐ出るが、denpa は**押されてから読み取り始める**ので数秒待つ
     *    (実測で8秒)。入口の文書はほぼ白紙のまま自分で `invisible` を外してくるので、
     *    素直に映すと**その数秒が真っ白**になる
     * 5. **郵便番号を渡す** (`receiver`)。放送はこれで天気・地域のニュース・防災情報の
     *    場所を決める
     */
    import { onDestroy } from 'svelte';
    import type { Bml, BmlIp, Rect, Service } from '#lib/bml/engine.js';
    import { type Plane, planeArea } from '#lib/bml/plane.js';
    import { read, write } from '#lib/keep.js';
    import type { ResponseMessage } from '#lib/ts/bml-protocol.js';
    import StageNote from './StageNote.svelte';

    interface Props {
        /** 出すか。**押されたら読み込みが始まる** */
        on: boolean;
        /**
         * いま映している局。**変わったら作り直す。**
         *
         * エンジンは一度に一つの放送しか持たない (カルーセルも NVRAM も局ごと)。
         * 局を変えても作り直さずにいると、**前の局の文書が残り**、映像が前の局の
         * 小窓の形に寄せられたままになる
         */
        channel: string | null;
        /** 映像がある入れ物。**小窓へ寄せるのはこちら** (`placeVideo`) */
        media: HTMLElement | null;
        /** 通知を受け取る関数を預ける。`null` を渡すと外れる */
        listen: (handler: ((message: ResponseMessage) => void) | null) => void;
        /**
         * 指のリモコン (`Remote.svelte`) から押すための関数。入れ物ができたら入れ、畳んだら null に戻す
         * (bind で受け取る)。**関数が有るかどうかが、そのままリモコンを出すかどうか** —
         * 入れ物ができる前に出しても押せるものが無い
         */
        press?: ((code: number) => void) | null;
        /**
         * **d を BML に渡す関数** (bind で受け取る)。呼ぶと、いま出ている文書が d
         * (DataButtonPressed) を**聞いていれば**押して true、聞いていなければ何もせず
         * false を返す。**テレビの d と同じ振る舞い**にするためのもの — 局の
         * 「待機ページ」(日テレの beat) は d を押されて初めてメニューを開くので、
         * 出ている間に d を押されたら、閉じる前にまず文書に渡す (`pressD`)
         */
        pressD?: (() => boolean) | null;
        /**
         * 郵便番号 (数字7桁。空なら渡さない)。**放送のアプリが地域を決めるのに読む。**
         *
         * 置き場はサーバの設定 (`server/settings.ts`) で、ここでは受信機の設定として
         * エンジンに渡すだけ (放送は `nvram://receiverinfo/zipcode` で読む)
         */
        postal: string;
        /**
         * 都道府県 (`#lib/prefecture.js` の番号。未設定は 255)。郵便番号と同じく
         * 受信機の設定としてエンジンに渡すだけ (放送は `nvram://receiverinfo/prefecture` で読む)
         */
        prefecture: number;
        /**
         * 双方向 (通信系コンテンツ) を使うか。**既定はオン**
         * (`server/settings.ts` の `bmlNetwork`)。録画の再生では渡さない (昔の番組の送信を今やらない)。
         *
         * オフの間は `isIPConnected` に 0 を返すので、放送のアプリは
         * 「インターネットに接続されていません」と正しく案内します。
         * **嘘をつかないのが大事** — 1 と答えて取りに行けないと、今度は
         * 無言で失敗します
         */
        network: boolean;
        /** 放送の時刻 (UNIX ミリ秒)。録画は再生位置から出す。渡さなければ放送の TOT から */
        clock?: (() => number) | null;
        /**
         * 文書が別の局へ選局したい (epgTune)。**選局は画面がやる** — 局を探して
         * 切り替えたら true、できなければ false (文書に失敗が返る)。ライブは局の一覧から探し、録画は
         * 「録画の再生中は選局できません」と知らせて false を返す。渡さなければいつも失敗
         */
        tune?: ((service: Service) => boolean) | null;
    }

    let {
        on,
        channel,
        media,
        listen,
        press = $bindable(null),
        pressD = $bindable(null),
        postal,
        prefecture,
        network,
        clock = null,
        tune = null,
    }: Props = $props();

    /** リモコンの d。`AribKeyCode.DataButton` と同じ値 (番号で書く理由は `Remote.svelte`) */
    const DATA_BUTTON = 20;

    /**
     * NVRAM の置き場の頭。web-bml を使っていた頃の鍵 (`denpa_bml_denpa_nvram_…`・
     * `denpa_bml_engine`) とは重ならないので、古い端末に残っていても読まれない
     */
    const NVRAM_PREFIX = 'denpa_bml_own_';

    /**
     * 押された d を届けようと見に行く回数と間隔。
     *
     * **一度では届かない。** 文書が組み上がった時点ではまだ `beitem` が
     * `subscribe` になっておらず (それを立てるのはアプリの `onload`)、
     * `DataButtonPressed` は誰にも拾われずに消える。聞く文書が出てくるまで見に行く
     */
    const KNOCK_TRIES = 12;
    const KNOCK_WAIT = 400;

    /**
     * **聞いている文書に届けても、捨てられることがある。**
     *
     * TOKYO MX の入口は `beitem` を最初から `subscribe` にしておきながら、
     * **2秒のあいだ受けた d を捨てます** — 番組終了の通知を待つ間だけ
     * `gEMGet` が偽で、押しても `return` する作りです。こちらの1押しは
     * 0.4秒 で届くので、**ちょうどその捨てられる窓に入って**いました
     * (実機で、入口の文書のまま何も出ない形になった)。
     *
     * **返事が無ければもう一度押します。** テレビの前の人がやることと同じで、
     * 反応 (次の文書が出てくること) があればそこで止めます。
     * `TAP_MOST` までしか押さないのは、**開いたメニューを閉じてしまう局がある**ため
     */
    const TAP_MOST = 3;
    const TAP_WAIT = 2500;

    /** 描く場所。BML の画面 (960x540 など) がこの中に入る */
    let host = $state<HTMLDivElement | null>(null);
    /** いま動いているエンジン */
    let engine = $state<Bml | null>(null);
    /** 読み込み中か。**押してすぐは何も出ないので、そう言う** */
    let loading = $state(false);
    /**
     * BML が「いま出ている」と言っているか。
     *
     * **BML は `invisible` で始まる。** テレビでは d を押すと
     * `DataButtonPressed` が飛び、アプリが自分で `invisible` を外して出てくる。
     * つまり**入れ物を作っただけでは何も出ない** — 中では動いているのに画面は
     * 変わらない、という壊れ方をする (実機でそうなった)
     */
    let showing = $state(false);
    /** いま実際に映しているか (`place` が決める)。`showing` との違いは `settled` を見よ */
    let visible = $state(false);
    /** 何度も作らないための世代。押して離してを繰り返しても混ざらない */
    let generation = 0;
    /** いま何を出しているか (`channel`)。出していなければ `null` */
    let shown = $state<string | null>(null);
    /** その回ぶんの入れ物。**毎回作り直す** (`makeMount` の説明) */
    let mount: HTMLDivElement | null = null;
    /** BML の画面の大きさ。`onLoad` で分かる (960x540 / 720x480 など) */
    let plane: (Omit<Plane, 'aspect'> & { aspect?: Plane['aspect'] }) | null = null;
    /** まだ電波から取っている最中か。**エンジンが教えてくれる** (`onReceiving`)。テレビの「データ取得中…」と同じ表示 */
    let receiving = $state(false);
    /**
     * 一度でも出し切ったか。
     *
     * **最初の1枚が揃うまでは映像のままにしておく。** 入口の文書 (`startup.bml`)
     * は本体へ渡すだけのほぼ白紙で、しかも自分で `invisible` を外してくる。
     * 素直に映すと、**本体が届くまでの数秒が真っ白**になる (実機でそうなった)。
     * テレビは電波をずっと拾い続けているのでこの待ちが無い — denpa は
     * 押されてから読み取り始めるぶん、ここが目に見える。
     *
     * ただし**出し切ったあとは引っ込めない**。中を渡り歩くたびに取得中には
     * なるが、そこで映像に戻ってしまうと画面が点滅する
     */
    let settled = false;
    /** 残りの見に行く回数 */
    let knocks = 0;
    /**
     * **押された d をまだ届け終えていないか。** 出す操作 (画面の d) は文書にとっての
     * d の1押しでもある。入れ物を作った時点では受け取る文書がまだ無いので、聞く文書が
     * 出てくるまで持っておく (`knock`)。**返事があったら下ろす** (`TAP_MOST` の項)
     */
    let dueD = false;
    /** 何回押したか。**返事が無いときだけ増える** (`TAP_MOST`) */
    let taps = 0;
    /** 次に押す約束 */
    let knocking: ReturnType<typeof setTimeout> | null = null;
    /** 枠の大きさを見張る。全画面にすると変わる */
    let watcher: ResizeObserver | null = null;
    /**
     * 渡した通知の数。**画面には出さない** (切り分け用)。
     *
     * データ放送は「押しても何も出ない」という壊れ方をする。**届いていないのか、
     * 届いても描かれないのか**が外から分からないと、どちらを追えばいいかが
     * 決まらない (実機で1日それを探した)
     */
    let handed = $state(0);
    /** 映像の object の場所 (エンジンが教える。画面の座標) */
    let videoRect: Rect | null = null;
    /** 映像の入れ物の元の style。小窓へ寄せる前に覚えて、隠れたら戻す */
    let mediaStyle: string | null = null;
    /**
     * 丸ゴシック。**字幕を描いているのと同じ Denpa Font** (danything/denpa-font)。
     * BML が要る3つ — **等幅**・**丸ゴシック**・**ARIB の外字** — を1つで満たし、
     * データ放送と字幕で字形が揃う。角ゴシックは端末のものに任せる (丸い字で代用すると、
     * 放送が「ここは角」と言っている意味が消える)
     */
    let roundFont: FontFace | null = null;
    /** キーを AribKeyCode に (エンジンを読み込んだら入る。キーの処理で待たずに preventDefault するため) */
    let toAribKey: ((key: string) => number) | null = null;

    /**
     * 双方向 (通信系コンテンツ)。**中継はサーバがやる**
     * (`/api/bml/proxy`。放送局のサーバは CORS を返さないので直には取れない)。
     *
     * 送る (`transmit`)・届くか確かめる (`confirm`)・通信の文書を取る (`get`) を渡す
     * ([docs/stream.md](../../../../docs/stream.md#57-双方向通信系コンテンツプロキシ))。
     *
     * **送るほうは「応募・投票の API」だと思って外していたが、それでは足りない。**
     * 放送のアプリは `isIPConnected` に 1 と答えても信じず、送る API へ一度
     * 投げてみて繋がっているかを決めることがある (NHK がそう)
     */
    const ip: BmlIp = {
        connected: () => network,
        /**
         * **送る。** 中身はエンジンが `Denbun=…` まで組んでから渡してくるので、
         * ここは中継 API へ素通しするだけ。返りも読まずにそのまま返す
         *
         * `resultCode` は 1 が成功。**断られた (403/502) ときだけ NaN** に
         * する — 相手が 404 を返したのは「送れた」ので、放送のアプリに
         * そのまま渡して判断させる
         */
        transmit: async (uri, body) => {
            const response = await fetch(resolve(`api/bml/post?url=${encodeURIComponent(uri)}`), {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: body as Uint8Array<ArrayBuffer>,
            });
            const got = new Uint8Array(await response.arrayBuffer());
            const relayed = response.headers.get('x-bml-relayed') === '1';
            return { resultCode: relayed ? 1 : Number.NaN, status: String(response.status), body: got };
        },
        /** **届くかどうかを確かめる。** NHK は呼びに来ないが、訊いてくる放送はある */
        confirm: async (destination, _icmp, timeout) => {
            const params = new URLSearchParams({ to: destination, wait: String(timeout) });
            const response = await fetch(resolve(`api/bml/confirm?${params}`));
            if (!response.ok) return { success: false, ipAddress: null, responseTimeMillis: null };
            return (await response.json()) as {
                success: boolean;
                ipAddress: string | null;
                responseTimeMillis: number | null;
            };
        },
        /**
         * **通信の文書と、その中の画像・CSS・script を取る** (`launchDocument("https://…")`)。
         * 相手の符号と中身をそのまま返し、中継が断った (403/502) ときだけ null
         */
        get: async (uri) => {
            const response = await fetch(resolve(`api/bml/proxy?url=${encodeURIComponent(uri)}`));
            if (response.headers.get('x-bml-relayed') !== '1') return null;
            return {
                status: response.status,
                contentType: response.headers.get('content-type') ?? 'application/octet-stream',
                body: new Uint8Array(await response.arrayBuffer()),
            };
        },
    };

    /**
     * BML の画面を枠いっぱいに伸ばす。
     *
     * BML は 960x540 のような**決まった大きさ**で組まれていて、エンジンは原寸のまま描く。
     * denpa の枠は端末しだいで変わるので、こちらで合わせる。
     *
     * **縦横を別々に伸ばす** — 映像が枠を埋めているのだから、その上に重ねる
     * ものも同じだけ伸びていないと位置がずれる
     */
    function fit(): void {
        if (mount === null || host === null || plane === null) return;
        const box = host.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return;
        // 4:3 の面 (720x480 の display-aspect-ratio: 4v3) は高さを合わせて左右の真ん中 (`planeArea`)
        const area = planeArea(box, plane);
        mount.style.left = `${area.left}px`;
        mount.style.top = `${area.top}px`;
        mount.style.width = `${plane.width}px`;
        mount.style.height = `${plane.height}px`;
        mount.style.transform = `scale(${area.width / plane.width}, ${area.height / plane.height})`;
        // 枠いっぱいでない面では、映像を寄せる先も枠の大きさで変わる
        if (engine !== null && plane.aspect === '4:3') placeVideo(visible);
    }

    /** 出すかどうかを決め直し、映像の入れ物を寄せる/戻す */
    function place(): void {
        // **出すと決まったら、そこから先は取得中でも出しっぱなし** (`settled`)
        const want = showing && (settled || !receiving);
        if (want) settled = true;
        if (settled || !showing) stopWaiting();
        else startWaiting();
        visible = want;
        if (mount !== null) mount.style.opacity = want ? '1' : '0';
        placeVideo(want);
    }

    /**
     * **映像は動かさない。** 映像の入れ物を、BML の映像の object の場所へ style で
     * 寄せるだけ (入れ物は枠と同じ大きさで、BML の画面も枠いっぱいに伸ばしてある)。
     * 字幕の canvas は入れ物の中なので一緒に縮む (canvas の大きさが変わるので、描く係は
     * `ResizeObserver` で気づいて描き直す)。隠れたら元の style に戻す
     */
    function placeVideo(want: boolean): void {
        if (media === null) return;
        if (want && videoRect !== null && plane !== null) {
            mediaStyle ??= media.style.cssText;
            // 字幕を操作バーの上へ持ち上げない印 (`PlayerStage`。小窓の中は操作バーと重ならない)
            media.dataset['bmlWindow'] = '';
            // 面の中の場所を、枠の中の割合に (4:3 の面は枠の真ん中に置いてある。`fit`)
            const box = host?.getBoundingClientRect() ?? { width: 1, height: 1 };
            const area = planeArea(box, plane);
            const left = box.width > 0 ? area.left / box.width : 0;
            const top = box.height > 0 ? area.top / box.height : 0;
            const sx = box.width > 0 ? area.width / box.width / plane.width : 1 / plane.width;
            const sy = box.height > 0 ? area.height / box.height / plane.height : 1 / plane.height;
            const share = (n: number): string => `${n * 100}%`;
            media.style.inset = 'auto';
            media.style.left = share(left + videoRect.left * sx);
            media.style.top = share(top + videoRect.top * sy);
            media.style.width = share(videoRect.width * sx);
            media.style.height = share(videoRect.height * sy);
            return;
        }
        if (mediaStyle !== null) {
            media.style.cssText = mediaStyle;
            mediaStyle = null;
            delete media.dataset['bmlWindow'];
        }
    }

    /**
     * 取得中が終わるのを待つ上限。
     *
     * **待ち続けて出ないより、白くても出るほうがまし。** 「取得中」が下りない局が
     * あったとき、`settled` を立てる手段が他に無いと**d を押しても永久に何も起きない**
     * ことになる
     */
    const SHOW_WAIT = 8000;
    let waiting: ReturnType<typeof setTimeout> | null = null;

    function startWaiting(): void {
        if (waiting !== null) return;
        waiting = setTimeout(() => {
            waiting = null;
            settled = true;
            place();
        }, SHOW_WAIT);
    }

    function stopWaiting(): void {
        if (waiting !== null) clearTimeout(waiting);
        waiting = null;
    }

    /** 押すのをやめる。**出てきたら、そこで止める** */
    function stopKnocking(): void {
        if (knocking !== null) clearTimeout(knocking);
        knocking = null;
        knocks = 0;
    }

    /** 押して離したことにする。**BML は押しっぱなしを嫌う** (離すまで次が来ない) */
    function tap(code: number): void {
        engine?.key(code, true);
        engine?.key(code, false);
    }

    /** 画面の d (`pressD`)。出ている文書が d を聞いていれば押して true */
    function pressData(): boolean {
        if (engine === null || !visible || !engine.listens('DataButtonPressed')) return false;
        tap(DATA_BUTTON);
        return true;
    }

    /**
     * **押された d を、聞いている文書へ届ける** (`dueD`)。
     *
     * 局の待機ページ (日テレの beat・テレ朝の stream・フジの入口) は自分で出てきて
     * (invisible=false)、d を押されて初めてメニューを開く。NHK は入口が隠れたまま
     * d を待つ。どちらも見えているかは問わないので、聞いているかだけで決める。
     * 文書ができるたびに見に行き直す (`loaded`) — 入口はたいてい別の文書へ渡すだけ。
     *
     * **届けたあとは、返事が来るまで押し直す** (`TAP_MOST` の項)。返事は
     * 「次の文書が出てくること」で、`loaded` が来たらそこで下ろす
     */
    function knock(): void {
        knocking = null;
        if (engine === null || !dueD || knocks <= 0) return;
        knocks--;
        if (!engine.listens('DataButtonPressed')) {
            knocking = setTimeout(knock, KNOCK_WAIT);
            return;
        }
        tap(DATA_BUTTON);
        // 押しただけ数える。**返事があれば `loaded` が下ろす**ので、ここでは待つだけ
        if (++taps >= TAP_MOST) {
            dueD = false;
            return;
        }
        knocking = setTimeout(knock, TAP_WAIT);
    }

    /**
     * 描く入れ物を作る。
     *
     * **毎回まっさらな入れ物を作る。** エンジンは渡された要素に影 (`attachShadow`) を
     * 張る。影は外せないので、同じ要素に2度目を張ると転ぶ — 消して出し直すたびに
     * 「データ放送が出なくなる」という壊れ方をする。
     *
     * 出せと言われるまでは透明にしておく (`showing` の説明)。**`visibility` では隠せない** —
     * エンジンは描く要素ごとに BML の `visibility` を写すので、**子の visible が親の
     * hidden を打ち消す**
     */
    function makeMount(into: HTMLElement): HTMLDivElement {
        const made = document.createElement('div');
        made.style.position = 'absolute';
        made.style.left = '0';
        made.style.top = '0';
        made.style.transformOrigin = 'top left';
        made.style.opacity = '0';
        into.appendChild(made);
        mount = made;
        return made;
    }

    /** 文書が替わった (`onLoad`)。画面の大きさに合わせ、d を届けに行く */
    function loaded(resolution: { width: number; height: number }): void {
        plane = resolution;
        fit();
        /*
         * **押したあとに文書が変わったら、それが返事。** そこで下ろす —
         * これ以上押すと、開いたメニューを閉じることになる
         */
        if (taps > 0) {
            dueD = false;
            stopKnocking();
            return;
        }
        // 文書ができるたびに見に行き直す (`knock`)。届け終えていれば何もしない
        stopKnocking();
        knocks = KNOCK_TRIES;
        knocking = setTimeout(knock, KNOCK_WAIT);
    }

    /** 開く。映像は動かさず、場所を教えてもらって寄せる (`placeVideo`) */
    async function open(): Promise<void> {
        if (host === null || media === null) return;
        const mine = ++generation;
        loading = true;
        // 押されてから取りに行く (上の説明)
        const { createBml, aribKey } = await import('#lib/bml/engine.js');
        toAribKey = aribKey;
        // 待っている間に離されていたら、作らない
        if (mine !== generation || host === null || media === null) return;
        const into = makeMount(host);
        // 出す操作は文書にとっての d の1押し。聞く文書が出てきたら届ける (`knock`)
        dueD = true;
        taps = 0;
        roundFont = new FontFace('denpa-bml-round', `url('${denpaFontUrl()}') format('woff2')`);
        document.fonts.add(roundFont);
        const round = "'denpa-bml-round', 'Hiragino Maru Gothic ProN', 'Meiryo', sans-serif";
        const made = createBml({
            root: into,
            fonts: { round, boldRound: round, square: "'Hiragino Kaku Gothic ProN', 'Meiryo', 'MS Gothic', sans-serif" },
            ip,
            store: { get: (key) => read(NVRAM_PREFIX + key), set: (key, value) => write(NVRAM_PREFIX + key, value) },
            clock: () => clock?.() ?? null,
            receiver: { zipcode: postal, prefecture },
            onVideoRect: (rect, size) => {
                videoRect = rect;
                plane = size;
                place();
            },
            onVisible: (on) => {
                showing = on;
                place();
            },
            onReceiving: (on) => {
                receiving = on;
                place();
            },
            onLoad: (resolution) => {
                loaded(resolution);
                // 映像の場所は画面の大きさが分かってから寄せる
                place();
            },
            // 選局は画面に任せる (エンジンは「この局へ」と言うだけ)
            onTune: (service) => tune?.(service) ?? false,
            log: (message) => console.warn(`[bml] ${message}`),
        });
        engine = made;
        loading = false;
        watcher = new ResizeObserver(fit);
        watcher.observe(host);
        listen((message) => {
            handed++;
            made.feed(message);
        });
        // 指のリモコンにも同じ関数を渡す
        press = tap;
        pressD = pressData;
    }

    function close(): void {
        generation++;
        listen(null);
        press = null;
        pressD = null;
        loading = false;
        handed = 0;
        showing = false;
        receiving = false;
        settled = false;
        stopKnocking();
        stopWaiting();
        dueD = false;
        taps = 0;
        plane = null;
        watcher?.disconnect();
        watcher = null;
        // 映像の入れ物を枠いっぱいに戻す
        place();
        engine?.destroy();
        engine = null;
        videoRect = null;
        if (roundFont !== null) document.fonts.delete(roundFont);
        roundFont = null;
        // 影ごと捨てる (`makeMount` の説明)
        mount?.remove();
        mount = null;
    }

    $effect(() => {
        const want = on && media !== null && host !== null ? (channel ?? '') : null;
        if (want === shown) return;
        close();
        shown = want;
        if (want !== null) void open();
    });

    /**
     * リモコンの代わり。**十字・決定・戻る・数字・色・d** をそのまま渡す
     * (エンジンの `aribKey`)。キーの d は文書へそのまま届く — 入れ物の出し入れは
     * 画面の d ボタンの側 (`pressD`)
     */
    function key(event: KeyboardEvent, down: boolean): void {
        if (engine === null || toAribKey === null) return;
        // 入力欄で打っている字は文書へ渡さない
        const target = event.target;
        if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
            return;
        }
        // 離すほうは修飾キーを見ない (押しっぱなしの扱いが残らないように)
        if (down && (event.altKey || event.ctrlKey || event.metaKey)) return;
        const code = toAribKey(event.key);
        if (code === -1) return;
        event.preventDefault();
        engine.key(code, down);
    }

    onDestroy(close);
</script>

<svelte:window
    onkeydown={(event) => key(event, true)}
    onkeyup={(event) => key(event, false)}
    onblur={() => engine?.releaseKeys()}
/>

<!--
    **映像と同じ枠に重ねる。** BML の画面は中で自分の大きさを決めるので、
    こちらは場所だけ用意する。出していないときは触れないようにしておく
    (押すのを邪魔しない)。

    **操作列より下に敷く** (`z-index: 5` / `ControlBar` は 10)。上に載せていた頃は、
    データ放送を出した瞬間に操作列が隠れた — そこに d ボタンもあるので、
    **出したら消せなくなる**
-->
<div
    bind:this={host}
    class="data"
    hidden={!on}
    data-testid="live-data"
    data-state={engine !== null ? 'ready' : loading ? 'loading' : 'off'}
    data-showing={visible}
    data-receiving={receiving}
    data-for={shown ?? ''}
    data-handed={handed}
>
    <!--
        **テレビと同じ「データ取得中」。** denpa は押されてから放送を読み取り始める
        ので、テレビより待つ (実測で8秒)。何も言わずに待たせると壊れて見える
    -->
    {#if on && (loading || receiving)}
        <div class="corner">
            <StageNote testid="live-data-receiving">データ取得中…</StageNote>
        </div>
    {/if}
</div>

<style>
    .data {
        pointer-events: none;
        position: absolute;
        inset: 0;
        z-index: 5;
        overflow: hidden;
    }
    /* 「取得中」は右上の隅。テレビと同じ場所 (舞台の通知の列には積まない) */
    .corner {
        position: absolute;
        top: 0.75rem;
        right: 0.75rem;
        z-index: 10;
        display: flex;
    }
</style>
