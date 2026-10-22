<script lang="ts">
  import { submitting } from "#lib/actions.js";
  import { arming } from "#lib/arming.svelte.js";
  import Lead from "#lib/components/Lead.svelte";
  import Toasts, {
    errorNotice,
    type Notice,
  } from "#lib/components/Toasts.svelte";
  import { measure } from "#lib/measure.svelte.js";
  import type { SubmitFunction } from "$app/forms";
  import { resolve } from "$app/paths";

  let { data, form } = $props();

  const notices = $derived.by(() => {
    const list: Notice[] = [];
    list.push(...errorNotice(form, "settings-error"));
    if (form?.loggedOut !== undefined) {
      list.push({
        key: "logged-out-others",
        kind: "success",
        text:
          form.loggedOut === 0
            ? "ほかにログインしている端末はありませんでした"
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

<!--
    節の並びと名前は `#lib/settings-sections.ts`。`id` は左の一覧から飛ぶ先。
    **ほかの場所で切り替えられるものはここに並べない** (テーマはヘッダーとスマホの「その他」、
    互換モードは再生画面の ⚙)。同じ設定が2か所にあると、どちらが効いているのか迷う
-->
<div class="part" id="browser" data-part>
  <div class="sections readable">
    <!--
            **端末でしか出ない食い違いを、その端末で読むための入口。** 縦のはみ出しは、引っ込む
            アドレスバーや画面の切り欠きが絡むと**その端末でしか起きない**。入り口をここに置くのは、
            PWA にアドレスバーが無いため (`?measure` を打つところがない)。
            サーバには送らず、端末に覚える (localStorage)
        -->
    <section class="section">
      <div class="section-head">
        <h2>画面の高さを見る</h2>
      </div>
      <label class="check">
        <input
          type="checkbox"
          role="switch"
          aria-checked={measure.on}
          checked={measure.on}
          onchange={(event) => measure.set(event.currentTarget.checked)}
          data-testid="measure-toggle"
        />
        <span>高さの表示を出す</span>
      </label>
      <Lead class="indent">
        右下に、この端末での画面の高さを出します
        {#snippet more()}
          <p>
            <strong>この端末だけ</strong
            >の設定で、サーバにも他の端末にも伝わりません。
          </p>
          <p>
            出るのは「窓 / 枠 / 中身 = はみ出し」「dvh / svh / lvh / vh
            の実測」と、
            <strong>はみ出している要素</strong>。はみ出しが 0
            でなければページごと動きます。
            単位の4つが同じ数なら、食い違いが原因ではありません。
          </p>
        {/snippet}
      </Lead>
    </section>
  </div>
</div>

<div class="part" id="login" data-part>
  <div class="sections readable">
    <!--
            **ログアウトはヘッダーではなくここ。** ヘッダーとスマホの「その他」に置いていた頃は、
            たまにしか押さないものが毎回目に入っていた。押すのは POST (`/logout`)。
            リンク (GET) にすると、先読みで勝手に切れる
        -->
    <section class="section">
      <div class="section-head">
        <h2>ログイン</h2>
      </div>
      {#if data.user && data.others !== null}
        <form method="POST" action={resolve("logout")}>
          <button
            type="submit"
            class="small secondary outline"
            data-testid="logout">ログアウト</button
          >
        </form>

        <div class="others">
          <form method="POST" action="?/logoutOthers" use:submitting={sent}>
            {#if confirming.armed === 0}
              <button
                type="submit"
                class="small danger"
                data-testid="logout-others-confirm">ログアウトを確定</button
              >
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
            <span>
              {data.others === 0
                ? "ほかにログインしている端末はありません"
                : `この端末のほかに ${data.others} 件のログインがあります`}
            </span>
            {#snippet more()}
              <p>
                この端末のほかのログインを、誰のものでも全部終わらせます。なくした端末や手放した端末を止めるときに使います。
                終わらせた端末は、次に開いたときにログインし直しになります。
              </p>
              <p>
                テレビのアプリは止まりません。テレビは
                <a href={`${resolve("settings/integrations")}#tv`}
                  >テレビのアプリ</a
                >で1台ずつ取り消します。
              </p>
            {/snippet}
          </Lead>
        </div>
      {:else}
        <!-- 素通し (TRUSTED_NETWORKS) で入っている。控えが無いので、切るものも無い -->
        <p class="small muted" data-testid="login-none">
          ログインせずに使っています
          (信頼するネットワークから入っているため)。ログアウトするものはありません
        </p>
      {/if}
    </section>
  </div>
</div>

<div class="part" id="version" data-part>
  <div class="sections readable">
    <!--
            **動いている版。** 新しい版のリンクはヘッダー (狭い画面は「その他」) にだけ出す (`server/update.ts`)。
            ここにも並べると同じリンクが2か所になる。main のイメージと手元は `dev` で、リリースと見比べない
        -->
    <section class="section">
      <div class="section-head">
        <h2>バージョン</h2>
      </div>
      <p class="small" data-testid="version">
        {data.version === "dev" ? "開発版 (dev)" : data.version}
      </p>
      {#if data.version === "dev"}
        <Lead>開発版なので、新しいリリースとは見比べません</Lead>
      {:else}
        <Lead
          >新しい版が出たら、ヘッダー (狭い画面は下の「その他」) に出ます</Lead
        >
      {/if}
    </section>
  </div>
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
