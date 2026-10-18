<script lang="ts">
    import { onMount } from 'svelte';
    import { submitting } from '#lib/actions.js';
    import type { Service } from '#lib/bml/engine.js';
    import DriveNotice from '#lib/components/DriveNotice.svelte';
    import ProgramFacts from '#lib/components/ProgramFacts.svelte';
    import AudioMenu from '#lib/components/player/AudioMenu.svelte';
    import { screenAwake } from '#lib/components/player/awake.svelte.js';
    import { backgroundPlayback } from '#lib/components/player/background.svelte.js';
    import CodecMenu from '#lib/components/player/CodecMenu.svelte';
    import ControlBar from '#lib/components/player/ControlBar.svelte';
    import ControlButton from '#lib/components/player/ControlButton.svelte';
    import ControlRow from '#lib/components/player/ControlRow.svelte';
    import { centerTap } from '#lib/components/player/center-tap.js';
    import { playerControls } from '#lib/components/player/controls.svelte.js';
    import DataBroadcast, { pressD } from '#lib/components/player/DataBroadcast.svelte';
    import EdgeButton from '#lib/components/player/EdgeButton.svelte';
    import Extras from '#lib/components/player/Extras.svelte';
    import FactsAside from '#lib/components/player/FactsAside.svelte';
    import { stageFullscreen } from '#lib/components/player/fullscreen.svelte.js';
    import Icon from '#lib/components/player/Icon.svelte';
    import InfoBlock from '#lib/components/player/InfoBlock.svelte';
    import {
        CAMERA,
        CAPTION,
        DATA,
        INFO,
        OPEN_OUT,
        OVERLAY,
        PAUSE,
        PLAY,
        RECORD,
        SOUND_OFF,
        SOUND_ON,
    } from '#lib/components/player/icons.js';
    import MediaStack from '#lib/components/player/MediaStack.svelte';
    import OverlayMenu from '#lib/components/player/OverlayMenu.svelte';
    import PlayerLayout, { PHONE_LANDSCAPE } from '#lib/components/player/PlayerLayout.svelte';
    import PlayerStage from '#lib/components/player/PlayerStage.svelte';
    import PlayerVeil from '#lib/components/player/PlayerVeil.svelte';
    import { pictureInPicture } from '#lib/components/player/pip.svelte.js';
    import Remote from '#lib/components/player/Remote.svelte';
    import SeekBar from '#lib/components/player/SeekBar.svelte';
    import SpeedMenu from '#lib/components/player/SpeedMenu.svelte';
    import StageNote from '#lib/components/player/StageNote.svelte';
    import StageTail from '#lib/components/player/StageTail.svelte';
    import { snapshotter } from '#lib/components/player/shot.svelte.js';
    import { grabbedFrame, videoFrame } from '#lib/components/player/snapshot.js';
    import ServiceLogo from '#lib/components/ServiceLogo.svelte';
    import Toasts, { errorNotice, type Notice } from '#lib/components/Toasts.svelte';
    import { programDetail } from '#lib/detail.svelte.js';
    import { driveGate } from '#lib/drive-gate.svelte.js';
    import { SERVICE_TYPE_LABEL, time } from '#lib/format.js';
    import { livePlayer } from '#lib/live-player.svelte.js';
    import { liveUpdates } from '#lib/live-updates.svelte.js';
    import { reload } from '#lib/reload.svelte.js';
    import { FLOOR } from '#lib/ts/pacing.js';
    import type { LiveChannel } from './+page.server';

    /** 番組の終わりから読み直すまで置く間 (下の「番組が替わったら読み直す」) */
    const PROGRAM_END_GRACE = 2_000;
    /**
     * 読み直しの間の下限。**端末の時計が進んでいると、終わったはずの番組がサーバではまだ
     * 流れていて**同じものが返り、すぐまた読み直すことになる。詰めて回さない
     */
    const PROGRAM_END_FLOOR = 5_000;

    let { data, form } = $props();
    // 局が入れ替わると読み込み直されるので、値ではなく参照で持つ
    const channels = $derived(data.channels as LiveChannel[]);

    /*
     * **番組が替わったら読み直す。** 局の一覧が持つ「いまの番組」は開いた時点のもので、
     * 放っておくと次の番組が始まっても操作列の番組名・時間帯・一覧の番組名が前のまま残る。
     *
     * 1. **通知** (`programs`)。観ている局は、サーバが放送の「いま・次」(EIT[p/f]) を読んで、
     *    番組表と違えば書き直して知らせてくる (`epg.followOnAir`)。延長・繰り下げはこちらで追う
     * 2. **いちばん早く終わる番組の終わり**。観ていない局の分は放送を読んでいないので、
     *    番組表の予定で替える。少し置くのは、終わった直後に読むと時計の差で同じ番組が返るから
     *
     * 読み直しても観ているものは変わらない (選局は画面が持っている)
     */
    liveUpdates(['programs', 'services']);
    $effect(() => {
        const ends = channels.flatMap((channel) => (channel.now === null ? [] : [channel.now.endAt]));
        if (ends.length === 0) return;
        const wait = Math.max(Math.min(...ends) - Date.now() + PROGRAM_END_GRACE, PROGRAM_END_FLOOR);
        // setTimeout は 2^31-1 ms (約24日) を超えると即座に鳴る
        const timer = setTimeout(reload, Math.min(wait, 2 ** 31 - 1));
        return () => clearTimeout(timer);
    });

    /**
     * **運転中の注意** (互換モード。`canvas-video.ts`)。UA の既定で互換モードに入っている端末 (テスラ) で、
     * 初めて canvas で再生する前に出す。**「わかりました」を押すまで再生を始めない** (`livePlayer` の `confirm`)
     */
    const drive = driveGate();
    const player = livePlayer({ confirm: drive.confirm });
    /** 映像と重ねもの (MediaStack が組む)。bind で受けるので開くまでは null */
    let video = $state<HTMLVideoElement | null>(null);
    /** 切り替えの間、前のフレームを貼っておく先 (`live-player` の `freeze`) */
    let still = $state<HTMLCanvasElement | null>(null);
    /** 放送の字幕を重ねる先 (`live-player` の `paint`) */
    let overlay = $state<HTMLCanvasElement | null>(null);
    /** 映像がある入れ物。**データ放送に「映像はここ」と伝えるのに要る** */
    let mediaBox = $state<HTMLElement | null>(null);
    /** リモコンのキーを渡す関数と、d を文書へ渡す関数。データ放送の部品ができてから入る (`DataBroadcast` の press / pressD)。前者が有るかどうかが、そのまま指のリモコンを出すかどうか */
    let dataPress = $state<((code: number) => void) | null>(null);
    let dataButton = $state<(() => boolean) | null>(null);

    /**
     * **サーバが決めた局で開く** (`+page.server.ts` の `start`)。
     *
     * 名指し (`?service=`) → 覚えている前回の局 → 一覧の先頭、の順で決まって
     * いる。**こちらでも同じ判断をしない** — サーバは既にその局をエンコードし始めて
     * いるので (`server/live.ts` の `warm`)、判断がずれると先にエンコードしたものが
     * 使われないまま別の局が開く
     */
    onMount(() => {
        // 重ねるものの置き場を先に渡す。選局はこのあと (bind は mount 時点で入っている)
        // 入れ物も渡す — 放送のまま見るときは、映像の代わりの canvas をここに差し込む (`raw/engine.ts`)
        if (still !== null && overlay !== null) player.attach(still, overlay, mediaBox);
        if (data.start !== null && video !== null) void player.tune(video, data.start);
        return () => player.stop();
    });

    /**
     * いま映している局。一覧で目立たせる。
     *
     * **局で引く。** 物理チャンネルで引いていた頃は、**1本に複数の局が入って
     * いると先頭の局が塗られていた** — MX2 を選んでも MX1 の行が光る。
     * エンコードしているのは選んだ局なので (`server/live.ts`)、映像と印が食い違う
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
     * **エンコード方式は引き継ぐ。** 映像の中身ではなく「その端末で出るか」の話なので、
     * 局を選び直すたびに H.264 へ戻されては選んだ意味が無い。
     *
     * **音声は引き継がない。** あちらは番組ごとに構成が変わるもので、局が変われば
     * 前の合言葉はもう指すものが無い (サーバが主音声に落とす)
     */
    function select(channel: LiveChannel): boolean {
        if (video === null) return false;
        void player.tune(video, {
            channelType: channel.type,
            channel: channel.channel,
            serviceId: channel.id,
            codec: player.codec,
        });
        return true;
    }

    /**
     * **データ放送が「この局へ」と言ってきた (epgTune)。** 一覧から局を探して、手で選んだのと同じ経路
     * (`select`) で切り替える。データ放送の部品は局が変わると作り直されるので、切り替えた先の局の
     * データ放送が出る。
     *
     * 探すのは original_network_id と service_id。service_id はネットワークの中で 1 つに決まる
     * (局の一覧は transport_stream_id を持っていない)。一覧に無い局 (取り残し・映像の無い局) なら
     * false — 文書には失敗が返り、文書が自分で案内する
     */
    function tuneFromData(service: Service): boolean {
        const found = channels.find(
            (c) => c.networkId === service.originalNetworkId && c.serviceId === service.serviceId,
        );
        // 映像がまだ無い (選局できない) なら失敗にする。文書は閉じない
        return found !== undefined && select(found);
    }

    /**
     * **横にしたスマホでは、一覧から選んだら映像へ戻す。** その形では映像が画面の高さ
     * いっぱいを取り、一覧はその下を巻き取って探す (`PlayerLayout`)。選んだのは
     * 観るためなので、一覧の位置に残すと映像が見えないまま切り替わる
     */
    function backToPicture(): void {
        if (stageEl === null || !window.matchMedia(PHONE_LANDSCAPE).matches) return;
        stageEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
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
         * そこでは映像ごと上へ送られて、開いた瞬間に映像が画面から出ていた。
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
     * 右の列に出す番組の中身。**モーダルにしない** — 映像の上に被さると
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
            description: channel.now.description ?? '',
        });
    }

    /** 操作列の出し入れ ([controls.svelte.ts](../../lib/components/player/controls.svelte.ts))。観る画面と同じ */
    const controls = playerControls();
    /** 全画面にする枠と、その出入り (3画面共通。[fullscreen.svelte.ts](../../lib/components/player/fullscreen.svelte.ts)) */
    let stageEl = $state<HTMLElement | null>(null);
    const fullscreen = stageFullscreen(() => stageEl);

    /**
     * 観ている間は画面を落とさせない ([awake.svelte.ts](../../lib/components/player/awake.svelte.ts))。
     * **止めている間も掛けたまま** (止めるのは追っかけの始まりで、画面を見ていることが多い)。
     * 何も選んでいないときと、出せずに終わったときだけ外す
     */
    const awake = screenAwake();
    $effect(() => {
        awake.on = player.state !== 'idle' && player.state !== 'error';
    });

    /**
     * バックグラウンド再生 ([background.svelte.ts](../../lib/components/player/background.svelte.ts))。
     * 既定は切で、裏に回ったら止める。**戻ったら、張り付いていたなら放送の今へ** (止めた所からではなく)
     */
    let wasLive = false;
    const background = backgroundPlayback({
        pip: () => pip.active,
        paused: () => player.paused,
        pause: () => {
            wasLive = player.live;
            player.toggle();
        },
        resume: () => {
            if (wasLive) player.goLive();
            // 戻る先がまだ無い (貯まりが空) と goLive は何もしないので、そのときは再開だけ
            if (player.paused) player.toggle();
        },
    });

    /**
     * 小窓 (PiP。[pip.svelte.ts](../../lib/components/player/pip.svelte.ts))。放送のまま見ている間は
     * worker の canvas からストリームを取って出す。**小窓で押された止める・再開は player に合わせる**
     */
    const pip = pictureInPicture({
        video: () => video,
        raw: () => player.canvas,
        capture: () => player.capture(),
        flow: (on) => player.captureFlow(on),
        paused: () => player.paused,
        toggle: () => player.toggle(),
        auto: () => background.on,
        overlay: () => overlay,
        captions: () => player.captions && player.hasCaptions,
    });
    // 生の音を「再生する音」と言うのは、入れているときと小窓を開いている間だけ (`raw/engine.ts`)
    $effect(() => {
        player.playback = background.on || pip.active;
    });

    /** 真ん中あたりを素早く2回で再生/一時停止 (`center-tap.ts`)。1回目は操作列の出し入れ */
    const stageTap = centerTap(() => player.toggle(), controls.toggle);

    /**
     * **いまの1コマを字幕ごと切り抜く。観る画面 (`/watch/<id>`) と同じやり方。**
     *
     * 映像に、出している字幕 (`overlay`) をそのまま重ねて1枚の PNG にする。
     * 渡し方 (指は共有シート、PC は落としてクリップボードにも) は3画面共通 (`snapshot.ts`)
     */
    const shooter = snapshotter(controls);
    const notices = $derived<Notice[]>([
        ...shooter.notices,
        ...pip.notices,
        // 録画ボタンの結果 (`?/record`)。押した本人へ、始まったか断られたかを言う
        ...(form?.recorded
            ? [{ key: `record-${form.recorded}`, kind: 'info' as const, text: `録画を始めます: ${form.recorded}` }]
            : []),
        ...errorNotice(form, 'record-error'),
    ]);

    function snapshot(): void {
        void shooter.take(
            () => (player.canvas ? grabbedFrame(player.grab()) : videoFrame(video)),
            // 字幕を出しているときだけ重ねる
            player.captions && player.hasCaptions ? overlay : null,
            current?.now?.name ?? current?.name ?? 'ライブ',
        );
    }
</script>

<!--
    **映像を左、局を右。** 動画を見ながら次を選べる並びで、YouTube の再生画面と
    同じ形。畳まれる幅では縦に積む (横に並べると映像が切手大になる)。

    **広い画面ではページごとスクロールさせない** (`+layout.svelte` の `fill`)。
    映像を見ながら選ぶものなので、ページが動くと映像が画面から出ていく。
    動くのは右の一覧だけ。

    外枠は観る画面・追っかけと同じ (PlayerLayout)
-->
<PlayerLayout testid="live">
        <!-- 映像は高さのほうを上限にする。横幅いっぱいにすると縦がはみ出す -->
        <!--
            **舞台の配線は3画面で共通** ([PlayerStage.svelte](../../lib/components/player/PlayerStage.svelte))。
            映像と重ねものの束も追っかけと共通 ([MediaStack.svelte](../../lib/components/player/MediaStack.svelte)) —
            なぜ style で書くか・なぜ入れ物を分けるかはあちらに
        -->
        <PlayerStage {controls} {fullscreen} testid="live-frame" bind:element={stageEl}>
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
                **データ放送。** 映像はここ (`media`) にあるとだけ伝えて、
                描くのはエンジンに任せる。押されるまでエンジンを読み込まない。
                **局が変わったら作り直す** — カルーセルも覚えるものも局ごと
            -->
            <DataBroadcast
                on={player.showData}
                channel={player.tuned === null
                    ? null
                    : `${player.tuned.channelType}/${player.tuned.channel}/${player.tuned.serviceId}`}
                media={mediaBox}
                listen={player.listenData}
                bind:press={dataPress}
                bind:pressD={dataButton}
                postal={data.postalCode}
                prefecture={data.prefecture}
                network={data.bmlNetwork}
                tune={tuneFromData}
                apps={player.hybridcast}
                serviceName={current?.name ?? ''}
                captions={player.captions}
                setCaptions={(on) => {
                    if (on !== player.captions) player.toggleCaptions();
                }}
            />

            <!--
                **出せなかった間も出しておく。** 「再生できない形式です」の
                逃げ道はエンコード方式を選び直すこと (別の形式か、MPEG-2) で、その操作はこの操作バーにしか無い。
                隠していた頃は、出せない端末では選び直す手立てが無かった
            -->
            <!-- 録画に譲って追っかけを観ている間 (`yielded`) も出す。局をリクエストするものだけ外す (下) -->
            {#if player.tuned !== null || player.yielded !== null}
                <!--
                    **右上の縦列。観る画面と同じ場所・同じ並び** (`watch-side`) —
                    d ボタンと切り抜きが画面ごとに違う場所にあると、押すたびに
                    探し直すことになる。いちばん上は録画 (観る画面では「閉じる」の位置)
                -->
                <ControlBar side shown={controls.shown} testid="live-side">
                    <!--
                        **いま観ている番組を録る。** 手動予約と同じ経路 (`?/record`) に
                        乗せるだけで、数秒後にはこの番組の録画が始まる。既に録って
                        いれば二重にはならない (予約は番組ごとに1本)。
                        録画に譲っている間は出さない (観ているのはもう録っている番組)。データ放送も局のもの
                    -->
                    {#if player.tuned !== null}
                        <form method="POST" action="?/record" use:submitting>
                            <input type="hidden" name="service" value={player.tuned.serviceId} />
                            <ControlButton icon={RECORD} label="いまの番組を録画する" submit testid="live-record" />
                        </form>
                        <ControlButton
                            icon={DATA}
                            label={player.showData ? 'データ放送を消す' : 'データ放送を出す'}
                            on={player.showData}
                            testid="live-data-button"
                            onclick={() => pressD(player.showData, dataButton, (on) => player.setData(on))}
                        />
                    {/if}
                    <!--
                        **放送のまま見ている間も切り抜ける。** 映像は worker の canvas にあるので、
                        そちらに1枚リクエストする (`snapshot.grabbedFrame`)
                    -->
                    <ControlButton
                        icon={CAMERA}
                        label="この場面を切り抜く"
                        testid="live-shot"
                        onclick={() => void snapshot()}
                    />
                </ControlBar>

                <!--
                    自前の操作列。止めても受け取りは続くので、止めた所から見られる。
                    映像が出る前から出しておく — 出たり消えたりすると、押そうとした
                    ところで動くことになる。

                    **しばらく触らなければ消える** (`ControlBar`。止めていても引っ込み、
                    残すのはキーボードで触っている間だけ)。**観る画面と同じ操作バー**
                -->
                <ControlBar shown={controls.shown} testid="live-controls">
                    <!--
                        **上に位置、下に押すもの。観る画面と同じ二段。**
                        ([watch/[id]/+page.svelte](../watch/%5Bid%5D/+page.svelte))

                        1行に詰めていた頃は、真ん中のシークバーが押すものに挟まれて短く、
                        字幕や音声のあるなしで**その長さが番組ごとに変わって**いた。
                        観る画面と並びも違っていて、画面を移ると押す場所を探し直す
                        ことになる。

                        戻れる範囲の中のどこにいるか。押すとその時刻へ移る。
                        **放送の今にいる間は右端に張り付かせる** — 実際には
                        貯めているぶん (0.5秒ほど) 後ろにいるが、そこを描くと
                        溜まりが増えるたびに摘みが左へ動く。見ている人には
                        「勝手に戻っている」としか映らない
                    -->
                    <!--
                        シークバーは3画面共通 (SeekBar)。ライブ中の赤は「ライブ」ボタンが言う。
                        **放送のまま見ている間は出さない** — 遡れるほど持っていない (止めて再開は放送の今から)。
                        録画に譲っている間も出さない (追っかけのシークバーは放送の今のシークバーと別物。戻る手段は通知の「ライブに戻る」)
                    -->
                    {#if !player.canvas && player.yielded === null}
                        <SeekBar
                            value={player.live ? player.newest : player.position}
                            min={player.oldest}
                            max={player.newest}
                            step={0.1}
                            onseek={(at) => player.seek(at)}
                            paused={player.paused}
                            testid="live-seek"
                        />
                    {/if}

                    <!-- **並びは観る画面と同じ。** 再生・音・字幕が左から順で、全画面が右端 -->
                    <ControlRow testid="live-buttons">
                        <ControlButton
                            icon={player.paused ? PLAY : PAUSE}
                            label={player.paused ? '再生' : '一時停止'}
                            testid="live-play"
                            onclick={() => player.toggle()}
                        />
                        <!--
                            **畳むとき (狭い枠・一段に入らないとき) に残すのは、再生・ライブ・読みもの・全画面だけ。**
                            ここから音声までと速さ・バックグラウンド・小窓は「ほか」(⋯) に入れる (`Extras`)。
                            音を出していないときは映像の上に「音を出す」が別に出る。
                            広い枠では包みは何もしないので、並びは今までどおり (観る画面と同じ)
                        -->
                        <Extras>
                        <ControlButton
                            icon={player.silenced ? SOUND_OFF : SOUND_ON}
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
                                icon={CAPTION}
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

                        データ放送と違って、**アプリは電波に乗っていません** —
                        電波に乗っているのは住所だけ (AIT) で、中身は放送局の
                        サーバから取ります (`ts/ait.ts`)。

                        **このボタンは別のタブで開くだけ**です (受信機の API が無いので、
                        多くはそのままでは動きません)。denpa の中で動かすのは、データ放送が
                        起動を求めたとき (`DataBroadcast` の `HybridcastFrame`)。
                        受信機の API は用意できる範囲だけで、認証された受信機を期待する
                        アプリは動きません
                        ([stream.md](../../../docs/stream.md#hybridcast))。
                        できないものをできる顔で出さないために、d ボタンと同じ
                        形にはせず「外へ出ていく」印にしてあります
                    -->
                        {#if player.hybridcast[0] !== undefined}
                            {@const app = player.hybridcast[0]}
                            <ControlButton
                                icon={OPEN_OUT}
                                label="{app.name === '' ? 'Hybridcast' : app.name} を別のタブで開く"
                                testid="live-hybridcast"
                                onclick={() => window.open(app.url, '_blank', 'noopener,noreferrer')}
                            />
                        {/if}

                        <!--
                        **字幕の選び直し。言語が2つ以上あるときだけ出す。**

                        音声と同じで**再エンコードになる** — 字幕は映像と同じ ffmpeg が
                        エンコードしているので (`server/live.ts` の `key`)。動くのは言語が
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
                                {#snippet trigger(menu)}
                                    <ControlButton {menu} label="字幕を選ぶ" testid="live-caption-track">
                                        <span class="track-label">
                                            {player.captionTracks.find((t) => t.index === player.captionTrack)
                                                ?.label ?? '字幕'}
                                        </span>
                                    </ControlButton>
                                {/snippet}
                            </OverlayMenu>
                        {/if}

                        <!--
                            エンコード方式。AV1 は実時間に間に合う (`server/live.ts`) が、
                            **出ないブラウザもある** — 受け取れなければ H.264 に
                            戻して、戻した理由を出す (`live-player.svelte.ts` の `start`)
                        -->
                        <!-- 末尾の MPEG-2 はエンコードせずに放送そのままをデコードする経路 (エンコードしたものに戻るときは断り書きが理由を言う) -->
                        <CodecMenu
                            testid="live-codec"
                            codec={player.codec}
                            raw={player.raw}
                            unavailable={player.unavailable}
                            onselect={(key) => player.setCodec(key)}
                            onraw={() => player.setRaw()}
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
                        </Extras>

                        <!--
                            放送の今にいるかどうか。離れていれば押して戻れる。
                            **文字はエンコード方式のボタンと同じ大きさ・幅は詰める** —
                            大きいボタンのままだと操作バーの中でこれだけ太って見えていた
                        -->
                        {#if player.yielded === null}
                            <EdgeButton
                                active={player.live}
                                label="ライブ"
                                onclick={() => player.goLive()}
                                testid="live-edge"
                            />
                        {/if}

                        <!--
                            **読みものは3画面共通の二段** (InfoBlock)。決まりは [ControlBar.svelte](../../lib/components/player/ControlBar.svelte)。
                            録画に譲っている間は、観ている録画 (局も番組も、ライブで選んでいたものとは別)
                        -->
                        <InfoBlock
                            range={player.yielded === null && current?.now
                                ? { start: current.now.startAt, end: current.now.endAt }
                                : null}
                            service={player.yielded?.recording.serviceName ?? current?.name ?? ''}
                            title={player.yielded?.recording.title ?? current?.now?.name ?? null}
                            titleTestid="live-title"
                            rangeTestid="live-range"
                        >
                            {#snippet status()}
                                <!--
                                    **放送からどれだけ遅れているか** (`live-player` の `fromAir`)。
                                    隣に置いたテレビとの差なので、エンコードの遅れ・回線・貯まりが
                                    全部入っている。**出るまでは**下の「貯まり」だけになる
                                -->
                                {#if player.fromAir !== null}
                                    <span>放送から {player.fromAir.toFixed(1)}秒</span>
                                {/if}
                                <!--
                                    **こちらは手元の貯まりの差** (`buffered.end - currentTime`)。
                                    「あと何秒ぶん持っているか」で、上流は入っていない。
                                    詰めていく作業をするのに、見えないと当てずっぽうになる
                                -->
                                {#if player.delay !== null}
                                    <span
                                        >{player.fromAir === null ? '遅延' : '・バッファ'}
                                        {player.delay.toFixed(1)}秒</span
                                    >
                                {/if}
                                <!--
                                    **測り直す操作。覚えているものがあるときだけ出す。**

                                    経路が変わると前の値のままになる (`relearn`)。
                                    **遅延のすぐ隣に置く** — この行は入りきらな
                                    ければ後ろから切れるので、遅延の話だと分かる
                                    位置であると同時に、消えにくい位置でもある。

                                    押すものだが、丸いボタンにはしない。読みものの
                                    行に 48px を置くと操作バーが厚くなる
                                    ([ControlBar.svelte](../../lib/components/player/ControlBar.svelte))
                                -->
                                {#if player.remembered > FLOOR}
                                    <button type="button"
                                        class="relearn"
                                        onclick={() => player.relearn()}
                                        data-testid="live-relearn">測り直す</button
                                    >
                                {/if}
                                <!--
                                    **詰まった回数。止まったときだけ出る。**

                                    出しておく理由は `live-player.svelte.ts` の
                                    `stalls` に書いてある (実測は stream.md#一瞬止まって遅延が増えていく)
                                -->
                                {#if player.stalls > 0}
                                    ・ <span>途切れ {player.stalls}回</span>
                                {/if}
                                <!--
                                    **描かれずに捨てられたコマ。** 「音と字幕は
                                    合っているのに映像だけ遅れる」ときに要る —
                                    遅延の数字は再生位置で測るので、映像が何コマ
                                    遅れて出ていても変わらない (`live-player` の
                                    `dropped`)
                                -->
                                {#if player.dropped > 0}
                                    ・ <span>コマ落ち {player.dropped}</span>
                                {/if}
                                <!--
                                    **映像だけの遅れ。** 音と字幕は再生位置に
                                    乗っているので、ここが開くと映像と音がずれる。
                                    開いたままにはせず飛び直す (`unslip`) ので、
                                    出るのは直した回数のほう
                                -->
                                {#if player.slipMost > 0}
                                    ・ <span
                                        >映像の遅れ 最大 {Math.round(player.slipMost * 1000)}ms</span
                                    >
                                {/if}
                                {#if player.slips > 0}
                                    ・ <span>映像の遅れを補正 {player.slips}回</span>
                                {/if}
                                <!--
                                    **MPEG-2 を1コマデコードするのに掛かっている時間。** 1コマ (33ms) の 8 割を
                                    5 秒超え続けたらエンコードしたものに戻る (`raw/budget.ts`)。
                                    戻る前に余裕がどれだけあるかを読むため
                                -->
                                {#if player.canvas && player.decodeMs > 0}
                                    ・ <span>デコード {player.decodeMs.toFixed(1)}ms</span>
                                {/if}
                            {/snippet}
                        </InfoBlock>

                        <!--
                        **追っかけ中の速さ。追っかけている間だけ出す。**

                        ライブに張り付いているときは速められない (放送より先は
                        無い)。追いついたら自分でライブに戻るので、そのとき
                        この選択肢も消える
                    -->
                        {#if player.chasing}
                            <Extras>
                                <SpeedMenu
                                    testid="live-speed"
                                    label="追っかけの速さ"
                                    speed={player.speed}
                                    onselect={(speed) => player.setSpeed(speed)}
                                />
                            </Extras>
                        {/if}

                        <StageTail prefix="live" {background} {pip} {fullscreen} {stage} />
                    </ControlRow>
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
                    class="small unmute {OVERLAY}"
                    onclick={() => player.unmute()}
                >
                    音を出す
                </button>
            {/if}

            {#if player.state !== 'playing'}
                <!--
                    何も出ていない間に何が起きているかを出す。黒いままだと壊れて
                    見える。見た目の決まりは追っかけと共通 (`PlayerVeil`)。
                    **繋ぎ直しの最中は、そう言う** — サーバの入れ替え (デプロイ) で
                    切れると数十秒帰ってこないので、回っているものだけだと壊れて見える
                -->
                <PlayerVeil
                    holding={player.holding}
                    busy={player.state === 'connecting'}
                    note={player.resuming ? '繋ぎ直しています' : ''}
                    error={player.state === 'error' ? player.message : ''}
                    idle="局を選んでください"
                    testid="live-status"
                >
                    {#snippet actions()}
                        <!-- 録画に譲っている間のやり直しは「ライブに戻る」と同じ (入れなければ追っかけに戻る) -->
                        <button type="button"
                            class="small secondary"
                            onclick={() => (player.yielded !== null ? player.backToLive() : current && select(current))}
                            data-testid="live-retry">やり直す</button
                        >
                    {/snippet}
                </PlayerVeil>
            {/if}
            {/snippet}

            <!-- 映像の上の通知は舞台の列に積む (`PlayerStage` の `notes`)。幕 (`PlayerVeil`) の文言は真ん中なので重ならない -->
            {#snippet notes()}
                <!--
                    **録画に譲った。** ライブのチューナーを録画に取り上げられ、リクエストし直しても入れなかったので、
                    チューナーを取り上げた録画の追っかけを観ている (`live-player` の `giveWay`)。テレビのアプリも同じ言い方。
                    StageNote は押せない表示なので、「ライブに戻る」を置くこの通知だけ押せる形で並べる
                    (見た目は同じ角丸の黒いラベル。追っかけの「観る画面で」と同じ扱い)
                -->
                {#if player.yielded}
                    {@const yielded = player.yielded}
                    <span class="yielded" data-testid="live-yielded">
                        <span class="yielded-text">
                            録画のため局を切り替えました: <span class="broadcast">{yielded.recording.title}</span>
                            (録画中を再生しています)
                        </span>
                        <button type="button"
                            class="back-live"
                            disabled={player.returning}
                            onclick={() => player.backToLive()}
                            data-testid="live-back">ライブに戻る</button
                        >
                    </span>
                    {#if yielded.refused}
                        <StageNote testid="live-refused"
                            >録画が終わるまでライブは見られません ({time(yielded.recording.endAt)})</StageNote
                        >
                    {/if}
                {/if}
                <!--
                    **指定されたとおりにできなかったときの断り書き。**

                    失敗ではないので、映像は出ている。「AV1 を出せない端末なので H.264 に
                    戻した」と「GPU でエンコードできずにソフトウェアでエンコードしている」(サーバから)。
                    黙って別の形式にすると、なぜ切り替えが効かないのか分からない
                -->
                {#if player.warning}
                    <StageNote testid="live-warning">{player.warning}</StageNote>
                {/if}
            {/snippet}
        </PlayerStage>

    <!--
        **右の列。** 幅は固定にして、映像側だけ伸ばす。番組表と同じ並び
        (リモコン番号順、持たない局は物理チャンネル順) にしてあるので、
        番組表で見つけた局をここでも同じ位置で探せる。

        **高さは残りぜんぶ。** 高さを 70vh で切っていた頃は、画面の下に
        余白があるのに一覧のほうが先に終わっていた
    -->
    {#snippet aside()}
    {#if detail.current}
        <!--
            **番組の中身は、この列を入れ替えて出す。モーダルにしない** —
            映像の上に被さると観ながら読めない (観る画面と同じ考え方)。
            読んでいる間はチャンネルを選ばないので、一覧は退けてよい。
            枠は3画面共通 (FactsAside)
        -->
        <FactsAside testid="live-detail">
            <ProgramFacts program={detail.current} />
            {#snippet footer()}
                <button type="button" class="small secondary" onclick={() => detail.close()} data-testid="live-detail-close">
                    局の一覧へ戻る
                </button>
            {/snippet}
        </FactsAside>
    {:else}
        <!-- 幅と高さ・サイドバーの形は FactsAside と同じ (PlayerLayout が持つ。一覧は中身が違うので列だけ揃える) -->
        <aside class="live-side">
            <!--
                **データ放送を出している間だけ、リモコンを一覧の上に出す。**

                番組の中身と違って**入れ替えない** — 押しながら局も変えたいし、
                リモコンを引っ込める操作を覚えることにもなる。一覧は残りの高さで
                巻き取られる (`.channels` の `flex: 1`)
            -->
            {#if dataPress !== null}
                <Remote press={dataPress} />
            {/if}

            <!-- 番組表と同じ並び・同じ見た目。探す場所がずれないようにする -->
            <div role="group" class="type-tabs segmented">
                {#each types as type (type)}
                    <!-- いま出している種別は aria-pressed で言う (色だけにしない) -->
                    <button type="button"
                        class="small {shown === type ? '' : 'secondary outline'}"
                        aria-pressed={shown === type}
                        onclick={() => (picked = type)}
                        data-testid="live-type-{type}"
                    >
                        {SERVICE_TYPE_LABEL[type]}
                    </button>
                {/each}
            </div>
            <!--
                **枠の無い行を並べる** (アプリのサイドバーの一覧と同じ形)。一行ずつ枠を付けた
                カードにしていた頃は、枠と行の間の余白が幅を取り、局名と番組名が先に潰れた。
                押せることは、指を乗せたときの淡い地と、いま映している行の地で分かる
            -->
            <ul bind:this={list} class="channels" data-testid="live-channels">
                {#each listed as channel (channel.id)}
                    <!-- いま映しているものかどうかは、この行の中で何度も使う -->
                    {@const tuned = current?.id === channel.id}
                    <li class="channel-item" class:tuned>
                        <button type="button"
                            bind:this={rows[channel.id]}
                            class="channel"
                            class:tuned
                            onclick={() => {
                                select(channel);
                                backToPicture();
                            }}
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
                            <!-- ラベルの形は番組表の見出しと同じ。番号の無い局も幅は取る (局名の頭をそろえる) -->
                            <span class="channel-number" data-testid="live-number">
                                {#if channel.number !== null}<span class="tag">{channel.number}</span>{/if}
                            </span>
                            <ServiceLogo
                                id={channel.id}
                                has={channel.hasLogo}
                                style="width: 2rem; height: 2rem"
                                fallback={channel.type}
                            />
                            <!--
                                **いま映しているものは、行の地と局名の前の小さな印 (▶) で。**
                                色だけだと、色の見え方が違う人に伝わらない。行の右に
                                「視聴中」のバッジを置いていた頃は、狭い列 (スマホの横・PC の
                                256px) でバッジが幅を取り、局名も番組名も「で…」まで潰れていた。
                                文字は読み上げにだけ渡す (行は `aria-current` も持つ)
                            -->
                            <span class="channel-text">
                                <span class="channel-name broadcast">
                                    {#if tuned}<span class="tuned-mark" data-testid="live-tuned-mark"
                                            ><Icon icon={PLAY} size="size-3" /></span
                                        ><span class="visually-hidden">視聴中</span>{/if}{channel.name}
                                </span>
                                {#if channel.now}
                                    <span class="channel-now broadcast">
                                        {channel.now.name}
                                    </span>
                                {/if}
                            </span>
                        </button>

                        <!--
                        **中身を読むボタンは行と別に置く。** 行そのものは選局
                        (テレビと同じで、押したら映るのがいちばん多い用) なので、
                        あらすじや出演者を見たいだけのときにチャンネルが変わっては困る。
                        番組の分からない局 (番組表がまだ薄い) には出さない
                    -->
                        {#if channel.now}
                            <button type="button"
                                class="ghost small channel-detail"
                                onclick={() => openDetail(channel)}
                                aria-label="{channel.now.name} の詳細"
                                data-testid="live-channel-detail"
                            >
                                <Icon icon={INFO} size="size-5" />
                            </button>
                        {/if}
                    </li>
                {/each}
            </ul>
        </aside>
    {/if}
    {/snippet}
</PlayerLayout>

<!-- 返事が変わったことは `source` で渡す (他の画面と同じ。閉じた通知の扱いは Toasts) -->
<Toasts
    {notices}
    source={form}
    ondismiss={(key) => {
        shooter.dismiss(key);
        pip.dismiss(key);
    }}
/>

<!-- 運転中の注意 (互換モードで初めて再生する前に1回)。押すまで再生を始めない -->
<DriveNotice open={drive.open} onaccept={drive.accept} />

<style>
    /*
     * 右の一覧の列。幅と高さ・サイドバーの形は FactsAside と同じく `PlayerLayout` が持つ。
     * 中の余白はサイドバーのとき `--dp-side-pad`。一覧 (`.channels`) だけは列の端まで広げて
     * 中で余白を取る — スクロールバーを窓の右端に出すため
     */
    .live-side {
        display: flex;
        flex-direction: column;
        padding: var(--dp-side-pad, 0) var(--dp-side-pad, 0) 0;
    }
    .track-label {
        display: inline-block;
        max-width: 7rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        vertical-align: bottom;
    }
    /* 測り直す操作。読みものの行に置くので、ボタンの形にはしない */
    .relearn {
        margin: 0;
        padding: 0;
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        text-decoration: underline dotted;
        text-underline-offset: 2px;
        cursor: pointer;
    }
    .relearn:hover {
        color: #fff;
    }
    /* 録画に譲った通知。通知の列は押せない (`PlayerStage`) ので、この通知だけ押せるように戻す。見た目は StageNote と同じ */
    .yielded {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        max-width: 100%;
        padding: 0.25rem 0.25rem 0.25rem 0.75rem;
        border-radius: 1rem;
        background: rgb(0 0 0 / 0.6);
        font-size: 0.75rem;
        color: #fff;
        pointer-events: auto;
    }
    .back-live {
        width: auto;
        margin: 0;
        padding: 0.125rem 0.75rem;
        border: 1px solid rgb(255 255 255 / 0.6);
        border-radius: 1rem;
        background: transparent;
        color: #fff;
        font-size: 0.75rem;
    }
    .back-live:hover:not(:disabled) {
        background: rgb(255 255 255 / 0.15);
    }
    .unmute {
        position: absolute;
        top: 0.75rem;
        left: 0.75rem;
        gap: 0.5rem;
    }
    /* 列の幅いっぱいに伸びるので、3 つを均等に広げる。左に寄せると右に溝だけが余った */
    .type-tabs {
        display: flex;
        margin-bottom: 0.5rem;
    }
    .type-tabs > button {
        flex: 1;
    }
    .channels {
        flex: 1;
        margin: 0 calc(-1 * var(--dp-side-pad, 0px));
        /*
         * 行は列の端から少し内側 (0.5rem) に置き、行の中の余白 (0.75rem) と足して、
         * 局名の頭を上のタブや番組の中身の字と同じ位置 (`--dp-side-pad`) にそろえる
         */
        padding: 0 max(0px, calc(var(--dp-side-pad, 0px) - 0.75rem)) var(--dp-side-pad, 0);
        overflow-y: auto;
    }
    @media (min-width: 768px) {
        .channels {
            min-height: 0;
        }
    }
    /*
     * 一行 = 局を選ぶボタンと中身を読むボタン。地は行 (`li`) ごと塗る — 選ぶボタンだけを
     * 塗ると、右の (i) の所だけ地が欠ける。枠も区切りの線も付けない
     */
    .channel-item {
        display: flex;
        align-items: stretch;
        min-height: 2.75rem;
        margin: 0;
        border-radius: var(--dp-radius);
        list-style: none;
        transition: background-color var(--dp-duration);
    }
    .channel-item + .channel-item {
        margin-top: 0.125rem;
    }
    /* 指を乗せた行は、いま映している行より淡く */
    .channel-item:hover {
        background: color-mix(in srgb, var(--dp-hover) 60%, transparent);
    }
    .channel-item.tuned {
        background: var(--dp-subtle);
    }
    /* 番号のラベルは淡い面の色。同じ色で塗った行の上では消えるので、地の色にする */
    .channel-item.tuned :global(.tag) {
        background: var(--dp-bg);
    }
    .channel {
        display: flex;
        min-width: 0;
        flex: 1;
        align-items: center;
        gap: 0.75rem;
        margin: 0;
        padding: 0.5rem 0.75rem;
        border: 0;
        border-radius: var(--dp-radius);
        background: transparent;
        color: inherit;
        text-align: left;
        font-size: inherit;
        font-weight: var(--dp-weight);
        cursor: pointer;
    }
    .channel-number {
        width: 2.5rem;
        flex-shrink: 0;
        text-align: right;
        font-variant-numeric: tabular-nums;
    }
    .channel-text {
        min-width: 0;
        flex: 1;
    }
    .channel-name,
    .channel-now {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .channel-name {
        font-size: 0.875rem;
        font-weight: var(--dp-weight);
    }
    .tuned .channel-name {
        color: var(--dp-primary-text);
    }
    .channel-now {
        font-size: 0.75rem;
        color: var(--dp-muted);
    }
    /* 局名の前の印。塗った三角 (Lucide の play は線だけなので塗る) */
    .tuned-mark {
        display: inline-flex;
        margin-inline-end: 0.25rem;
        vertical-align: -0.0625rem;
    }
    .tuned-mark :global(path) {
        fill: currentColor;
    }
    .channel-detail {
        height: auto;
        flex-shrink: 0;
        align-self: stretch;
        margin: 0;
    }
</style>
