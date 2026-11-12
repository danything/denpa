<script lang="ts">
  import { resolve } from "$app/paths";
  import Info from "~icons/lucide/info";
  import TriangleAlert from "~icons/lucide/triangle-alert";

  import {
    CHANNEL_ALERT_LABEL,
    CHANNEL_NOTICE_ACTION,
    type ChannelAlertKind,
  } from "#lib/channel-notice.js";
  import Icon from "#lib/components/player/Icon.svelte";

  /**
   * **チャンネルのお知らせ (書き換えた・地上波を続けて選局できない) を、ヘッダーの印に畳む** (`+layout.svelte`)。
   * 中身の上に 1 行を足さず、印に指を乗せる (マウス) か押すと、文と設定の「チャンネル」へのボタンを印の下に出す。
   *
   * - **マウスは乗せている間だけ出す。** 印から箱へ動かす間は消さない (`LEAVE_DELAY`)。押すと、離しても出したままにする
   * - **指・キーボードは押すたびに開け閉めする。** 外を押すか Esc で閉じる (Esc は印へ戻る)
   * - 印は注意なら ⚠、書き換えの案内なら ⓘ。色は通知と同じ状態の色 (`-text` の側)
   *
   * 箱はメニューと同じ形 (`app.css` の `.menu`)。開け閉めは `popover` (`manual`。最前面に出る)、位置は CSS anchor positioning。
   * anchor positioning の無いブラウザでは印の下に JS で置く (`place`)
   */
  let { kind, text }: { kind: ChannelAlertKind; text: string } = $props();

  /** マウスが離れてから閉じるまで。印と箱の間の 4px を渡る間に消さない */
  const LEAVE_DELAY = 300;

  const uid = $props.id();
  const popId = `alert-${uid}`;
  const anchor = `--${popId}`;
  const anchorSupported =
    typeof CSS !== "undefined" && CSS.supports("position-area", "top");

  let open = $state(false);
  /** 押して開いた (マウスが離れても閉じない) */
  let pinned = $state(false);
  let button = $state<HTMLButtonElement | null>(null);
  let pop = $state<HTMLElement | null>(null);
  let leaving: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if (pop === null) return;
    const shown = pop.matches(":popover-open");
    if (open && !shown) {
      pop.showPopover();
      place();
    } else if (!open && shown) pop.hidePopover();
  });

  /** 開いている間: 外を押したら閉じる・Esc で閉じて印へ戻る・画面が動いたら置き直す */
  $effect(() => {
    if (!open) return;
    const onpointerdown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (pop?.contains(target) || button?.contains(target))
      )
        return;
      close();
    };
    const onkey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      const inside = pop?.contains(document.activeElement) ?? false;
      close();
      if (inside) button?.focus();
    };
    window.addEventListener("pointerdown", onpointerdown, true);
    document.addEventListener("keydown", onkey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("pointerdown", onpointerdown, true);
      document.removeEventListener("keydown", onkey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  });

  $effect(() => () => clearTimeout(leaving));

  function close(): void {
    clearTimeout(leaving);
    open = false;
    pinned = false;
  }

  function onenter(event: PointerEvent): void {
    if (event.pointerType !== "mouse") return;
    clearTimeout(leaving);
    open = true;
  }

  function onleave(event: PointerEvent): void {
    if (event.pointerType !== "mouse" || pinned) return;
    clearTimeout(leaving);
    leaving = setTimeout(() => {
      if (!pinned) open = false;
    }, LEAVE_DELAY);
  }

  /** 押したら、乗せて出ていたものは出したままにし、出したままのものは閉じる */
  function onclick(): void {
    clearTimeout(leaving);
    if (open && pinned) {
      close();
      return;
    }
    open = true;
    pinned = true;
  }

  /** anchor positioning の無いブラウザだけ、印の下に置く (左端をそろえ、画面からはみ出すなら内へ) */
  function place(): void {
    if (anchorSupported || pop === null || button === null) return;
    if (!pop.matches(":popover-open")) return;
    const at = button.getBoundingClientRect();
    const width = pop.offsetWidth;
    const room = document.documentElement.clientWidth;
    pop.style.setProperty("inset", "auto");
    pop.style.setProperty("margin", "0");
    pop.style.setProperty("top", `${at.bottom + 4}px`);
    pop.style.setProperty(
      "left",
      `${Math.max(4, Math.min(at.left, room - 4 - width))}px`,
    );
  }
</script>

<button
  bind:this={button}
  type="button"
  class="button ghost alert-mark {kind}"
  aria-label={CHANNEL_ALERT_LABEL[kind]}
  aria-expanded={open}
  aria-controls={popId}
  style="anchor-name: {anchor}"
  data-testid="channel-alert"
  {onclick}
  onpointerenter={onenter}
  onpointerleave={onleave}
>
  <Icon icon={kind === "ground" ? TriangleAlert : Info} size="size-5" />
</button>
<div
  bind:this={pop}
  id={popId}
  popover="manual"
  role="dialog"
  tabindex="-1"
  aria-label={CHANNEL_ALERT_LABEL[kind]}
  class="menu alert-pop"
  style="position-anchor: {anchor}"
  data-side="bottom"
  data-align="start"
  data-testid="channel-alert-text"
  onpointerenter={onenter}
  onpointerleave={onleave}
>
  <p>{text}</p>
  <a
    href={`${resolve("settings/reception")}#channels`}
    class="button small"
    onclick={close}>{CHANNEL_NOTICE_ACTION[kind]}</a
  >
</div>

<style>
  /* 押す場所はヘッダーのほかのボタンと同じ高さ (44px)。アイコンは状態の色 */
  .alert-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.75rem;
    min-height: 2.75rem;
    margin: 0;
    padding: 0;
  }
  .alert-mark.ground {
    color: var(--dp-warn-text);
  }
  .alert-mark.changed {
    color: var(--dp-info-text);
  }
  /* 文は読める幅で折り返す。ボタンは右下 (ダイアログと同じ) */
  .alert-pop {
    width: max-content;
    max-width: min(24rem, calc(100vw - 2rem));
    gap: var(--dp-space-2);
  }
  .alert-pop p {
    margin: 0;
    padding: var(--dp-space-2) var(--dp-space-3) 0;
    font-size: var(--dp-text-sm);
  }
  .alert-pop .button {
    align-self: flex-end;
    margin: 0;
  }
</style>
