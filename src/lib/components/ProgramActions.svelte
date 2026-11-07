<script lang="ts">
  import type { SubmitFunction } from "$app/forms";
  import { resolve } from "$app/paths";

  import { submitting } from "#lib/actions.js";
  import { cancelable } from "#lib/format.js";

  /**
   * **番組の詳細の下に並べるボタン** (番組表と検索。`ProgramDetail` の `actions` に入れる)。
   * どちらも同じ番組の詳細なので、何を出すか・どれを主にするかをここ 1 か所で決める。
   *
   * - **並びは控えから主へ。** ルールを作る → 予約取消 → 視聴 → 再生 → 予約。主 (クラスの無いボタン) は
   *   いちばん右 (狭い画面では下の段の右端)。閉じるは左下 (`ProgramDetail`)
   * - **主は 1 つだけ。** 予約できるなら予約、録れていれば再生、いま流れていれば視聴
   * - **失敗の理由はボタンの上に出す** (`message`)。押したのはモーダルの中のボタンで、モーダルは
   *   右下に浮かせた通知 (`Toasts`) より上に出る。下に隠れるものを出しても読めないので、押したボタンの隣に置く。
   *   一覧の行のボタンから送ったものは、画面の通知に出す
   */
  let {
    program,
    cancel,
    recordingId = null,
    watchable,
    clock,
    message = null,
    onsubmit,
  }: {
    program: {
      id: number;
      service_id: number;
      start_at: number;
      end_at: number;
      /** 予約の状態 (`reservationState`)。予約が無ければ null */
      reservation_state: string | null;
      copy_never: boolean;
    };
    /** 予約取消 (`?/cancel`) に一緒に送る隠し欄。番組表は番組の ID、検索は予約の ID */
    cancel: Record<string, number>;
    /** 録れていてそのまま観られる録画 (`playableRecordingId`)。無ければ null */
    recordingId?: number | null;
    /** ライブ画面が持っている局か */
    watchable: boolean;
    /** いまの時刻 (画面の時計。分で刻む) */
    clock: number;
    /** この番組の詳細から送って断られた理由。無ければ null */
    message?: string | null;
    /** 予約・取消を送ったあとの始末 (成功したら閉じる、など) */
    onsubmit: SubmitFunction;
  } = $props();

  const canPlay = $derived(recordingId !== null);
  /**
   * **いま流れている番組は、その場で観られるようにする** (ライブ画面で同じ局を探し直させない)。
   * **ライブ画面が持っている局にだけ出す** (`watchable`)。番組表のマスは名前の無い枠でも出るので、そのまま出すと
   * 押した先で別の局が映る (分割放送をしていない間のサブチャンネル)
   */
  const canWatch = $derived(
    program.start_at <= clock && program.end_at > clock && watchable,
  );
  const canCancel = $derived(
    // サーバの取消 (`reservations.cancelProgram`) と同じ判定。録画中は止めて、そこまでを残す
    cancelable(program.reservation_state, program.end_at, clock),
  );
  /** 録画のしかたは選ばせない (`reservations.reserve`)。コピー禁止の番組には出さない (押しても断るだけ。理由は詳細の「コピー禁止」) */
  const canReserve = $derived(
    !canCancel &&
      program.reservation_state === null &&
      program.end_at > clock &&
      !program.copy_never,
  );
  const primary = $derived(
    canReserve ? "reserve" : canPlay ? "play" : canWatch ? "watch" : null,
  );
</script>

{#if message !== null}
  <div class="notice error" data-testid="detail-refused">{message}</div>
{/if}

<!--
    **ルールを作る。** 予約・録画の詳細と同じ入口 (`search/+page.server.ts`。`rule-form.originOf`)。
    毎回録りたい番組を見つけたとき、検索で探し直さずに済む
-->
<a
  class="button secondary"
  href={resolve(`search?from=program:${program.id}`)}
  data-testid="detail-rule"
>
  ルールを作る
</a>

{#if canCancel}
  <!-- 予約したあと詳細から止められないと、わざわざ予約一覧まで行くことになる -->
  <form method="POST" action="?/cancel" use:submitting={onsubmit}>
    {#each Object.entries(cancel) as [name, value] (name)}
      <input type="hidden" {name} {value} />
    {/each}
    <button type="submit" class="danger outline" data-testid="detail-cancel"
      >予約取消</button
    >
  </form>
{/if}

{#if canWatch}
  <!-- 選局は押した先でやり直すのでリンクにする -->
  <a
    class="button"
    class:secondary={primary !== "watch"}
    href={resolve(`live?service=${program.service_id}`)}
    data-testid="detail-watch"
  >
    視聴
  </a>
{/if}

{#if canPlay}
  <!-- 録れているなら、録画一覧へ戻らずここからそのまま観られるようにする。録っている最中なら観る画面が追っかけ (`/chase`) へ送る -->
  <a
    class="button"
    class:secondary={primary !== "play"}
    href={resolve(`watch/${recordingId}`)}
  >
    再生
  </a>
{/if}

{#if canReserve}
  <form method="POST" action="?/reserve" use:submitting={onsubmit}>
    <input type="hidden" name="programId" value={program.id} />
    <button type="submit" data-testid="detail-reserve">予約</button>
  </form>
{/if}
