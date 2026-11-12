<script lang="ts">
  import type { SubmitFunction } from "$app/forms";
  import { resolve } from "$app/paths";

  import ActionButton from "#lib/components/ActionButton.svelte";
  import { cancelable } from "#lib/format.js";

  /**
   * **番組の詳細の下に並べるボタン** (番組表・検索・ホームの予約。`ProgramDetail` の `actions` に入れる)。
   * どれも同じ番組の詳細なので、何を出すか・どれを主にするかをここ 1 か所で決める。
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
    refusal = null,
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
    /** 予約取消 (`?/cancel`) に一緒に送る隠し欄。番組表は番組の ID、検索とホームは予約の ID */
    cancel: Record<string, number>;
    /** 録れていてそのまま観られる録画 (`playableRecordingId`)。無ければ null */
    recordingId?: number | null;
    /** ライブ画面が持っている局か */
    watchable: boolean;
    /**
     * 番組表に出すが観られない局 (番組表を読めるが復号できない局) なら、そのわけ (`types.undecodableReason`)。
     * 予約と視聴のボタンの代わりにこの文を出す (押しても断るだけ)。観られる局なら null
     */
    refusal?: string | null;
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
    refusal === null &&
      program.start_at <= clock &&
      program.end_at > clock &&
      watchable,
  );
  const canCancel = $derived(
    // サーバの取消 (`reservations.cancelProgram`) と同じ判定。録画中は止めて、そこまでを残す
    cancelable(program.reservation_state, program.end_at, clock),
  );
  /** 録画のしかたは選ばせない (`reservations.reserve`)。コピー禁止の番組には出さない (押しても断るだけ。理由は詳細の「コピー禁止」) */
  const canReserve = $derived(
    refusal === null &&
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

{#if refusal !== null}
  <!-- 観られない局。予約と視聴のボタンを出さないわけを、ボタンの並びの場所で言う -->
  <div class="notice info" data-testid="detail-unwatchable">{refusal}</div>
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
  <ActionButton
    action="?/cancel"
    fields={cancel}
    submit={onsubmit}
    class="danger outline"
    testid="detail-cancel">予約取消</ActionButton
  >
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
  <ActionButton
    action="?/reserve"
    fields={{ programId: program.id }}
    submit={onsubmit}
    testid="detail-reserve">予約</ActionButton
  >
{/if}
