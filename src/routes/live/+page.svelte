<script lang="ts">
    import { onMount } from 'svelte';
    import { submitting } from '$lib/actions';
    import ProgramFacts from '$lib/components/ProgramFacts.svelte';
    import AudioMenu from '$lib/components/player/AudioMenu.svelte';
    import { screenAwake } from '$lib/components/player/awake.svelte';
    import CodecMenu from '$lib/components/player/CodecMenu.svelte';
    import ControlBar from '$lib/components/player/ControlBar.svelte';
    import ControlButton from '$lib/components/player/ControlButton.svelte';
    import { centerTap } from '$lib/components/player/center-tap';
    import { playerControls } from '$lib/components/player/controls.svelte';
    import DataBroadcast from '$lib/components/player/DataBroadcast.svelte';
    import EdgeButton from '$lib/components/player/EdgeButton.svelte';
    import Icon from '$lib/components/player/Icon.svelte';
    import {
        CAMERA,
        CAPTION,
        DATA,
        EXPAND,
        INFO,
        OPEN_OUT,
        OVERLAY,
        PAUSE,
        PLAY,
        RECORD,
        SHRINK,
        SOUND_OFF,
        SOUND_ON,
    } from '$lib/components/player/icons';
    import MediaStack from '$lib/components/player/MediaStack.svelte';
    import OverlayMenu from '$lib/components/player/OverlayMenu.svelte';
    import PlayerStage from '$lib/components/player/PlayerStage.svelte';
    import PlayerVeil from '$lib/components/player/PlayerVeil.svelte';
    import Remote from '$lib/components/player/Remote.svelte';
    import SpeedMenu from '$lib/components/player/SpeedMenu.svelte';
    import StageNote from '$lib/components/player/StageNote.svelte';
    import { snapshotter } from '$lib/components/player/shot.svelte';
    import Toasts, { errorNotice, type Notice } from '$lib/components/Toasts.svelte';
    import { programDetail } from '$lib/detail.svelte';
    import { SERVICE_TYPE_LABEL, time } from '$lib/format';
    import { livePlayer } from '$lib/live-player.svelte';
    import { FLOOR } from '$lib/ts/pacing';
    import type { LiveChannel } from './+page.server';

    let { data, form } = $props();
    // 局が入れ替わると読み込み直されるので、値ではなく参照で持つ
    const channels = $derived(data.channels as LiveChannel[]);

    const player = livePlayer();
    /** 映像と重ねもの (MediaStack が組む)。bind で受けるので開くまでは null */
    let video = $state<HTMLVideoElement | null>(null);
    /** 切り替えの間、前の絵を貼っておく先 (`live-player` の `freeze`) */
    let still = $state<HTMLCanvasElement | null>(null);
    /** 放送の字幕を重ねる先 (`live-player` の `paint`) */
    let overlay = $state<HTMLCanvasElement | null>(null);
    /** 映像が居る入れ物。**データ放送に「映像はここ」と伝えるのに要る** */
    let mediaBox = $state<HTMLElement | null>(null);
    /**
     * データ放送に押す口。**器ができてから預かる** (`DataBroadcast` の `remote`)。
     *
     * これが有るかどうかが、そのまま**指のリモコンを出すかどうか**になる —
     * 押しても行き先が無いリモコンは出さない
     */
    let dataPress = $state<((code: number) => void) | null>(null);

    /**
     * **サーバが決めた局で開く** (`+page.server.ts` の `start`)。
     *
     * 名指し (`?service=`) → 覚えている前回の局 → 一覧の先頭、の順で決まって
     * いる。**こちらでも同じ判断をしない** — サーバは既にその局を焼きはじめて
     * いるので (`server/live.ts` の `warm`)、判断がずれると先に焼いたものが
     * 使われないまま別の局が開く
     */
    onMount(() => {
        // 重ねるものの置き場を先に渡す。選局はこのあと (bind は mount 時点で入っている)
        if (still !== null && overlay !== null) player.attach(still, overlay);
        if (data.start !== null && video !== null) void player.tune(video, data.start);
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
        if (video === null) return;
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
    const toggle = controls.toggle;

    /** 真ん中あたりを素早く2回で再生/一時停止 (`center-tap.ts`)。1回目は操作列の出し入れ */
    const stageTap = centerTap(() => player.toggle(), toggle);

    /**
     * **いまの1コマを字幕ごと切り抜く。観る画面 (`/watch/<id>`) と同じやり方。**
     *
     * 映像に、出している字幕 (`overlay`) をそのまま重ねて1枚にする。
     * クリップボードに絵を置けるのは安全な繋ぎ (https) と押した勢いが要るので、
     * 断られたら**落とすほうに倒す** — 撮ったものを取り落とさない
     */
    const shooter = snapshotter(controls);
    const notices = $derived<Notice[]>([
        ...shooter.notices,
        // 録画ボタンの結果 (`?/record`)。押した本人へ、始まったか断られたかを言う
        ...(form?.recorded
            ? [{ key: `record-${form.recorded}`, kind: 'info' as const, text: `録画を始めます: ${form.recorded}` }]
            : []),
        ...errorNotice(form, 'record-error'),
    ]);

    function snapshot(): void {
        // 字幕を出しているときだけ重ねる
        void shooter.take(
            video,
            player.captions && player.hasCaptions ? overlay : null,
            () => `${current?.now?.name ?? current?.name ?? 'ライブ'} - ${time(Date.now())}`,
        );
    }
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
        <!--
            **舞台の配線は3画面で共通** ([PlayerStage.svelte](../../lib/components/player/PlayerStage.svelte))。
            映像と重ねものの束も追っかけと共通 ([MediaStack.svelte](../../lib/components/player/MediaStack.svelte)) —
            なぜ style で書くか・なぜ入れ物を分けるかはあちらに
        -->
        <PlayerStage {controls} testid="live-frame">
            {#snippet children(stage)}
            <MediaStack
                holding={player.holding}
                captionsOn={player.captions && player.hasCaptions}
                onclick={stageTap}
                prefix="live"
                bind:video
                bind:still
                bind:overlay
                bind:box={mediaBox}
            />


            <!--
                **データ放送。** 映像はここ (`frame`) に居るとだけ伝えて、
                描くのは借りものに任せる。押されるまで 700KB を取りに行かない。
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
                network={data.bmlNetwork}
            />

            {#if player.tuned !== null && player.state !== 'error'}
                <!--
                    **右上の縦列。観る画面と同じ場所・同じ並び** (`watch-side`) —
                    d ボタンと切り抜きが画面ごとに違う場所にあると、押すたびに
                    探し直すことになる。いちばん上は録画 (観る画面では「閉じる」の位置)
                -->
                <ControlBar side shown={controlsShown} testid="live-side">
                    <!--
                        **いま観ている番組を録る。** 手動予約と同じ道 (`?/record`) に
                        乗せるだけで、数秒後にはこの番組の録画が始まる。既に録って
                        いれば二重にはならない (予約は番組ごとに1本)
                    -->
                    <form method="POST" action="?/record" use:submitting>
                        <input type="hidden" name="service" value={player.tuned.serviceId} />
                        <ControlButton path={RECORD} label="いまの番組を録画する" submit testid="live-record" />
                    </form>
                    <ControlButton
                        path={DATA}
                        label={player.showData ? 'データ放送を消す' : 'データ放送を出す'}
                        on={player.showData}
                        testid="live-data-button"
                        onclick={() => player.setData(!player.showData)}
                    />
                    <ControlButton
                        path={CAMERA}
                        label="この場面を切り抜く"
                        testid="live-shot"
                        onclick={() => void snapshot()}
                    />
                </ControlBar>

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
                    <!-- 操作の色は3画面同一 (`range-primary`)。ライブ中の赤は「ライブ」ボタンが言う -->
                    <input
                        type="range"
                        class="range range-xs range-primary w-full"
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
                        データ放送 (d) と切り抜きは**右上の縦列** (`live-side`) —
                        観る画面と同じ場所に揃えてある。

                        **Hybridcast。載っている番組でだけ出す。**
                        **Hybridcast。載っている番組でだけ出す。**

                        データ放送と違って、**アプリは電波に乗っていません** —
                        電波に乗っているのは住所だけ (AIT) で、中身は放送局の
                        サーバから取ります (`ts/ait.ts`)。

                        **denpa は動かしません。別のタブで開くだけ**です。
                        動かすには受信機の API をアプリの文脈に用意する必要が
                        あり、別オリジンのページには手を入れられません。放送局の
                        サーバが認証された受信機を期待することも多いので、
                        **多くはそのままでは動きません**
                        ([stream.md](../../../docs/stream.md#58-hybridcast))。
                        できないものをできる顔で出さないために、d ボタンと同じ
                        形にはせず「外へ出ていく」印にしてあります
                    -->
                        {#if player.hybridcast.length > 0}
                            {@const app = player.hybridcast[0]}
                            <ControlButton
                                path={OPEN_OUT}
                                label="{app.name === '' ? 'Hybridcast' : app.name} を別のタブで開く"
                                testid="live-hybridcast"
                                onclick={() => window.open(app.url, '_blank', 'noopener,noreferrer')}
                            />
                        {/if}

                        <!--
                        **字幕の選び直し。言語が2つ以上あるときだけ出す。**

                        音声と同じで**焼き直しになる** — 字幕は映像と同じ ffmpeg が
                        焼いているので (`server/live.ts` の `key`)。動くのは言語が
                        複数ある放送だけなので、起こし直すのは年に数回のこと
                    -->
                        {#if player.captions && player.captionTracks.length > 1}
                            <OverlayMenu
                                testid="live-caption"
                                attrName="track"
                                items={player.captionTracks.map((t) => ({
                                    key: t.index,
                                    label: t.label,
                                    active: t.index === player.captionTrack,
                                }))}
                                onselect={(key) => player.setCaptionTrack(key)}
                            >
                                {#snippet trigger()}
                                    <ControlButton label="字幕を選ぶ" testid="live-caption-track">
                                        <span class="max-w-28 truncate">
                                            {player.captionTracks.find((t) => t.index === player.captionTrack)
                                                ?.label ?? '字幕'}
                                        </span>
                                    </ControlButton>
                                {/snippet}
                            </OverlayMenu>
                        {/if}

                        <!--
                            焼き方。AV1 は実時間に間に合う (`server/live.ts`) が、
                            **出ないブラウザもある** — 受け取れなければ H.264 に
                            戻して、戻した理由を出す (`live-player.svelte.ts` の `start`)
                        -->
                        <CodecMenu
                            testid="live-codec"
                            codec={player.codec}
                            onselect={(key) => player.setCodec(key)}
                        />

                        {#if player.audios.length > 1}
                            <AudioMenu
                                testid="live-audio"
                                items={player.audios.map((a) => ({
                                    key: a.id,
                                    label: a.label,
                                    active: a.id === player.audio,
                                }))}
                                onselect={(key) => player.setAudio(key)}
                            />
                        {/if}

                        <!--
                            放送の今に居るかどうか。離れていれば押して戻れる。
                            **文字は焼き方のボタンと同じ大きさ・幅は詰める** —
                            btn-lg のままだと帯の中でこれだけ太って見えていた
                        -->
                        <EdgeButton
                            active={player.live}
                            label="ライブ"
                            onclick={() => player.goLive()}
                            testid="live-edge"
                        />

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
                            <SpeedMenu
                                testid="live-speed"
                                label="追っかけの速さ"
                                speed={player.speed}
                                onselect={(speed) => player.setSpeed(speed)}
                            />
                        {/if}

                        <ControlButton
                            path={stage.fullscreened ? SHRINK : EXPAND}
                            label={stage.fullscreened ? '全画面をやめる' : '全画面'}
                            testid="live-full"
                            onclick={() => stage.full()}
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
                <!-- 映像の上に置くものなので、色も他の重ねボタンと同じ (OVERLAY) -->
                <button type="button"
                    class="btn btn-sm absolute top-3 left-3 gap-2 {OVERLAY}"
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
                <StageNote testid="live-warning">{player.warning}</StageNote>
            {/if}

            {#if player.state !== 'playing'}
                <!--
                    何も出ていない間に何が起きているかを出す。黒いままだと壊れて
                    見える。見た目の決まりは3画面共通 (`PlayerVeil`)。
                    **繋ぎ直しの最中は、そう言う** — サーバの入れ替え (デプロイ) で
                    切れると数十秒帰ってこないので、回っているものだけだと壊れて見える
                -->
                <PlayerVeil
                    holding={player.holding}
                    busy={player.state === 'connecting'}
                    note={player.resuming ? '繋ぎ直しています' : ''}
                    error={player.state === 'error' ? player.message : ''}
                    idle="選んでください"
                    testid="live-status"
                >
                    {#snippet actions()}
                        <button type="button"
                            class="btn btn-sm"
                            onclick={() => current && select(current)}
                            data-testid="live-retry">やり直す</button
                        >
                    {/snippet}
                </PlayerVeil>
            {/if}
            {/snippet}
        </PlayerStage>
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
                        {SERVICE_TYPE_LABEL[type]}
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

<Toasts {notices} />
