<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";

  import { arming } from "#lib/arming.svelte.js";
  import ArmedDelete from "#lib/components/ArmedDelete.svelte";
  import Lead from "#lib/components/Lead.svelte";
  import Toasts, { errorNotice } from "#lib/components/Toasts.svelte";
  import { dateTime, typeNames } from "#lib/format.js";
  import { liveTuner } from "#lib/live-tuner.svelte.js";
  import { held } from "#lib/live-updates.svelte.js";
  import { measure } from "#lib/measure.svelte.js";
  import {
    theme,
    THEME_LABEL,
    THEME_MODES,
    type ThemeMode,
  } from "#lib/theme.svelte.js";

  import Diagnostics from "./Diagnostics.svelte";

  let { data, form } = $props();

  /** ロゴの記録の終わり方 (`logo.ts` の `Outcome`) を画面の言葉で。知らない値はそのまま出す */
  const OUTCOME_WORDS: Record<string, string> = {
    done: "読み切った",
    miss: "ロゴの無い中継",
    ranOut: "上限まで開いた",
    yielded: "譲った",
    busy: "空きが無い",
    stopped: "止めた",
  };

  // この端末で覚えている名指しを読む (サーバには置かない)
  $effect(() => liveTuner.load());

  /**
   * ライブのチューナーの選択肢。無効なものは出さない。画面を先に出し、エージェントの答えが届いたら入れる
   * (「バージョンと環境」のチューナーと同じ 1 回の問い合わせ。届くまでは `undefined`)
   */
  const tuners = held(() => data.tuners);
  const liveTuners = $derived(
    (tuners.value?.list ?? []).filter((tuner) => !tuner.disabled),
  );

  /** 選択肢をエージェントごとにまとめたもの (一覧の並び = エージェントの並び) */
  const agentGroups = $derived.by(() => {
    const groups: {
      agent: number;
      name: string;
      tuners: typeof liveTuners;
    }[] = [];
    for (const tuner of liveTuners) {
      let group = groups.find((g) => g.agent === tuner.agent);
      if (group === undefined) {
        group = { agent: tuner.agent, name: tuner.agentName, tuners: [] };
        groups.push(group);
      }
      group.tuners.push(tuner);
    }
    return groups;
  });

  // 覚えている名指しが一覧に無い (チューナーを外した、エージェントに繋がらない)。届く前は「一覧にありません」を付けない
  const unlisted = $derived(
    liveTuner.pin !== null &&
      !liveTuners.some((tuner) => tuner.pin === liveTuner.pin),
  );

  const notices = $derived.by(() => {
    const list = errorNotice(form, "settings-error");
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
   * **2 回押させる** (削除と同じ `arming` と `ArmedDelete`)。押し間違えると、家族の端末まで入り直しになる。
   * 押す場所は 1 つなので、`armKey` は 0 で足りる
   */
  const confirming = arming('[data-testid^="logout-others"]');
</script>

<svelte:window onclick={confirming.stand} />

<Toasts {notices} source={form} />

<!--
    節の並びと名前は `#lib/settings-sections.ts`。`id` は左の一覧から飛ぶ先。
    **ほかの場所で切り替えられるものはここに並べない** (互換モードは再生画面の ⚙)。
    同じ設定が 2 か所にあると、どちらが効いているのか迷う
-->
<div id="browser" data-part>
  <div class="sections readable">
    <!--
            **テーマはここだけで選ぶ** (`#lib/theme.svelte.ts`)。前はヘッダーのボタンと下のタブの「その他」にあったが、
            ほかの端末ごとの設定と同じくここに置く。サーバには送らず、端末に覚える (localStorage)
        -->
    <section class="section">
      <div class="section-head">
        <h2>テーマ</h2>
      </div>
      <select
        class="narrow"
        aria-label="テーマ"
        onchange={(event) => theme.set(event.currentTarget.value as ThemeMode)}
        data-testid="theme-select"
        data-mode={theme.mode}
      >
        {#each THEME_MODES as mode (mode)}
          <option value={mode} selected={theme.mode === mode}
            >{THEME_LABEL[mode]}</option
          >
        {/each}
      </select>
      <Lead>
        この端末だけの設定です。「端末に合わせる」は端末の明暗の設定に合わせて切り替わります
      </Lead>
    </section>
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
            >の設定で、サーバにもほかの端末にも伝わりません。
          </p>
          <p>
            出るのは「窓 / 枠 / 中身 = はみ出し」「dvh / svh / lvh / vh
            の実測」と、
            <strong>はみ出している要素</strong>。はみ出しが 0
            でなければページごと動きます。単位の 4
            つが同じ数なら、食い違いが原因ではありません。
          </p>
        {/snippet}
      </Lead>
    </section>
    <!--
            **ライブで使うチューナーを名指しする** (開発者向け。`#lib/live-tuner.svelte.ts`)。
            ふだんはエージェントが選ぶ (docs/agent.md「選ぶ順の約束」)。サーバには送らず、端末に覚える (localStorage)
        -->
    <section class="section">
      <div class="section-head">
        <h2>ライブのチューナー (開発者向け)</h2>
      </div>
      <select
        class="narrow"
        aria-label="ライブのチューナー"
        onchange={(event) =>
          liveTuner.set(
            event.currentTarget.value === "" ? null : event.currentTarget.value,
          )}
        data-testid="live-tuner-select"
      >
        <option value="" selected={liveTuner.pin === null}>自動</option>
        <!-- 覚えている名指しが一覧に無いとき (チューナーを外した、エージェントに繋がらない) は、効いたまま「自動」に見せない -->
        {#if unlisted}
          <option value={liveTuner.pin} selected
            >{liveTuner.pin}{tuners.value === undefined
              ? ""
              : " (一覧にありません)"}</option
          >
        {/if}
        <!-- エージェントごとに見出しを付けて分ける (1 台でも付ける。設定の「チューナー」の表と同じ形) -->
        {#each agentGroups as group (group.agent)}
          <optgroup label={group.name}>
            {#each group.tuners as tuner (tuner.pin)}
              <option value={tuner.pin} selected={liveTuner.pin === tuner.pin}
                >{tuner.name} ({typeNames(tuner.types)})</option
              >
            {/each}
          </optgroup>
        {/each}
      </select>
      <Lead>
        ふだんは「自動」にします。選ぶと、ライブの選局にそのチューナーだけを使います。
        使えないときは、ほかのチューナーに替えずに理由を出します
        {#snippet more()}
          <p>
            <strong>この端末だけ</strong
            >の設定で、サーバにもほかの端末にも伝わりません。録画と番組表の取得は、これまでどおりエージェントが選びます。
          </p>
          <p>
            放送の種別を受けられないチューナーを選んだ局は、選局できません。同じ局をほかの人が「自動」で見ているときも、共有せずにこのチューナーで選局し直します。
          </p>
        {/snippet}
      </Lead>
    </section>
    <!--
            **ロゴを取得した結果を記録する** (開発者向け。`logo-record.ts`。docs/logo.md「ロゴの取得を記録する」)。
            衛星のロゴが流れてくる期間を測るためのもの。世帯の設定で、既定はオフ
        -->
    <section class="section" data-testid="logo-record">
      <div class="section-head">
        <h2>ロゴを集めた結果を記録する (開発者向け)</h2>
      </div>
      <!--
        送ったあとにフォームを戻すと、再描画までスイッチが一瞬もとに戻って見える。
        断られたら見た目をサーバの値に戻す (load が同じ値を返すと DOM は書き換わらない。ルールの行のスイッチと同じ)
      -->
      <form
        method="POST"
        action="?/recordLogo"
        use:enhance={({ formElement }) =>
          async ({ result, update }) => {
            await update({ reset: false });
            const box = formElement.querySelector<HTMLInputElement>(
              'input[role="switch"]',
            );
            if (
              box !== null &&
              result.type !== "success" &&
              result.type !== "redirect"
            )
              box.checked = data.recordLogo;
          }}
      >
        <label class="check">
          <input
            type="checkbox"
            role="switch"
            name="recordLogo"
            aria-checked={data.recordLogo}
            checked={data.recordLogo}
            onchange={(event) => event.currentTarget.form?.requestSubmit()}
            data-testid="logo-record-toggle"
          />
          <span>ロゴを集めた結果を記録する</span>
        </label>
      </form>
      <Lead class="indent">
        オンの間、衛星のロゴを流す中継で待つたびに、いつ・どれだけ開いて・何が届いたかを残します
        {#snippet more()}
          <p>
            衛星のロゴはダウンロードの期間にしか流れず、期間がいつ来るかは前もって分かりません。数週間ぶん記録すると、期間の間隔と長さが分かります。
          </p>
          <p>
            新しいものから 2,000 件・60 日ぶんまで残します。CSV
            はロゴが揃わないことを報告するときに添えてください。
          </p>
          <p>
            1
            行は、開き始めた時刻・中継・開いていた長さ・終わり方・ロゴのデータとして届いたパケットの数・ダウンロードを知らせる表
            (SDTT) が届いた回数・取れた局の数です。
          </p>
        {/snippet}
      </Lead>
      {#if data.logoRecords.length > 0}
        <ol class="logo-records small" data-testid="logo-records">
          {#each data.logoRecords as record (record.id)}
            <li data-testid="logo-record-row">
              <span>{dateTime(record.started_at)}</span>
              {record.channel}・{Math.round(record.opened_ms / 60_000)} 分・{OUTCOME_WORDS[
                record.outcome
              ] ?? record.outcome}・ロゴのデータ
              {record.es_packets} パケット・ダウンロードの通知 {record.sdtt} 回・{record.found}
              局
            </li>
          {/each}
        </ol>
        <a
          class="button small secondary"
          href={resolve("api/logo-records")}
          download
          data-testid="logo-records-csv">CSV をダウンロード</a
        >
      {:else if data.recordLogo}
        <p class="small muted" data-testid="logo-records-empty">
          まだ記録はありません
        </p>
      {/if}
    </section>
  </div>
</div>

<div id="login" data-part>
  <div class="sections readable">
    <!--
            **ログアウトはヘッダーではなくここ。** ヘッダーと下のタブの「その他」に置いていた頃は、
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
          <ArmedDelete
            deleting={confirming}
            armKey={0}
            action="?/logoutOthers"
            class="small"
            testid="logout-others"
            label="ほかの端末からもログアウト"
            confirmLabel="ログアウトを確定"
          />
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
                >で 1 台ずつ取り消します。
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

<!-- バージョンと環境 (`#version`)・ログ (`#logs`)。前の「診断」 -->
<Diagnostics {data} />

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
  .logo-records {
    margin: var(--dp-space-2) 0;
    padding: 0;
    list-style: none;
    max-height: 16rem;
    overflow-y: auto;
  }
</style>
