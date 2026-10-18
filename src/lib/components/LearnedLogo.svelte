<script lang="ts">
    import { submitting } from '#lib/actions.js';
    import { dateTime } from '#lib/format.js';
    import { resolve } from '$app/paths';

    /**
     * CM検出のために覚えた局ロゴを小さく見せて、違っていれば捨てる。チューナー画面の
     * 「受信できるチャンネル」の局名の横に、**覚えた局だけ**出す。
     *
     * 自動の割り出しは「隅で線の向きが毎コマ揃う所」しか見ないので、ロゴでない縁
     * (番組がずっと出しているテロップの飾りなど) を覚えることもある。CM判定が当たらない
     * ときに、覚えているものが画像になっているのかを確かめる手立てが要る。
     *
     * **開け閉めしない。** 画像も「覚え直す」も行にいつも出しておく (畳んだ一覧や
     * ポップオーバーの奥に置いていた頃は、確かめるのに1局ずつ開いて回ることになった)。
     * 行の高さは局ロゴと同じくらいに抑える
     */
    let {
        serviceId,
        serviceName,
        learnedAt,
    }: {
        serviceId: number;
        serviceName: string;
        /** 覚えたものを最後に書いた時刻 */
        learnedAt: number;
    } = $props();
</script>

<span class="learned-logo" data-testid="learned-logo">
    <span class="label" aria-hidden="true">CM</span>
    <!--
        線の向きがどのコマでも揃うところを白く出した画像。ロゴの形になっていれば合っている。
        書き直すたびに URL を変えて、古い画像を出し続けないようにする
    -->
    <img
        src={resolve(`api/services/${serviceId}/logo-data?at=${learnedAt}`)}
        alt={`${serviceName} のCM検出のロゴ`}
        title={`CM検出のロゴ (${dateTime(learnedAt)} に更新)`}
        class="learned-image"
    />
    <!-- 理由は `routes/tuners/+page.server.ts` の `logoForget` -->
    <form method="POST" action="?/logoForget" use:submitting class="forget">
        <input type="hidden" name="serviceId" value={serviceId} />
        <button type="submit" class="xs ghost" aria-label={`${serviceName} のCM検出のロゴを覚え直す`}>覚え直す</button>
    </form>
</span>

<style>
    .learned-logo {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
    }
    .label {
        font-size: var(--dp-text-xs);
        color: var(--dp-muted);
    }
    .learned-image {
        height: 1rem;
        max-width: 3rem;
        border-radius: 0.2rem;
        object-fit: contain;
        image-rendering: pixelated;
        /* 縁を白で出すので、下地は暗いほうに寄せた枠色を使う */
        background: var(--dp-line);
    }
    .forget {
        display: contents;
    }
    .forget button {
        padding-block: 0;
        line-height: 1.5;
    }
</style>
