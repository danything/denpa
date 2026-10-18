<script lang="ts">
    import { submitting } from '#lib/actions.js';
    import { arming } from '#lib/arming.svelte.js';
    import Lead from '#lib/components/Lead.svelte';
    import Toasts, { errorNotice, type Notice } from '#lib/components/Toasts.svelte';
    import type { SubmitFunction } from '$app/forms';
    import { resolve } from '$app/paths';

    let { data, form } = $props();

    const notices = $derived.by(() => {
        const list: Notice[] = [];
        list.push(...errorNotice(form, 'settings-error'));
        if (form?.loggedOut !== undefined) {
            list.push({
                key: 'logged-out-others',
                kind: 'success',
                text:
                    form.loggedOut === 0
                        ? 'ほかにログインしている端末はありませんでした'
                        : `ほかの端末のログインを ${form.loggedOut} 件終わらせました`,
            });
        }
        return list;
    });

    /**
     * **2回押させる** (削除と同じ `arming`)。押し間違えると、家族の端末まで入り直しになる。
     * 押す場所は1つなので、構えの鍵は 0 で足りる
     */
    const confirming = arming('[data-testid^="logout-others"]');
    const sent: SubmitFunction = () => async (options) => {
        await options.update();
        confirming.fire();
    };
</script>

<svelte:window onclick={confirming.stand} />

<Toasts {notices} source={form} />

<div class="sections readable">
    <!--
        **ログアウトはヘッダーではなくここ。** ヘッダーとスマホの「その他」に置いていた頃は、
        たまにしか押さないものが毎回目に入っていた。押すのは POST (`/logout`)。
        リンク (GET) にすると、先読みで勝手に切れる
    -->
    <section class="section" data-testid="login-card">
        <div class="section-head">
            <h2>ログイン</h2>
        </div>
        {#if data.user && data.others !== null}
            <form method="POST" action={resolve('logout')}>
                <button type="submit" class="small secondary outline" data-testid="logout">ログアウト</button>
            </form>

            <div class="others">
                <form method="POST" action="?/logoutOthers" use:submitting={sent}>
                    {#if confirming.armed === 0}
                        <button type="submit" class="small danger" data-testid="logout-others-confirm">ログアウトを確定</button>
                    {:else}
                        <button
                            type="button"
                            class="small secondary outline"
                            onclick={() => confirming.arm(0)}
                            data-testid="logout-others"
                        >
                            ほかの端末からもログアウト
                        </button>
                    {/if}
                </form>
                <Lead>
                    <span data-testid="other-sessions">
                        {data.others === 0
                            ? 'ほかにログインしている端末はありません'
                            : `この端末のほかに ${data.others} 件のログインがあります`}
                    </span>
                    {#snippet more()}
                        <p>
                            この端末のほかのログインを、誰のものでも全部終わらせます。なくした端末や手放した端末を止めるときに使います。
                            終わらせた端末は、次に開いたときにログインし直しになります。
                        </p>
                        <p>
                            テレビのアプリは止まりません。テレビは
                            <a href={resolve('settings/tv')}>テレビのアプリ</a>で1台ずつ取り消します。
                        </p>
                    {/snippet}
                </Lead>
            </div>
        {:else}
            <!-- 素通し (TRUSTED_NETWORKS) で入っている。控えが無いので、切るものも無い -->
            <p class="small muted" data-testid="login-none">
                ログインせずに使っています (信頼するネットワークから入っているため)。ログアウトするものはありません
            </p>
        {/if}
    </section>
</div>

<style>
    .section form {
        margin: 0;
    }
    .others {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: var(--dp-space-2);
    }
</style>
