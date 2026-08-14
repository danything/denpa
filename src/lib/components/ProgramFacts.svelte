<script lang="ts">
    import { type Audio, audioLabel, type Genre, genreLabel, videoLabel } from '$lib/arib';
    import { dateTime, duration, linkify, time } from '$lib/format';
    import { jsonArray } from '$lib/json';
    import type { ProgramDetail } from '$lib/types';

    /**
     * 番組の中身そのもの。**枠は持たない。**
     *
     * モーダル (`ProgramDetail.svelte`) と、録画を観る画面の左側
     * (`routes/watch/[id]`) の両方から使う。**同じものを2つ書くと、片方だけ
     * 直したときに見え方がずれる** — 実際、番組表・予約一覧・録画一覧で
     * 見え方を揃えるためにモーダルへ寄せたのが元の理由で、観る画面もその続き。
     */
    let {
        program,
        notes = [],
        cmNote = null,
        fps = null,
    }: {
        program: ProgramDetail;
        /**
         * 失敗や削除の理由。一覧には状態だけを出して、中身はここで見せる。
         *
         * 見出しを一緒に渡す。録画そのものの失敗とエンコードの失敗は別物で、
         * どちらも「エンコードに失敗しました」と書いていた頃は、録画が失敗した
         * 行を開くと嘘の見出しが出ていた
         */
        notes?: { title: string; text: string }[];
        /** 何を使って検出したか (無音 / join_logo_scp)。判定の当てにできるか分かる */
        cmNote?: string | null;
        /**
         * 焼いたもののコマ数 (30/60、`recordings.fps`)。**番組ではなく録画の事実**なので
         * `program` とは別に渡す — 番組詳細は EPG から引けると差し替わる (`detail.open`)
         */
        fps?: number | null;
    } = $props();

    /** 詳細情報。EIT から拾った「出演者」などの見出し付きテキスト */
    function extended(json: string | null): [string, string][] {
        if (json === null || json === '') return [];
        try {
            return Object.entries(JSON.parse(json) as Record<string, string>);
        } catch {
            return [];
        }
    }

    /**
     * ジャンルの札。**同じものは1つにまとめる。**
     *
     * 放送は同じ分類を何度も入れてくる。実機の NHK の高校野球中継が
     * `[スポーツ, 拡張, 拡張]` で、**「拡張」の札が2つ**になっていた
     * (0xE は分類ではなく、局が自分で決めた符号を載せる枠なので中身は同じ)。
     *
     * まとめる理由は見た目だけではない。**同じ札が2つ並ぶと Svelte が落ちる** —
     * 一覧の目印を札の字にしていたので、字が同じものが2つあると
     * `each_key_duplicate` で描画ごと死に、**その番組だけ詳細が開かなかった**
     * (実機。押しても何も起きないので、原因の見当が付かない出方をする)。
     * 目印は番号にしてあるが、そもそも重なるものを渡さない。
     */
    const genres = $derived([
        ...new Set(
            jsonArray<Genre>(program.genre_detail)
                .map(genreLabel)
                .filter((label) => label !== ''),
        ),
    ]);
    const audios = $derived(jsonArray<Audio>(program.audios).map(audioLabel));
    const video = $derived(videoLabel(program.video_resolution, program.video_type));
</script>

<!--
    説明文。中に書かれたURLはリンクにする。
    `{@html}` は使わない。EPG の文面は放送局が書いたものをそのまま持ってきているので、
    そのまま流し込めるものとして扱わない
-->
{#snippet body(text: string)}{#each linkify(text) as part, i (i)}{#if part.href}<a
                class="link link-primary break-all"
                href={part.href}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="detail-link">{part.text}</a
            >{:else}{part.text}{/if}{/each}{/snippet}

<h3 class="text-lg font-bold break-words">{program.name}</h3>
<p class="text-base-content/60 mt-1 text-sm">
    {program.service_name} ・ {dateTime(program.start_at)} 〜 {time(program.end_at)}
    ({duration(program.start_at, program.end_at)})
</p>

<!-- EPG が持っている符号は、そのままでは読めないので言葉に直して出す -->
<div class="mt-2 flex flex-wrap gap-1" data-testid="detail-badges">
    <!-- 目印は番号で。字を目印にすると、同じ札が2つ来たときに落ちる -->
    {#each genres as label, i (i)}
        <span class="badge badge-sm badge-ghost" data-testid="detail-genre">{label}</span>
    {/each}
    {#if video}
        <span class="badge badge-sm badge-ghost" data-testid="detail-video">{video}</span>
    {/if}
    {#if fps !== null}
        <!-- 実測 (fpsDetect) がどちらに転んだか。ログにしか出ていなかった -->
        <span class="badge badge-sm badge-ghost" data-testid="detail-fps">{fps}コマ</span>
    {/if}
    {#each audios as label, i (i)}
        <span class="badge badge-sm badge-ghost" data-testid="detail-audio">{label}</span>
    {/each}
    {#if !program.is_free}
        <span class="badge badge-sm badge-warning" data-testid="detail-paid">有料</span>
    {/if}
</div>

{#if program.description}
    <p class="mt-3 text-sm whitespace-pre-wrap">{@render body(program.description)}</p>
{/if}

{#each extended(program.extended) as [heading, text] (heading)}
    <div class="mt-3">
        <div class="text-sm font-medium">{heading}</div>
        <div class="text-base-content/70 text-sm whitespace-pre-wrap">{@render body(text)}</div>
    </div>
{/each}

{#if cmNote}
    <!--
        **いつもの精度が出なかったときだけ出す。** ロゴまで見て判定できた回は
        `cmNote` ごと渡ってこない (`format.cmNoteWorthShowing`) ので、この塊は
        出ない。「join_logo_scp」とだけ書いてあっても読む人には何の情報にもならず、
        結果はチャプターを見れば分かる。ここに何か書いてあること自体が合図になる。

        **どこを切ったかは書かない** — 切った位置はチャプターとして動画に
        入っている。時刻を並べていた頃は、長い一覧が説明文の下を埋めていた。

        ロゴを教える口を出すかどうかも、この文言から決めている
        (`format.logoUnusable`)。口そのものはチューナー画面にある — ロゴは
        録画ごとではなく**局ごと**の話で、一度教えれば以降の全部に効く
    -->
    <div class="mt-3" data-testid="detail-cm">
        <div class="text-sm font-medium">CM</div>
        <div class="text-base-content/60 text-xs" data-testid="detail-cm-note">{cmNote}</div>
    </div>
{/if}

{#each notes as note (note.title)}
    <!-- 失敗や削除の理由。一覧には状態だけを出して、中身はここで見せる -->
    <div class="mt-3" data-testid="detail-error">
        <div class="text-error text-sm font-medium">{note.title}</div>
        <pre
            class="bg-base-200 mt-1 max-h-48 overflow-auto rounded p-2 font-mono text-xs whitespace-pre-wrap">{note.text}</pre>
    </div>
{/each}
