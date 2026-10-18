<script lang="ts">
    import { submitting } from '#lib/actions.js';
    import { resolve } from '$app/paths';

    /**
     * CM検出のために覚えた局ロゴを小さく見せて、違っていれば捨てる。設定の「ロゴ」の
     * 局ごとの行に、**覚えた局だけ**出す (列の見出しが「CMロゴ」なので、ここでは名乗らない)。
     *
     * 自動の割り出しは「隅で線の向きが毎コマ揃う所」しか見ないので、ロゴでない縁
     * (番組がずっと出しているテロップの飾りなど) を覚えることもある。CM判定が当たらない
     * ときに、覚えているものが画像になっているのかを確かめる手立てが要る。
     *
     * **開け閉めしない。** 画像も「覚え直す」も行にいつも出しておく (畳んだ一覧や
     * ポップオーバーの奥に置いていた頃は、確かめるのに1局ずつ開いて回ることになった)。
     * 行の高さは局ロゴと同じくらいに抑える。細かい形は画像を押して大きく見る (`LogoZoom`)
     */
    let {
        serviceId,
        serviceName,
        learnedAt,
        onzoom,
    }: {
        serviceId: number;
        serviceName: string;
        /** 覚えたものを最後に書いた時刻 */
        learnedAt: number;
        /** 画像を押したとき。大きく見せる窓を開く */
        onzoom: () => void;
    } = $props();
</script>

<span class="learned-logo" data-testid="learned-logo">
    <!--
        線の向きがどのコマでも揃うところを白く出した画像。ロゴの形になっていれば合っている。
        書き直すたびに URL を変えて、古い画像を出し続けないようにする
    -->
    <button
        type="button"
        class="zoom"
        onclick={onzoom}
        aria-label={`${serviceName} のCMロゴを大きく見る`}
        data-testid="logo-zoom-cm"
    >
        <img src={resolve(`api/services/${serviceId}/logo-data?at=${learnedAt}`)} alt="" class="learned-image" />
    </button>
    <!-- 理由は `routes/settings/reception/logos.server.ts` の `logoForget` -->
    <form method="POST" action="?/logoForget" use:submitting class="forget">
        <input type="hidden" name="serviceId" value={serviceId} />
        <button type="submit" class="small ghost" aria-label={`${serviceName} のCM検出のロゴを覚え直す`}>覚え直す</button>
    </form>
</span>

<style>
    .learned-logo {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
    }
    /* 画像そのものを押す。ボタンの地や余白は付けない */
    .zoom {
        display: inline-flex;
        width: auto;
        margin: 0;
        padding: 0;
        border: 0;
        border-radius: var(--dp-radius-sm);
        background: none;
        cursor: zoom-in;
    }
    .learned-image {
        height: 1.6rem;
        max-width: 4.8rem;
        border-radius: var(--dp-radius-sm);
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
