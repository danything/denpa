<script lang="ts">
    import { submitting } from '#lib/actions.js';
    import { dateTime } from '#lib/format.js';
    import { resolve } from '$app/paths';

    /**
     * CM検出のために覚えた局ロゴを見せて、違っていれば捨てる。
     *
     * 自動の割り出しは「隅で線の向きが毎コマ揃う所」しか見ないので、ロゴでない縁
     * (番組がずっと出しているテロップの飾りなど) を覚えることもある。CM判定が当たらない
     * ときに、覚えているものが絵になっているのかを確かめる手立てが要る。
     */
    let {
        serviceId,
        serviceName,
        learnedAt,
    }: {
        serviceId: number;
        serviceName: string;
        /** 覚えたものを最後に書いた時刻。覚えていなければ null */
        learnedAt: number | null;
    } = $props();
</script>

<div class="learned-logo" data-testid="learned-logo">
    {#if learnedAt === null}
        <!-- 見出しは置かない。開いた局の名前 (チューナー画面の `<summary>`) の続きとして読む -->
        <p class="small lead">
            {serviceName} のロゴはまだ覚えていません。この局の録画を焼くときに、その録画から覚えます。
        </p>
    {:else}
        <div class="cluster learned">
            <!-- 書き直すたびに URL を変えて、古い絵を出し続けないようにする -->
            <img
                src={resolve(`api/services/${serviceId}/logo-data?at=${learnedAt}`)}
                alt="いま覚えているロゴ"
                class="learned-image"
                style="image-rendering: pixelated"
            />
            <div class="tiny">
                <div class="bold">いま覚えているロゴ</div>
                <!--
                    **いつ書いたかを一緒に出す。** ここに出るのは*いまの*ロゴで、
                    録画の「CM判定に失敗」は*そのとき*の記録
                -->
                <div class="sub">{dateTime(learnedAt)} に更新</div>
                <div class="sub">
                    線の向きが毎コマ揃うところを白く出しています。ロゴの形になっていれば合っています。
                </div>
                <!-- 理由は `routes/tuners/+page.server.ts` の `logoForget` -->
                <form method="POST" action="?/logoForget" use:submitting class="forget">
                    <input type="hidden" name="serviceId" value={serviceId} />
                    <button type="submit" class="xs ghost"> この絵は違う (消して覚え直す) </button>
                </form>
            </div>
        </div>
    {/if}
</div>

<style>
    .learned-logo {
        margin-top: 0.5rem;
    }
    .lead {
        opacity: 0.7;
    }
    .learned {
        --gap: 0.75rem;
        border-radius: 0.25rem;
        padding: 0.5rem;
        background: var(--dp-base-200);
    }
    .learned-image {
        max-height: 8rem;
        border-radius: 0.25rem;
        /* 縁を白で出すので、下地は暗いほうに寄せた枠色を使う */
        background: var(--dp-base-300);
    }
    .sub {
        margin-top: 0.125rem;
        opacity: 0.6;
    }
    .forget {
        margin-top: 0.25rem;
    }
</style>
