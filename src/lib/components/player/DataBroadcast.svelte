<script module lang="ts">
  import { resolve } from "$app/paths";

  import { denpaFontUrl } from "#lib/font.js";
  /**
   * **画面の d ボタン。テレビと同じ振る舞い。** 出ている文書が d を聞いていれば
   * (`pressD` が true) 渡して終わり — 局の待機ページはこれでメニューを開く。
   * 聞いていなければ入れ物を出し入れする。ライブと録画の両方がここを通る
   */
  export function pressD(
    on: boolean,
    press: (() => boolean) | null,
    set: (on: boolean) => void,
  ): void {
    if (on && press?.() === true) return;
    set(!on);
  }
</script>

<script lang="ts">
  import type { ResponseMessage } from "@danything/arib/bml-protocol";
  /**
   * データ放送を映像の上に重ねる。**描くのはエンジン** (`src/lib/bml/`)。
   *
   * denpa が作った `ResponseMessage` をそのまま食べさせるだけで、**映像は denpa のまま**。
   * エンジンは映像の object の場所を教えるだけで、映像の入れ物をそこへ寄せるのはこちら
   * (`placeVideo`。[docs/stream.md](../../../../docs/stream.md#データ放送の統合))。
   *
   * エンジンは押されてから `import()` で取得する (どのみちカルーセルが一周するのを待つので紛れる)。
   * エンジンの外でやるのは、d を聞いている文書へ届ける (`knock`)・映像の入れ物を小窓へ寄せる (`placeVideo`)・
   * 960x540 を枠に合わせて伸ばす (`fit`)・「データ取得中」を出す (`receiving`)・郵便番号を渡す (`receiver`)
   */
  import { onDestroy, untrack } from "svelte";

  import type { Bml, BmlIp, Rect, Service } from "#lib/bml/engine.js";
  import { type Plane, planeArea } from "#lib/bml/plane.js";
  import {
    type FrameMessage,
    type HcState,
    VIEWPORT,
  } from "#lib/hybridcast/app.js";
  import type { CompatInit } from "#lib/hybridcast/compat.js";
  import { parseXmlAit } from "#lib/hybridcast/xml-ait.js";
  import { read, readAll, write } from "#lib/keep.js";
  import type { HybridcastLink } from "#lib/live.js";

  import HybridcastFrame from "./HybridcastFrame.svelte";
  import StageNote from "./StageNote.svelte";

  type Place = Extract<FrameMessage, { type: "video" }>["place"];

  interface Props {
    /** 開いているか (d を押したか)。**押されたら読み込みが始まる** (`receive` なら読み込んである) */
    on: boolean;
    /**
     * 常に受信しているか (再生の設定。`data-receive.ts`)。**開いていなくてもエンジンを動かし**、
     * 文書が自分で出したもの (番組からの誘導・自動で出る画面) はテレビと同じく映像に重ねる。
     * 開くまではリモコンを出さず、キー・d を渡さず、選局と Hybridcast の起動は断る
     */
    receive?: boolean;
    /** いま映している局。変わったら作り直す (エンジンは一度に一つの放送しか持たない) */
    channel: string | null;
    /** 映像がある入れ物。**小窓へ寄せるのはこちら** (`placeVideo`) */
    media: HTMLElement | null;
    /** 通知を受け取る関数を預ける。`null` を渡すと外れる */
    listen: (handler: ((message: ResponseMessage) => void) | null) => void;
    /**
     * 指のリモコン (`Remote.svelte`) から押すための関数 (bind で受け取る)。入れ物ができたら入り、畳んだら null。
     * 有るかどうかが、そのままリモコンを出すかどうか
     */
    press?: ((code: number) => void) | null;
    /**
     * d を BML に渡す関数 (bind で受け取る)。出ている文書が d (DataButtonPressed) を聞いていれば押して true、
     * 聞いていなければ false (`pressD`。局の待機ページは d を押されて初めてメニューを開く)
     */
    pressD?: (() => boolean) | null;
    /** 郵便番号 (数字7桁。空なら渡さない)。受信機の設定として渡す (`nvram://receiverinfo/zipcode`) */
    postal: string;
    /** 都道府県 (`#lib/prefecture.js` の番号。未設定は 255。`nvram://receiverinfo/prefecture`) */
    prefecture: number;
    /**
     * 双方向 (通信系コンテンツ) を使うか (`server/settings.ts` の `bmlNetwork`)。録画の再生では使わない。
     * オフなら `isIPConnected` に 0 を返し、放送のアプリに正しく案内させる (1 と答えて取れないと無言で失敗する)
     */
    network: boolean;
    /** 放送の時刻 (UNIX ミリ秒)。録画は再生位置から出す。渡さなければ放送の TOT から */
    clock?: (() => number) | null;
    /** 文書が別の局へ選局したい (epgTune)。選局は画面がやり、切り替えたら true。渡さなければいつも失敗 */
    tune?: ((service: Service) => boolean) | null;
    /**
     * この番組に載っている Hybridcast (AIT)。文書が起動を求めたら (startAITControlledApp) 映像の上に開く
     * (`HybridcastFrame`)。双方向がオフ (`network`) なら開かない — 文書の問い合わせにも「無い」と答える
     */
    apps?: HybridcastLink[];
    /** 局の名前 (Hybridcast のアプリに渡す) */
    serviceName?: string;
    /** 字幕を出しているか、と切り替え (Hybridcast のアプリから) */
    captions?: boolean;
    setCaptions?: ((on: boolean) => void) | null;
  }

  let {
    on,
    receive = false,
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
    apps = [],
    serviceName = "",
    captions = false,
    setCaptions = null,
  }: Props = $props();

  /** いま開いている Hybridcast のアプリ。開いている間は BML を隠し、キーはアプリへ渡す */
  let running = $state<HybridcastLink | null>(null);
  /** アプリが言う映像の置き場 (`HybridcastFrame` の `onvideo`) */
  let appVideo: Place = "full";
  /** アプリへキーを渡す関数 (`HybridcastFrame` の `press`) */
  let appPress = $state<((code: number, down: boolean) => void) | null>(null);
  /** いまの番組 (放送の programInfo)。アプリへ渡す */
  let program = $state<HcState["program"]>(null);
  const hcState = $derived<HcState>({ program, serviceName, captions });

  /**
   * どのアプリを開くか。文書が渡した数に organisation_id と application_id が両方あればそれ、
   * application_id だけ合うものがあればそれ、無ければ AIT の先頭 (autostart を先に)
   */
  function pickApp(
    hint: number[],
    from: HybridcastLink[] = apps,
  ): HybridcastLink | null {
    return (
      from.find(
        (a) =>
          hint.includes(a.organisationId) && hint.includes(a.applicationId),
      ) ??
      from.find((a) => hint.includes(a.applicationId)) ??
      from.find((a) => a.autostart) ??
      from[0] ??
      null
    );
  }

  function startApp(hint: number[]): boolean {
    // 開くまでは外のアプリを開かない (受信しているだけ。`receive`)
    if (!on) return false;
    const app = pickApp(hint);
    if (app === null) return false;
    openApp(app);
    return true;
  }

  /**
   * XML の AIT から開く (電波に AIT が無い局。`bml/browser.ts` の `startAppFrom`)。**取得を始めたら true** —
   * 文書には待たずに答え、届いたら開く。取れない・開けるアプリが無いときは、何を読もうとしたかをコンソールに残してデータ放送のまま
   */
  function startAppFrom(uri: string, hint: number[]): boolean {
    if (!network || !on) return false;
    void (async () => {
      try {
        const response = await fetch(
          resolve(`api/bml/proxy?url=${encodeURIComponent(uri)}`),
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const app = pickApp(hint, parseXmlAit(await response.text()));
        if (app === null) throw new Error("開けるアプリがありません");
        // 閉じたあとに届いたら開かない
        if (engine === null) return;
        console.warn(`[bml] XML の AIT から開きます: ${app.url}`);
        openApp(app);
      } catch (failure) {
        console.warn(
          `[bml] XML の AIT を読めませんでした: ${uri} (${failure})`,
        );
      }
    })();
    return true;
  }

  function openApp(app: HybridcastLink): void {
    // 同じアプリなら開き直さない (文書が何度も呼んでくることがある)。別のアプリなら替える
    if (running?.url !== app.url) {
      running = app;
      appVideo = "full";
      // 届け途中の d はここまで (押し直すと、開いたアプリを閉じてしまう)
      dueD = false;
      stopKnocking();
      engine?.releaseKeys();
      place();
    }
  }

  /**
   * アプリに渡すデータ放送の Greg と NVRAM (`hybridcast/compat.ts`)。**NVRAM はアプリを起動した局から見える分だけ** —
   * 放送の文書と同じ領域を使わせる (アプリは AIT で局が起動させたもの)
   */
  function broadcastFor(): CompatInit {
    const who = {
      originalNetworkId: program?.originalNetworkId ?? null,
      serviceId: program?.serviceId ?? null,
    };
    const visible = nvramVisible;
    const nvram = Object.fromEntries(
      Object.entries(readAll(NVRAM_PREFIX)).filter(
        ([key]) => visible?.(key, who) === true,
      ),
    );
    return {
      greg: engine?.greg.slice() ?? [],
      nvram,
      receiver: { zipcode: postal, prefecture },
      who,
    };
  }

  /**
   * アプリが Greg・NVRAM に書いた。**NVRAM はアプリを開いた局 (`who`) から見えるものだけ**受け取る
   * (中身はアプリの言うまま。1 ブロック 64 バイトの base64)。開いた後に選局していても、開いた局の領域に書く
   */
  function written(
    change: Extract<FrameMessage, { type: "greg" | "nvram" }>,
    who: CompatInit["who"],
  ): void {
    if (change.type === "greg") {
      if (engine !== null)
        engine.greg[change.index] = change.value.slice(0, 256);
      return;
    }
    if (nvramVisible?.(change.key, who) === true && change.value.length <= 88)
      write(NVRAM_PREFIX + change.key, change.value);
  }

  /** アプリを閉じてデータ放送へ戻る */
  function closeApp(): void {
    if (running === null) return;
    running = null;
    appVideo = "full";
    place();
  }

  /** リモコンの d。`AribKeyCode.DataButton` と同じ値 (番号で書く理由は `Remote.svelte`) */
  const DATA_BUTTON = 20;

  /**
   * NVRAM の置き場の頭。web-bml を使っていた頃の鍵 (`denpa_bml_denpa_nvram_…`・
   * `denpa_bml_engine`) とは重ならないので、古い端末に残っていても読まれない
   */
  const NVRAM_PREFIX = "denpa_bml_own_";

  /**
   * 押された d を届けようと見に行く回数と間隔。文書が組み上がった時点ではまだ `beitem` が `subscribe` に
   * なっておらず (立てるのはアプリの `onload`)、一度では届かない
   */
  const KNOCK_TRIES = 12;
  const KNOCK_WAIT = 400;

  /**
   * 届けても捨てられることがある (TOKYO MX の入口は最初の2秒に受けた d を捨てる)。返事 (次の文書) が
   * 無ければもう一度押す。`TAP_MOST` までにするのは、開いたメニューを閉じてしまう局があるため
   */
  const TAP_MOST = 3;
  const TAP_WAIT = 2500;

  /** 描く場所。BML の画面 (960x540 など) がこの中に入る */
  let host = $state<HTMLDivElement | null>(null);
  /** いま動いているエンジン */
  let engine = $state<Bml | null>(null);
  /** 読み込み中か。**押してすぐは何も出ないので、そう言う** */
  let loading = $state(false);
  /** BML が「いま出ている」と言っているか。BML は `invisible` で始まり、d を受けたアプリが自分で外して出てくる */
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
  let plane: (Omit<Plane, "aspect"> & { aspect?: Plane["aspect"] }) | null =
    null;
  /** まだ電波から取っている最中か。**エンジンが教えてくれる** (`onReceiving`)。テレビの「データ取得中…」と同じ表示 */
  let receiving = $state(false);
  /**
   * 一度でも出し切ったか。最初の1枚が揃うまでは映像のままにする — 入口の文書はほぼ白紙のまま自分で
   * `invisible` を外すので、本体が届くまでの数秒が真っ白になる。出し切ったあとは引っ込めない (点滅する)
   */
  let settled = false;
  /** 残りの見に行く回数 */
  let knocks = 0;
  /** 押された d (出す操作は文書にとっての d の1押し) をまだ届け終えていないか (`knock`) */
  let dueD = false;
  /** 何回押したか。**返事が無いときだけ増える** (`TAP_MOST`) */
  let taps = 0;
  /** 次に押す約束 */
  let knocking: ReturnType<typeof setTimeout> | null = null;
  /** 枠の大きさを見張る。全画面にすると変わる */
  let watcher: ResizeObserver | null = null;
  /** 渡した通知の数 (`data-handed`。届いていないのか描かれないのかの切り分け用) */
  let handed = $state(0);
  /** 映像の object の場所 (エンジンが教える。画面の座標) */
  let videoRect: Rect | null = null;
  /** 映像の入れ物の元の style。小窓へ寄せる前に覚えて、隠れたら戻す */
  let mediaStyle: string | null = null;
  /**
   * 丸ゴシック。字幕と同じ Denpa Font (等幅・丸ゴシック・ARIB の外字を1つで満たす)。
   * 角ゴシックは端末のものに任せる (丸で代用すると放送の「ここは角」が消える)
   */
  let roundFont: FontFace | null = null;
  /** キーを AribKeyCode に (エンジンを読み込んだら入る。キーの処理で待たずに preventDefault するため) */
  let toAribKey: ((key: string) => number) | null = null;
  /** NVRAM の鍵が、その局から見えるものか (エンジンと一緒に読む。Hybridcast のアプリへ写す分を選ぶ) */
  let nvramVisible: typeof import("#lib/bml/nvram.js").visibleFrom | null =
    null;

  /**
   * 双方向 (通信系コンテンツ)。中継はサーバがやる (放送局のサーバは CORS を返さない。
   * [docs/stream.md](../../../../docs/stream.md#双方向通信系コンテンツプロキシ))。送るほうも要る —
   * NHK は `isIPConnected` を信じず、送る API へ一度投げて繋がっているかを決める
   */
  const ip: BmlIp = {
    connected: () => network,
    /**
     * 送る (エンジンが組んだ `Denbun=…` を中継へ素通し)。`resultCode` は 1 が成功で、中継が断った (403/502)
     * ときだけ NaN — 相手の 404 は「送れた」ので、放送のアプリに判断させる
     */
    transmit: async (uri, body) => {
      const response = await fetch(
        resolve(`api/bml/post?url=${encodeURIComponent(uri)}`),
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body as Uint8Array<ArrayBuffer>,
        },
      );
      const got = new Uint8Array(await response.arrayBuffer());
      const relayed = response.headers.get("x-bml-relayed") === "1";
      return {
        resultCode: relayed ? 1 : Number.NaN,
        status: String(response.status),
        body: got,
      };
    },
    /** **届くかどうかを確かめる。** NHK は呼びに来ないが、訊いてくる放送はある */
    confirm: async (destination, _icmp, timeout) => {
      const params = new URLSearchParams({
        to: destination,
        wait: String(timeout),
      });
      const response = await fetch(resolve(`api/bml/confirm?${params}`));
      if (!response.ok)
        return { success: false, ipAddress: null, responseTimeMillis: null };
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
      const response = await fetch(
        resolve(`api/bml/proxy?url=${encodeURIComponent(uri)}`),
      );
      if (response.headers.get("x-bml-relayed") !== "1") return null;
      return {
        status: response.status,
        contentType:
          response.headers.get("content-type") ?? "application/octet-stream",
        body: new Uint8Array(await response.arrayBuffer()),
      };
    },
  };

  /**
   * BML の画面 (960x540 など。エンジンは原寸で描く) を枠いっぱいに伸ばす。縦横は別々に —
   * 枠を埋めている映像と同じだけ伸びていないと位置がずれる
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
    if (engine !== null && plane.aspect === "4:3") placeVideo(visible);
  }

  /** 出すかどうかを決め直し、映像の入れ物を寄せる/戻す */
  function place(): void {
    // **出すと決まったら、そこから先は取得中でも出しっぱなし** (`settled`)
    const want = showing && (settled || !receiving);
    if (want) settled = true;
    if (settled || !showing) stopWaiting();
    // 見切って出すのは開いているときだけ。受信しているだけなら、揃うまで映像のまま
    else if (on) startWaiting();
    visible = want;
    // Hybridcast のアプリを開いている間は BML を隠す (閉じたら戻す)
    if (mount !== null)
      mount.style.opacity = want && running === null ? "1" : "0";
    placeVideo(want);
  }

  /**
   * 映像の入れ物を、BML の映像の object の場所へ style で寄せる (映像そのものは動かさない)。字幕の canvas は
   * 入れ物の中なので一緒に縮む。隠れたら元の style に戻す
   */
  function placeVideo(want: boolean): void {
    if (media === null) return;
    const share = (n: number): string => `${n * 100}%`;
    // Hybridcast のアプリを開いている間は、アプリの言う場所 (1920x1080 の座標。枠いっぱいに伸ばしてある)
    if (running !== null && appVideo !== "full") {
      mediaStyle ??= media.style.cssText;
      media.dataset["bmlWindow"] = "";
      if (appVideo === "hidden") {
        media.style.opacity = "0";
        return;
      }
      media.style.opacity = "";
      /*
       * **アプリの上に出す。** テレビは映像を放送の object の場所に描く。アプリは枠の周りを塗る
       * (NHK は枠を黒、画面を灰色) ので、下に敷いたままだと隠れる。操作列 (10) よりは下
       */
      media.style.zIndex = "6";
      media.style.inset = "auto";
      media.style.left = share(appVideo.left / VIEWPORT.width);
      media.style.top = share(appVideo.top / VIEWPORT.height);
      media.style.width = share(appVideo.width / VIEWPORT.width);
      media.style.height = share(appVideo.height / VIEWPORT.height);
      return;
    }
    if (running === null && want && videoRect !== null && plane !== null) {
      mediaStyle ??= media.style.cssText;
      // 字幕を操作バーの上へ持ち上げない印 (`PlayerStage`。小窓の中は操作バーと重ならない)
      media.dataset["bmlWindow"] = "";
      // 面の中の場所を、枠の中の割合に (4:3 の面は枠の真ん中に置いてある。`fit`)
      const box = host?.getBoundingClientRect() ?? { width: 1, height: 1 };
      const area = planeArea(box, plane);
      const left = box.width > 0 ? area.left / box.width : 0;
      const top = box.height > 0 ? area.top / box.height : 0;
      const sx =
        box.width > 0 ? area.width / box.width / plane.width : 1 / plane.width;
      const sy =
        box.height > 0
          ? area.height / box.height / plane.height
          : 1 / plane.height;
      media.style.inset = "auto";
      media.style.left = share(left + videoRect.left * sx);
      media.style.top = share(top + videoRect.top * sy);
      media.style.width = share(videoRect.width * sx);
      media.style.height = share(videoRect.height * sy);
      return;
    }
    if (mediaStyle !== null) {
      media.style.cssText = mediaStyle;
      mediaStyle = null;
      delete media.dataset["bmlWindow"];
    }
  }

  /** 取得中が終わるのを待つ上限。「取得中」が下りない局でも、白くても出るほうがまし */
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
    // Hybridcast のアプリを開いている間はアプリへ (戻る・d は閉じる)
    if (running !== null) {
      appPress?.(code, true);
      appPress?.(code, false);
      return;
    }
    engine?.key(code, true);
    engine?.key(code, false);
  }

  /** 画面の d (`pressD`)。出ている文書が d を聞いていれば押して true。Hybridcast を開いていれば閉じて true */
  function pressData(): boolean {
    if (running !== null) {
      closeApp();
      return true;
    }
    if (engine === null || !visible || !engine.listens("DataButtonPressed"))
      return false;
    tap(DATA_BUTTON);
    return true;
  }

  /**
   * 押された d を、聞いている文書へ届ける (`dueD`)。見えているかは問わない (NHK は隠れたまま d を待ち、
   * 民放の待機ページは自分で出てから待つ)。届けたあとは返事 (`loaded`) が来るまで押し直す (`TAP_MOST`)
   */
  function knock(): void {
    knocking = null;
    if (engine === null || !dueD || knocks <= 0) return;
    knocks--;
    if (!engine.listens("DataButtonPressed")) {
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
   * 描く入れ物を毎回まっさらに作る (エンジンが張る影 `attachShadow` は外せず、同じ要素に2度目を張ると転ぶ)。
   * 出せと言われるまでは透明に — `visibility` では子の visible が親の hidden を打ち消す
   */
  function makeMount(into: HTMLElement): HTMLDivElement {
    const made = document.createElement("div");
    made.style.position = "absolute";
    made.style.left = "0";
    made.style.top = "0";
    made.style.transformOrigin = "top left";
    made.style.opacity = "0";
    into.appendChild(made);
    mount = made;
    return made;
  }

  /** 文書が替わった (`onLoad`)。画面の大きさに合わせ、d を届けに行く */
  function loaded(resolution: { width: number; height: number }): void {
    plane = resolution;
    fit();
    // 押したあとに文書が変わったら、それが返事。これ以上押すと開いたメニューを閉じる
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
    // 押されてから取得する (上の説明)
    const { createBml, aribKey, visibleFrom } =
      await import("#lib/bml/engine.js");
    toAribKey = aribKey;
    nvramVisible = visibleFrom;
    // 待っている間に離されていたら、作らない
    if (mine !== generation || host === null || media === null) return;
    const into = makeMount(host);
    // 出す操作は文書にとっての d の1押し。聞く文書が出てきたら届ける (`knock`)。受信しているだけなら届けない
    dueD = on;
    taps = 0;
    roundFont = new FontFace(
      "denpa-bml-round",
      `url('${denpaFontUrl()}') format('woff2')`,
    );
    document.fonts.add(roundFont);
    const round =
      "'denpa-bml-round', 'Hiragino Maru Gothic ProN', 'Meiryo', sans-serif";
    const made = createBml({
      root: into,
      fonts: {
        round,
        boldRound: round,
        square:
          "'Hiragino Kaku Gothic ProN', 'Meiryo', 'MS Gothic', sans-serif",
      },
      ip,
      store: {
        get: (key) => read(NVRAM_PREFIX + key),
        set: (key, value) => write(NVRAM_PREFIX + key, value),
      },
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
      // 選局は画面に任せる (エンジンは「この局へ」と言うだけ)。開くまでは断る (勝手に局を替えない)
      onTune: (service) => on && (tune?.(service) ?? false),
      // 開くまでは、自動起動の指定がある入口だけ動かす (`receive`)
      opened: () => on,
      // Hybridcast。双方向がオフなら開かない (エンジンも問い合わせに「無い」と答える)
      hybridcast: {
        ready: () => network && apps.length > 0,
        start: startApp,
        startFrom: startAppFrom,
      },
      log: (message) => console.warn(`[bml] ${message}`),
    });
    engine = made;
    loading = false;
    watcher = new ResizeObserver(fit);
    watcher.observe(host);
    listen((message) => {
      handed++;
      made.feed(message);
      if (message.type === "programInfo") {
        const p = made.program();
        program =
          p === null
            ? null
            : {
                originalNetworkId: p.originalNetworkId,
                transportStreamId: p.transportStreamId,
                serviceId: p.serviceId,
                eventId: p.eventId,
                eventName: p.eventName,
                startTimeUnixMillis: p.startTimeUnixMillis,
                durationSeconds: p.durationSeconds,
              };
      }
    });
    // 指のリモコンにも同じ関数を渡す。受信しているだけなら、開くまで渡さない (`opened`)
    if (on) {
      press = tap;
      pressD = pressData;
    }
  }

  /**
   * 受信しているところで開いた。エンジンは作り直さず (カルーセルを待たない)、出す操作を d の1押しとして届けに行き、
   * リモコンを渡す。自動起動でない入口はここで始まる (`Bml.open`)
   */
  function opened(): void {
    if (engine === null) return;
    dueD = true;
    taps = 0;
    press = tap;
    pressD = pressData;
    engine.open();
    // 文書はもう組み上がっていることがある。次の文書 (`loaded`) を待たずに届けに行く
    stopKnocking();
    knocks = KNOCK_TRIES;
    knocking = setTimeout(knock, KNOCK_WAIT);
    place();
  }

  /**
   * 受信したまま閉じた。エンジンは捨てず、入口から出直させる (待機の状態へ戻す。`Bml.reset`)。
   * Hybridcast のアプリは閉じ、リモコンは引っ込める
   */
  function closed(): void {
    if (engine === null) return;
    running = null;
    appVideo = "full";
    press = null;
    pressD = null;
    dueD = false;
    taps = 0;
    stopKnocking();
    stopWaiting();
    settled = false;
    engine.releaseKeys();
    engine.reset();
    place();
  }

  function close(): void {
    generation++;
    running = null;
    appVideo = "full";
    program = null;
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
    const want =
      (on || receive) && media !== null && host !== null
        ? (channel ?? "")
        : null;
    if (want === shown) return;
    close();
    shown = want;
    if (want !== null) void open();
  });

  // 受信したまま開いた・閉じた。エンジンが無ければ (読み込み中・受信していない) 作るとき・畳むときに済む
  $effect(() => {
    const now = on;
    untrack(() => {
      if (now) opened();
      else closed();
    });
  });

  /**
   * リモコンの代わり。**十字・決定・戻る・数字・色・d** をそのまま渡す
   * (エンジンの `aribKey`)。キーの d は文書へそのまま届く — 入れ物の出し入れは
   * 画面の d ボタンの側 (`pressD`)
   */
  function key(event: KeyboardEvent, down: boolean): void {
    // 開くまではキーを渡さない (プレイヤーの操作のキーを奪わない。`receive`)
    if (engine === null || toAribKey === null || !on) return;
    // 入力欄で打っている字は文書へ渡さない
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
    ) {
      return;
    }
    // 離すほうは修飾キーを見ない (押しっぱなしの扱いが残らないように)
    if (down && (event.altKey || event.ctrlKey || event.metaKey)) return;
    const code = toAribKey(event.key);
    if (code === -1) return;
    event.preventDefault();
    // Hybridcast のアプリを開いている間はアプリへ (iframe に入力が向いていれば、こちらには来ない)
    if (running !== null) appPress?.(code, down);
    else engine.key(code, down);
  }

  onDestroy(close);
</script>

<svelte:window
  onkeydown={(event) => key(event, true)}
  onkeyup={(event) => key(event, false)}
  onblur={() => engine?.releaseKeys()}
/>

<!--
    映像と同じ枠に重ねる。操作列より下に敷く (`z-index: 5` / `ControlBar` は 10) — 上に載せると
    d ボタンごと隠れて、出したら消せなくなる
-->
<div
  bind:this={host}
  class="data"
  hidden={!on && !receive}
  data-testid="live-data"
  data-open={on}
  data-state={engine !== null ? "ready" : loading ? "loading" : "off"}
  data-showing={visible}
  data-receiving={receiving}
  data-for={shown ?? ""}
  data-handed={handed}
>
  {#if running !== null}
    {#key running.url}
      <HybridcastFrame
        app={running}
        hc={hcState}
        broadcast={broadcastFor}
        onwrite={written}
        onclose={closeApp}
        ontune={(service) => tune?.(service) ?? false}
        oncaptions={(on) => setCaptions?.(on)}
        onvideo={(where) => {
          appVideo = where;
          place();
        }}
        bind:press={appPress}
      />
    {/key}
  {/if}
  <!-- テレビと同じ「データ取得中」。押されてから読み取り始めるので、テレビより待つ (実測で8秒) -->
  {#if on && running === null && (loading || receiving)}
    <div class="corner">
      <StageNote>データ取得中…</StageNote>
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
