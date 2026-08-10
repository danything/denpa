<script lang="ts">
    import { onMount } from 'svelte';
    import ProgramFacts from '$lib/components/ProgramFacts.svelte';
    import { screenAwake } from '$lib/components/player/awake.svelte';
    import ControlBar from '$lib/components/player/ControlBar.svelte';
    import ControlButton from '$lib/components/player/ControlButton.svelte';
    import { playerControls } from '$lib/components/player/controls.svelte';
    import DataBroadcast from '$lib/components/player/DataBroadcast.svelte';
    import Icon from '$lib/components/player/Icon.svelte';
    import {
        AUDIO,
        CAPTION,
        DATA,
        EXPAND,
        INFO,
        OVERLAY,
        OVERLAY_BTN,
        PAUSE,
        PLAY,
        SHRINK,
        SOUND_OFF,
        SOUND_ON,
    } from '$lib/components/player/icons';
    import Remote from '$lib/components/player/Remote.svelte';
    import { programDetail } from '$lib/detail.svelte';
    import { time } from '$lib/format';
    import { LIVE_CODECS } from '$lib/live';
    import { livePlayer } from '$lib/live-player.svelte';
    import { FLOOR, SPEEDS } from '$lib/ts/pacing';
    import type { LiveChannel } from './+page.server';

    let { data } = $props();
    // 局が入れ替わると読み込み直されるので、値ではなく参照で持つ
    const channels = $derived(data.channels as LiveChannel[]);

    const player = livePlayer();
    let video: HTMLVideoElement;
    /** 切り替えの間、前の絵を貼っておく先 (`live-player` の `freeze`) */
    let still: HTMLCanvasElement;
    /** 放送の字幕を重ねる先 (`live-player` の `paint`) */
    let overlay: HTMLCanvasElement;
    /** 映像が居る入れ物。**データ放送に「映像はここ」と伝えるのに要る** */
    let mediaBox = $state<HTMLElement | null>(null);
    /**
     * データ放送に押す口。**器ができてから預かる** (`DataBroadcast` の `remote`)。
     *
     * これが有るかどうかが、そのまま**指のリモコンを出すかどうか**になる —
     * 押しても行き先が無いリモコンは出さない
     */
    let dataPress = $state<((code: number) => void) | null>(null);
    /** 映像も重ねるものも入っている枠。全画面にするのはここ */
    let frame: HTMLElement;

    /**
     * **サーバが決めた局で開く** (`+page.server.ts` の `start`)。
     *
     * 名指し (`?service=`) → 覚えている前回の局 → 一覧の先頭、の順で決まって
     * いる。**こちらでも同じ判断をしない** — サーバは既にその局を焼きはじめて
     * いるので (`server/live.ts` の `warm`)、判断がずれると先に焼いたものが
     * 使われないまま別の局が開く
     */
    onMount(() => {
        // 重ねるものの置き場を先に渡す。選局はこのあと
        player.attach(still, overlay);
        if (data.start !== null) void player.tune(video, data.start);
        return () => player.stop();
    });

    /**
     * いま映している局。一覧で目立たせる。
     *
     * **局で引く。** 物理チャンネルで引いていた頃は、**1本に複数の局が乗って
     * いると先頭の局が塗られていた** — MX2 を選んでも MX1 の行が光る。
     * 焼いているのは選んだ局なので (`live.ts`)、絵と印が食い違う
     */
    const current = $derived(channels.find((c) => c.id === player.tuned?.serviceId));

    /*
     * **一覧は種別で切り替える。** 地上波・BS・CS を全部縦に並べると、CS の局が
     * 100を超える環境では地上波が上のほうへ流れて見えなくなる。番組表と
     * 同じ並び・同じ見た目にしてあるので、探す場所がずれない
     */
    const TYPE_LABEL: Record<string, string> = { GR: '地上波', BS: 'BS', CS: 'CS' };
    /** 局を持っている種別だけ出す。BS を繋いでいない環境で空の見出しを出さない */
    const types = $derived(['GR', 'BS', 'CS'].filter((t) => channels.some((c) => c.type === t)));
    /** **開いたときは、いま映している局の種別。** 選び直す手間を増やさない */
    let picked = $state<string | null>(null);
    const shown = $derived(picked ?? current?.type ?? types[0] ?? 'GR');
    const listed = $derived(channels.filter((c) => c.type === shown));

    /**
     * 局を選ぶ。
     *
     * **焼き方は引き継ぐ。** 絵の中身ではなく「その端末で出るか」の話なので、
     * 局を選び直すたびに H.264 へ戻されては選んだ意味が無い。
     *
     * **音声は引き継がない。** あちらは番組ごとに構成が変わるもので、局が変われば
     * 前の合言葉はもう指すものが無い (サーバが主音声に落とす)
     */
    function select(channel: LiveChannel): void {
        void player.tune(video, {
            channelType: channel.type,
            channel: channel.channel,
            serviceId: channel.id,
            codec: player.codec,
        });
    }

    /**
     * 一覧の各行。**開いたときに、いま映しているものまで送るのに要る。**
     *
     * 局が100を超える環境では、覚えていた局が画面の外にあることのほうが普通。
     * 探させるのは、テレビを点けたときの振る舞いから遠い
     */
    const rows: Record<number, HTMLElement | undefined> = $state({});
    /** 一覧そのもの。**送るのはこの中だけ** (下の説明) */
    let list = $state<HTMLElement | null>(null);
    /** 一度送ったら、あとは触らない。見ている途中で勝手に動くと邪魔になる */
    let scrolled = false;
    $effect(() => {
        const row = current === undefined ? undefined : rows[current.id];
        if (scrolled || row === undefined || list === null) return;
        scrolled = true;
        /*
         * **`scrollIntoView` は使わない。ページごと動く。**
         *
         * あれは「その要素が見えるところまで、**動かせるものは何でも動かす**」
         * ので、一覧が中で動けないときは窓のほうが動く。一覧が中で動けるのは
         * 横に並ぶ幅 (lg) だけで、**畳まれた幅では高さの上限が無い** —
         * そこでは映像ごと上へ送られて、開いた瞬間に絵が画面から出ていた。
         * 開き直しでは起きず**読み込み直したときだけ**起きるので
         * (覚えていた局に送るのは1回きり)、「リロードすると画面全体が動く」
         * という出方をする。
         *
         * 動かすのは一覧の中身だけにする。中で動けない幅では**何も起きない**
         * のが正しい — 畳まれた幅では一覧はページの続きなので、そこまで
         * 送ってしまうと今度は映像が見えない
         */
        const room = list.scrollHeight - list.clientHeight;
        if (room <= 0) return;
        // 位置は見えている座標から起こす。offsetTop は入れ子の基準がずれる
        const here = row.getBoundingClientRect();
        const box = list.getBoundingClientRect();
        const middle = list.scrollTop + (here.top - box.top) - (box.height - here.height) / 2;
        list.scrollTop = Math.max(0, Math.min(room, middle));
    });

    /**
     * 右の列に出す番組の中身。**モーダルにしない** — 絵の上に被さると
     * 観ながら読めない (観る画面と同じ。`detail.svelte.ts`)。
     *
     * 行が持っているのは名前と時刻までで、あらすじや出演者は番組表の側にある。
     * 開いた時点で引き直す
     */
    const detail = programDetail();
    function openDetail(channel: LiveChannel): void {
        if (channel.now === null) return;
        void detail.open(channel.now.id, {
            name: channel.now.name,
            service_name: channel.name,
            start_at: channel.now.startAt,
            end_at: channel.now.endAt,
            description: channel.now.description ?? undefined,
        });
    }

    /** 全画面。映像だけでなく操作列も一緒に大きくしたいので、箱ごと入れる */
    let fullscreened = $state(false);
    function full(): void {
        // **枠ごと。** 映像だけでなく操作列も一緒に大きくする
        if (frame === undefined) return;
        if (document.fullscreenElement === null) void frame.requestFullscreen().catch(() => {});
        else void document.exitFullscreen().catch(() => {});
    }
    $effect(() => {
        const update = () => (fullscreened = document.fullscreenElement !== null);
        document.addEventListener('fullscreenchange', update);
        return () => document.removeEventListener('fullscreenchange', update);
    });

    /** 操作列の出し入れ ([controls.svelte.ts](../../lib/components/player/controls.svelte.ts))。観る画面と同じ */
    const controls = playerControls();
    $effect(() => {
        controls.held = player.paused;
    });

    /**
     * 観ている間は画面を落とさせない ([awake.svelte.ts](../../lib/components/player/awake.svelte.ts))。
     * 動画は触らずに見るものなので、**再生中こそいちばん落とされる**
     */
    const awake = screenAwake();
    $effect(() => {
        awake.on = !player.paused && player.state === 'playing';
    });
    const controlsShown = $derived(controls.shown);
    const wake = controls.wake;
    const away = controls.away;
    const toggle = controls.toggle;
</script>

<!--
    **映像を左、局を右。** 動画を見ながら次を選べる並びで、YouTube の再生画面と
    同じ形。畳まれる幅では縦に積む (横に並べると映像が切手大になる)。

    **広い画面ではページごとスクロールさせない** (`+layout.svelte` の `fill`)。
    映像を見ながら選ぶものなので、ページが動くと絵が画面から出ていく。
    動くのは右の一覧だけ。`min-h-0` が要る — 付けないと flex の子は中身の高さで
    突っ張って、外側の `overflow` が効かない。

    **二段組にする幅は観る画面 (`/watch/<id>`) と同じ `md` (768px)。** 映像を左、
    一覧を右に置く形は同じなのに、こちらだけ 1024px からにしていた頃は、
    **同じ幅で絵の大きさが変わって**いた (縦のiPad 820px で、ライブ 772px に
    対して観る画面 436px)
-->
<div class="flex flex-col gap-4 md:h-full md:min-h-0 md:flex-row" data-testid="live">
    <div class="flex min-w-0 flex-1 flex-col md:min-h-0">
        <!-- 映像は高さのほうを上限にする。横幅いっぱいにすると縦がはみ出す -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            bind:this={frame}
            class="bg-base-300 relative aspect-video max-h-full overflow-hidden
                   {controlsShown ? '' : 'cursor-none'}"
            onpointermove={wake}
            onpointerdown={wake}
            onpointerleave={away}
            onfocusin={() => (controls.keyboard = true)}
            onfocusout={() => (controls.keyboard = false)}
        >
            <!-- svelte-ignore a11y_media_has_caption -->
            <!--
                字幕は `<track>` ではない。放送の字幕は文字ではなく**絵**として
                届くので (docs/stream.md §5.2)、下の canvas に重ねる
            -->
            <!--
                **`autoplay` と `muted` は付けない。** 鳴らし始めるのは
                `live-player` の役目で、音ありで断られたときだけ自分で黙る。
                ここで `muted` にすると、断られていないときまで無音になる
            -->
            <!--
                **備え付けの操作は出さない** (`controls` を付けない)。あれの
                再生位置は「持っている範囲」を尺として描くので、0.05秒ごとに
                中身が届くたびに右へ左へ動く。放送に終わりは無いのだから、
                位置ではなく**張り付いているかどうか**を出すのが正しい
            -->
            <!--
                **指で押したら操作列の出し入れ。** 指には時計を持たせていない
                (`controls.svelte.ts` の `LINGER`) ので、消す口がここに要る。
                マウスでは何も起きない — あちらは動かせば出て、しばらくで消える
            -->
            <!--
                **映像だけを入れ物に分ける。** データ放送は「映像はこの入れ物」と
                受け取って、BML の文書を組むときにそれを動かす。**枠そのものを
                渡すと親子が循環する** (借りている側が `appendChild ... contains
                the parent` で転ぶ)。実機で1日これを探した
            -->
            <!--
                **ここだけ class ではなく style で書く。** データ放送を出している
                間、この入れ物は BML の**閉じた影の中へ移される** — 影の中には
                表の CSS (Tailwind) が届かないので、class で書いた大きさはそこで
                消える。しかも BML の既定のスタイルは `div` に
                `width:0; height:0` を与えるので、**映像が消える**。
                じかに書いた指定は影の中でも効く
            -->
            <div bind:this={mediaBox} style="position:absolute; inset:0; width:100%; height:100%;">
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
                <video
                    bind:this={video}
                    style="width:100%; height:100%; background:#000;"
                    playsinline
                    onclick={toggle}
                    data-testid="live-video"
                ></video>
            </div>

            <!--
                **切り替えの間、前の絵を貼っておく。** 器を作り直すと `<video>` は
                何も映さなくなるので、そのままだと 1.6 秒ほど真っ黒になる。
                待ち時間そのものは削れない (電波の同期待ちと GOP の頭待ち) が、
                黒い画面を見せずに済む。

                絵は止まって見えるが、それは正しい — 実際に止まっている
            -->
            <canvas
                bind:this={still}
                class="pointer-events-none absolute inset-0 h-full w-full object-contain
                       transition-opacity duration-150
                       {player.holding ? 'opacity-100' : 'opacity-0'}"
                data-testid="live-still"
                data-holding={player.holding}
                aria-hidden="true"
            ></canvas>

            <!--
                **放送の字幕。** 文字ではなく絵で届く (放送に乗っているのは文字と
                描き方の指定で、テレビはそれを見て毎回自分で描いている)。
                サーバが libaribcaption に描かせたものを重ねるので、**録画で見る
                字幕と同じ絵**になる。

                絵は画面まるごと (1920x1080) で来るので、映像と同じ枠に敷いて
                引き伸ばすだけでよい。位置合わせはブラウザ任せ。
                **前の絵より上に置く** — 切り替え中は字幕も一緒に止まってほしい
            -->
            <canvas
                bind:this={overlay}
                class="pointer-events-none absolute inset-0 h-full w-full object-contain"
                data-testid="live-captions"
                data-on={player.captions && player.hasCaptions}
                aria-hidden="true"
            ></canvas>

            <!--
                **データ放送。** 映像はここ (`frame`) に居るとだけ伝えて、
                描くのは借りものに任せる。押されるまで 1.2MB を取りに行かない。
                **局が変わったら作り直す** — カルーセルも覚えるものも局ごと
            -->
            <DataBroadcast
                on={player.showData}
                channel={player.tuned === null
                    ? null
                    : `${player.tuned.channelType}/${player.tuned.channel}/${player.tuned.serviceId}`}
                media={mediaBox}
                listen={player.listenData}
                remote={(press) => (dataPress = press)}
                postal={data.postalCode}
            />

            {#if player.tuned !== null && player.state !== 'error'}
                <!--
                    自前の操作列。**放送の今に居るときは右端に張り付く。**
                    止めても受け取りは続くので、止めた所から見られる。

                    絵が出る前から出しておく — 出たり消えたりすると、押そうとした
                    ところで動くことになる
                -->
                <!--
                    **しばらく触らなければ消える** (`ControlBar`)。絵の上に居座る
                    ものなので、見ている間は引っ込んでいるほうがいい。止めている間と、
                    キーボードで触っている間は残す。**観る画面と同じ帯**
                -->
                <ControlBar shown={controlsShown} testid="live-controls">
                    <!--
                        **上に位置、下に押すもの。観る画面と同じ二段。**
                        ([watch/[id]/+page.svelte](../watch/%5Bid%5D/+page.svelte))

                        1行に詰めていた頃は、真ん中の帯が押すものに挟まれて短く、
                        字幕や音声のあるなしで**その長さが番組ごとに変わって**いた。
                        観る画面と並びも違っていて、画面を移ると押す場所を探し直す
                        ことになる。

                        戻れる範囲の中のどこに居るか。押すとその時刻へ移る。
                        **放送の今に居る間は右端に張り付かせる** — 実際には
                        貯めているぶん (0.5秒ほど) 後ろに居るが、そこを描くと
                        溜まりが増えるたびに摘みが左へ動く。見ている人には
                        「勝手に戻っている」としか映らない
                    -->
                    <input
                        type="range"
                        class="range range-xs range-error w-full"
                        min={player.oldest}
                        max={player.newest}
                        step="0.1"
                        value={player.live ? player.newest : player.position}
                        oninput={(event) => player.seek(Number(event.currentTarget.value))}
                        aria-label="再生位置"
                        data-testid="live-seek"
                    />

                    <!-- **並びは観る画面と同じ。** 再生・音・字幕が左から順で、全画面が右端 -->
                    <div class="mt-1 flex flex-wrap items-center gap-1 text-white">
                        <ControlButton
                            path={player.paused ? PLAY : PAUSE}
                            label={player.paused ? '再生' : '一時停止'}
                            testid="live-play"
                            onclick={() => player.toggle()}
                        />
                        <ControlButton
                            path={player.silenced ? SOUND_OFF : SOUND_ON}
                            label={player.silenced ? '音を出す' : '音を消す'}
                            testid="live-sound"
                            onclick={() => (player.silenced ? player.unmute() : player.mute())}
                        />

                        <!--
                        **字幕の出し入れ。字幕を持っている番組でだけ出す。**

                        字幕の無い番組で押せる形にしておくと、押しても何も起きない
                        操作が並ぶ。テレビの字幕ボタンと同じで、出しているかどうかは
                        色で分かるようにする。

                        **1枚も届いていなくても出す** — 持っているかどうかは
                        ffmpeg の入口の見出しで分かる (`server/captions.ts` の
                        `TrackList`)。届いてから出していた頃は、間隔の空く番組で
                        ボタンが出なかった
                    -->
                        {#if player.hasCaptions}
                            <ControlButton
                                path={CAPTION}
                                label={player.captions ? '字幕を消す' : '字幕を出す'}
                                on={player.captions}
                                testid="live-caption"
                                onclick={() => player.toggleCaptions()}
                            />
                        {/if}

                        <!--
                        **データ放送 (テレビの d ボタン)。**

                        字幕と違って「持っているか」を先には出さない。サーバは
                        頼まれてから解く作りなので (`server/databroadcast.ts`)、
                        押されるまでは載っているかどうかも分からない。押しても
                        何も出ない局はあるが、**テレビの d ボタンと同じ**
                    -->
                        <ControlButton
                            path={DATA}
                            label={player.showData ? 'データ放送を消す' : 'データ放送を出す'}
                            on={player.showData}
                            testid="live-data-button"
                            onclick={() => player.setData(!player.showData)}
                        />

                        <!--
                        **字幕の選び直し。言語が2つ以上あるときだけ出す。**

                        音声と同じで**焼き直しになる** — 字幕は映像と同じ ffmpeg が
                        焼いているので (`server/live.ts` の `key`)。動くのは言語が
                        複数ある放送だけなので、起こし直すのは年に数回のこと
                    -->
                        {#if player.captions && player.captionTracks.length > 1}
                            <div class="dropdown dropdown-top">
                                <button type="button"
                                    class="{OVERLAY_BTN} {OVERLAY}"
                                    aria-label="字幕を選ぶ"
                                    data-testid="live-caption-track"
                                >
                                    <span class="max-w-28 truncate">
                                        {player.captionTracks.find((t) => t.index === player.captionTrack)
                                            ?.label ?? '字幕'}
                                    </span>
                                </button>
                                <ul
                                    class="dropdown-content menu bg-base-100 text-base-content rounded-box
                                       z-10 mb-1 w-52 p-2 shadow-lg"
                                    data-testid="live-caption-menu"
                                >
                                    {#each player.captionTracks as track (track.index)}
                                        <li>
                                            <button type="button"
                                                class={track.index === player.captionTrack
                                                    ? 'menu-active'
                                                    : ''}
                                                onclick={(event) => {
                                                    player.setCaptionTrack(track.index);
                                                    event.currentTarget.blur();
                                                }}
                                                data-testid="live-caption-option"
                                                data-track={track.index}
                                                aria-current={track.index === player.captionTrack
                                                    ? 'true'
                                                    : undefined}
                                            >
                                                {track.label}
                                            </button>
                                        </li>
                                    {/each}
                                </ul>
                            </div>
                        {/if}

                        <!--
                        **焼き方の切り替え。**

                        絵の中身ではなく「その端末で出るかどうか」の話なので、
                        音声とは別に並べる。AV1 は実時間に間に合う (`server/live.ts`)
                        が、**出ないブラウザもある** — 受け取れなければ H.264 に
                        戻して、戻した理由を出す (`live-player.svelte.ts` の `start`)。

                        押すと焼き直しになるので絵が一瞬止まるが、チャンネルは
                        変わらないので前の絵を貼ったまま差し替わる
                    -->
                        <div class="dropdown dropdown-top">
                            <button type="button"
                                class="{OVERLAY_BTN} gap-1.5 {OVERLAY}"
                                aria-label="焼き方を選ぶ"
                                data-testid="live-codec"
                            >
                                <span class="text-xs font-semibold">
                                    {LIVE_CODECS.find((c) => c.id === player.codec)?.label ?? 'H.264'}
                                </span>
                            </button>
                            <ul
                                class="dropdown-content menu bg-base-100 text-base-content rounded-box
                                   z-10 mb-1 w-56 p-2 shadow-lg"
                                data-testid="live-codec-menu"
                            >
                                {#each LIVE_CODECS as choice (choice.id)}
                                    <li>
                                        <button type="button"
                                            class={choice.id === player.codec ? 'menu-active' : ''}
                                            onclick={(event) => {
                                                player.setCodec(choice.id);
                                                // 選んだら閉じる。開きっぱなしだと絵を覆う
                                                event.currentTarget.blur();
                                            }}
                                            data-testid="live-codec-option"
                                            data-codec={choice.id}
                                            aria-current={choice.id === player.codec ? 'true' : undefined}
                                        >
                                            <span class="flex flex-col items-start">
                                                <span>{choice.label}</span>
                                                <span class="text-base-content/60 text-xs">{choice.note}</span
                                                >
                                            </span>
                                        </button>
                                    </li>
                                {/each}
                            </ul>
                        </div>

                        <!--
                        **音声の選び直し。選べるものが2つ以上あるときだけ出す。**

                        二カ国語 (1本の中に主/副が左右で入っている) と、音声が
                        2本以上入っているものの両方がここに平らに並ぶ — 見ている
                        人にとってはどちらも「音声を選ぶ」1つの操作でしかない。

                        押すと焼き直しになるので絵が一瞬止まるが、チャンネルは
                        変わらないので前の絵を貼ったまま差し替わる
                    -->
                        {#if player.audios.length > 1}
                            <div class="dropdown dropdown-top">
                                <button type="button"
                                    class="{OVERLAY_BTN} gap-1.5 {OVERLAY}"
                                    aria-label="音声を選ぶ"
                                    data-testid="live-audio"
                                >
                                    <Icon path={AUDIO} />
                                    <span class="hidden max-w-28 truncate sm:inline">
                                        {player.audios.find((a) => a.id === player.audio)?.label ?? '音声'}
                                    </span>
                                </button>
                                <ul
                                    class="dropdown-content menu bg-base-100 text-base-content rounded-box
                                       z-10 mb-1 w-52 p-2 shadow-lg"
                                    data-testid="live-audio-menu"
                                >
                                    {#each player.audios as track (track.id)}
                                        <li>
                                            <button type="button"
                                                class={track.id === player.audio ? 'menu-active' : ''}
                                                onclick={(event) => {
                                                    player.setAudio(track.id);
                                                    // 選んだら閉じる。開きっぱなしだと絵を覆う
                                                    event.currentTarget.blur();
                                                }}
                                                data-testid="live-audio-option"
                                                data-audio={track.id}
                                                aria-current={track.id === player.audio ? 'true' : undefined}
                                            >
                                                {track.label}
                                            </button>
                                        </li>
                                    {/each}
                                </ul>
                            </div>
                        {/if}

                        <!-- 放送の今に居るかどうか。離れていれば押して戻れる -->
                        <button type="button"
                            class="{OVERLAY_BTN} gap-1.5 {player.live
                                ? 'border-0 shadow-none btn-error'
                                : OVERLAY}"
                            onclick={() => player.goLive()}
                            data-testid="live-edge"
                        >
                            <span
                                class="inline-block size-2 rounded-full {player.live
                                    ? 'bg-error-content'
                                    : 'bg-error'}"
                            ></span>
                            ライブ
                        </button>

                        <!-- **読みものはここに二段で。** 決まりは [ControlBar.svelte](../../lib/components/player/ControlBar.svelte) -->
                        <div class="min-w-0 grow basis-0 px-2 leading-tight text-white/80">
                            <div class="flex items-baseline overflow-hidden text-sm whitespace-nowrap">
                                {#if current}
                                    <span class="shrink-0">
                                        {#if current.now}
                                            {time(current.now.startAt)} 〜 {time(current.now.endAt)} ・
                                        {/if}
                                        {current.name}
                                    </span>
                                    {#if current.now}
                                        <span class="min-w-0 truncate">
                                            &nbsp;・ <span data-testid="live-title">{current.now.name}</span>
                                        </span>
                                    {/if}
                                {/if}
                            </div>

                            <div class="truncate text-xs tabular-nums text-white/60">
                                <!--
                                    **放送からどれだけ遅れているか。** 詰めていく作業を
                                    するのに、見えないと当てずっぽうになる
                                -->
                                {#if player.delay !== null}
                                    <span data-testid="live-delay">遅延 {player.delay.toFixed(1)}秒</span>
                                {/if}
                                <!--
                                    **測り直す口。覚えているものがあるときだけ出す。**

                                    経路が変わると前の値のままになる (`relearn`)。
                                    **遅延のすぐ隣に置く** — この行は入りきらな
                                    ければ後ろから切れるので、遅延の話だと分かる
                                    位置であると同時に、消えにくい位置でもある。

                                    押すものだが、丸いボタンにはしない。読みものの
                                    行に 48px を置くと帯が厚くなる
                                    ([ControlBar.svelte](../../lib/components/player/ControlBar.svelte))
                                -->
                                {#if player.remembered > FLOOR}
                                    <button type="button"
                                        class="underline decoration-dotted underline-offset-2 hover:text-white"
                                        onclick={() => player.relearn()}
                                        data-testid="live-relearn">覚え直す</button
                                    >
                                {/if}
                                <!--
                                    **詰まった回数。止まったときだけ出る。**

                                    出しておく理由は `live-player.svelte.ts` の
                                    `stalls` に書いてある (実測は stream.md §4)
                                -->
                                {#if player.stalls > 0}
                                    ・ <span data-testid="live-stalls">途切れ {player.stalls}回</span>
                                {/if}
                                <!--
                                    **描かれずに捨てられたコマ。** 「音と字幕は
                                    合っているのに絵だけ遅れる」ときに要る —
                                    遅延の数字は再生位置で測るので、絵が何コマ
                                    遅れて出ていても変わらない (`live-player` の
                                    `dropped`)
                                -->
                                {#if player.dropped > 0}
                                    ・ <span data-testid="live-dropped">コマ落ち {player.dropped}</span>
                                {/if}
                                <!--
                                    **絵だけの遅れ。** 音と字幕は再生位置に
                                    乗っているので、ここが開くと口が合わなくなる。
                                    開いたままにはせず跳び直す (`unslip`) ので、
                                    出るのは直した回数のほう
                                -->
                                {#if player.slips > 0}
                                    ・ <span data-testid="live-slips">絵の直し {player.slips}回</span>
                                {/if}
                            </div>
                        </div>

                        <!--
                        **追っかけ中の速さ。追っかけている間だけ出す。**

                        ライブに張り付いているときは速められない (放送より先は
                        無い)。追いついたら自分でライブに戻るので、そのとき
                        この選択肢も消える
                    -->
                        {#if player.chasing}
                            <div class="dropdown dropdown-top dropdown-end">
                                <button type="button"
                                    class="{OVERLAY_BTN} tabular-nums {OVERLAY}"
                                    aria-label="追っかけの速さ"
                                    data-testid="live-speed"
                                >
                                    {player.speed}×
                                </button>
                                <ul
                                    class="dropdown-content menu bg-base-100 text-base-content rounded-box
                                       z-10 mb-1 w-28 p-2 shadow-lg"
                                    data-testid="live-speed-menu"
                                >
                                    {#each SPEEDS as value (value)}
                                        <li>
                                            <button type="button"
                                                class="tabular-nums {value === player.speed
                                                    ? 'menu-active'
                                                    : ''}"
                                                onclick={(event) => {
                                                    player.setSpeed(value);
                                                    event.currentTarget.blur();
                                                }}
                                                data-testid="live-speed-option"
                                                data-speed={value}
                                                aria-current={value === player.speed ? 'true' : undefined}
                                            >
                                                {value}×
                                            </button>
                                        </li>
                                    {/each}
                                </ul>
                            </div>
                        {/if}

                        <ControlButton
                            path={fullscreened ? SHRINK : EXPAND}
                            label={fullscreened ? '全画面をやめる' : '全画面'}
                            testid="live-full"
                            onclick={() => full()}
                        />
                    </div>
                </ControlBar>
            {/if}

            {#if player.silenced && player.state === 'playing'}
                <!--
                    **押されるまで音は出せない。** 前回のチャンネルで勝手に
                    始める作りなので、開いた直後は「押した」ことになっておらず、
                    ブラウザが音ありの再生を断る。押せる場所を出す
                -->
                <button type="button"
                    class="btn btn-sm btn-neutral absolute top-3 left-3 gap-2"
                    onclick={() => player.unmute()}
                    data-testid="live-unmute"
                >
                    音を出す
                </button>
            {/if}

            <!--
                **頼まれたとおりにできなかったときの断り書き。**

                失敗ではないので、絵は出ている。いまのところ「AV1 を出せない端末
                なので H.264 に戻した」の1つだけ。黙って別の形にすると、なぜ
                切り替えが効かないのか分からない
            -->
            {#if player.warning}
                <div
                    class="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-2"
                    data-testid="live-warning"
                >
                    <span class="rounded-box bg-black/60 px-3 py-1 text-xs text-white">
                        {player.warning}
                    </span>
                </div>
            {/if}

            {#if player.state !== 'playing'}
                <!--
                    何も出ていない間に何が起きているかを出す。黒いままだと壊れて見える。

                    **前の絵を貼っている間は塗り潰さない。** 覆ってしまうと、
                    貼っている意味が無くなる (実機で撮ると、前の絵が白くかすんだ
                    だけの画面になっていた)。回っているものだけを、どんな絵の上でも
                    見えるように小さく敷いて出す。

                    **押せる邪魔をしない** (`pointer-events-none`)。箱いっぱいに
                    広がるので、そのままだと下の操作列を覆って押せなくなる。
                    中の「やり直す」だけは押せるように戻す
                -->
                <div
                    class="pointer-events-none absolute inset-0 flex items-center justify-center
                           {player.holding ? '' : 'bg-base-300/80'}"
                    data-testid="live-status"
                    data-veiled={!player.holding}
                >
                    {#if player.state === 'connecting'}
                        <!--
                            **敷くのは外側。** daisyUI の `loading` は自分の
                            `background-color` で回る絵を塗っているので、そこへ
                            `bg-*` を足すと**回っているものの色を上書きする** —
                            敷いたつもりが、見えなくなる
                        -->
                        <!--
                            **繋ぎ直しの最中は、そう言う。** サーバの入れ替え
                            (デプロイ) で切れると数十秒帰ってこないので、
                            回っているものだけだと壊れたように見える
                        -->
                        <span
                            class="flex flex-col items-center gap-2 {player.holding
                                ? 'rounded-box bg-black/45 p-3 text-white'
                                : ''}"
                        >
                            <span class="loading loading-spinner loading-lg"></span>
                            {#if player.resuming}
                                <span class="text-sm" data-testid="live-resuming">繋ぎ直しています</span>
                            {/if}
                        </span>
                    {:else if player.state === 'error'}
                        <div class="text-center">
                            <div class="text-error font-medium">{player.message}</div>
                            <button type="button"
                                class="btn pointer-events-auto btn-sm mt-3"
                                onclick={() => current && select(current)}
                                data-testid="live-retry">やり直す</button
                            >
                        </div>
                    {:else}
                        <span class="text-base-content/60">選んでください</span>
                    {/if}
                </div>
            {/if}
        </div>
    </div>

    <!--
        **右の列。** 幅は固定にして、映像側だけ伸ばす。番組表と同じ並び
        (リモコン番号順、持たない局は物理チャンネル順) にしてあるので、
        番組表で見つけた局をここでも同じ位置で探せる。

        **高さは残りぜんぶ。** `max-h-[70vh]` で切っていた頃は、画面の下に
        余白があるのに一覧のほうが先に終わっていた
    -->
    <!-- **二段組にした直後は細く** (`md:w-64`)。理由は [ControlBar.svelte](../../lib/components/player/ControlBar.svelte) -->
    <aside class="flex flex-col md:w-64 md:min-h-0 md:shrink-0 lg:w-80">
        {#if detail.current}
            <!--
                **番組の中身は、この列を入れ替えて出す。モーダルにしない** —
                絵の上に被さると観ながら読めない (観る画面と同じ考え方)。
                読んでいる間はチャンネルを選ばないので、一覧は退けてよい
            -->
            <div class="card bg-base-100 flex min-h-0 flex-1 shadow" data-testid="live-detail">
                <div class="min-h-0 flex-1 overflow-y-auto p-4">
                    <ProgramFacts program={detail.current} />
                </div>
                <!-- 押すものは巻き取られる中身の外。中身がどれだけ長くても見えている -->
                <div class="border-base-300 flex shrink-0 flex-wrap gap-2 border-t p-4">
                    <button type="button" class="btn btn-sm" onclick={() => detail.close()} data-testid="live-detail-close">
                        チャンネルへ戻る
                    </button>
                </div>
            </div>
        {:else}
            <!--
                **データ放送を出している間だけ、リモコンを一覧の上に出す。**

                番組の中身と違って**入れ替えない** — 押しながら局も変えたいし、
                リモコンを引っ込める操作を覚えることにもなる。一覧は残りの高さで
                巻き取られる (`flex-1`)
            -->
            {#if dataPress !== null}
                <Remote press={dataPress} />
            {/if}

            <!-- 番組表と同じ並び・同じ見た目。探す場所がずれないようにする -->
            <div class="join mb-2" data-testid="live-type-tabs">
                {#each types as type (type)}
                    <button type="button"
                        class="btn join-item btn-sm {shown === type ? 'btn-active' : ''}"
                        onclick={() => (picked = type)}
                        data-testid="live-type-{type}"
                    >
                        {TYPE_LABEL[type]}
                    </button>
                {/each}
            </div>
            <!--
            **押せると分かる形にする。** 平らに並べていた頃は、文字が並んでいる
            だけに見えて押せると気付けなかった。枠を持たせ、指を乗せると浮かせ、
            いま映しているものは色で塗る
        -->
            <ul
                bind:this={list}
                class="flex-1 space-y-1 overflow-y-auto md:min-h-0"
                data-testid="live-channels"
            >
                {#each listed as channel (channel.id)}
                    <!-- いま映しているものかどうかは、この行の中で5回使う -->
                    {@const tuned = current?.id === channel.id}
                    <li class="flex items-stretch gap-1">
                        <button type="button"
                            bind:this={rows[channel.id]}
                            class="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg border p-2
                               text-left transition-colors
                               {tuned
                                ? 'border-primary bg-primary/15 ring-primary/40 ring-1'
                                : 'border-base-300 hover:border-base-content/30 hover:bg-base-200'}"
                            onclick={() => select(channel)}
                            aria-current={tuned ? 'true' : undefined}
                            data-testid="live-channel"
                            data-current={tuned ? 'true' : 'false'}
                            data-channel="{channel.type}/{channel.channel}"
                            data-service={channel.id}
                        >
                            <!--
                            **テレビに出ている番号を添える。** 地上波はリモコン番号、
                            BS/CS は3桁番号 (BS朝日1=151)。局名だけだと、テレビで
                            覚えている番号から探せない
                        -->
                            <span
                                class="text-base-content/50 w-7 shrink-0 text-right font-mono text-xs
                                   tabular-nums"
                                data-testid="live-number"
                            >
                                {channel.number ?? ''}
                            </span>
                            {#if channel.hasLogo}
                                <img
                                    src="/api/services/{channel.id}/logo"
                                    alt=""
                                    class="size-8 shrink-0 rounded object-contain"
                                />
                            {:else}
                                <span
                                    class="bg-base-300 flex size-8 shrink-0 items-center justify-center rounded text-xs"
                                >
                                    {channel.type}
                                </span>
                            {/if}
                            <span class="min-w-0 flex-1">
                                <span
                                    class="block truncate text-sm font-medium
                                       {tuned ? 'text-primary' : ''}"
                                >
                                    {channel.name}
                                </span>
                                {#if channel.now}
                                    <span class="text-base-content/60 block truncate text-xs">
                                        {channel.now.name}
                                    </span>
                                {/if}
                            </span>
                            <!-- いま映しているもの。色だけだと、色の見え方が違う人に伝わらない -->
                            {#if tuned}
                                <span class="badge badge-primary badge-sm shrink-0">視聴中</span>
                            {/if}
                        </button>

                        <!--
                        **中身を読む口は行と別に置く。** 行そのものは選局
                        (テレビと同じで、押したら映るのがいちばん多い用) なので、
                        あらすじや出演者を見たいだけのときにチャンネルが変わっては困る。
                        番組の分からない局 (番組表がまだ薄い) には出さない
                    -->
                        {#if channel.now}
                            <button type="button"
                                class="btn btn-sm btn-ghost h-auto shrink-0 self-stretch"
                                onclick={() => openDetail(channel)}
                                aria-label="{channel.now.name} の詳細"
                                data-testid="live-channel-detail"
                            >
                                <Icon path={INFO} size="size-5" />
                            </button>
                        {/if}
                    </li>
                {/each}
            </ul>
        {/if}
    </aside>
</div>
