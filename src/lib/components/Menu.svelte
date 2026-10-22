<script lang="ts" module>
    /** 引き金のボタンに付ける属性。呼び出し側は `<button {...props}>` とそのまま広げる */
    export interface MenuTrigger {
        id: string;
        popovertarget: string;
        'aria-haspopup': 'menu' | undefined;
        'aria-expanded': boolean;
        'aria-controls': string;
        style: string;
        onpointerdown: () => void;
        onkeydown: (event: KeyboardEvent) => void;
    }

    /** CSS anchor positioning が使えるか。使えないブラウザでは位置を JS で決める */
    const anchorSupported = typeof CSS !== 'undefined' && CSS.supports('position-area', 'top');

    /**
     * **外を押した押下を、閉じるだけにして下へ渡さない。** pointerdown を止め、同じ押下の
     * mousedown (フォーカスの移動・文字の選択)・pointerup・mouseup・click も止める。
     * メニューはもう閉じているので、ここだけは閉じた後も click (か次の押下・キー入力) まで残る
     */
    function swallowPress(first: PointerEvent): void {
        first.preventDefault();
        first.stopPropagation();
        const types = ['mousedown', 'pointerup', 'mouseup', 'click'] as const;
        const stop = (event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            if (event.type === 'click') done();
        };
        const done = () => {
            for (const type of types) window.removeEventListener(type, stop, true);
            window.removeEventListener('pointercancel', done, true);
            window.removeEventListener('pointerdown', done, true);
            window.removeEventListener('keydown', done, true);
        };
        for (const type of types) window.addEventListener(type, stop, true);
        // 指で巻き取って押下が取り消されたら、そこで外す。押したまま動かして click が来なかったときは、
        // 次の押下かキー入力で外す (そちらは止めない)
        window.addEventListener('pointercancel', done, true);
        window.addEventListener('pointerdown', done, true);
        window.addEventListener('keydown', done, true);
    }
</script>

<script lang="ts">
    import type { Snippet } from 'svelte';

    /**
     * **開いたり閉じたりするメニュー。** 画面のメニューはどれもこれ1つで作る
     * (録画の「その他…」・見出しの「⋯」・映像の上の選択肢・狭い画面のナビ)。
     *
     * 枠はブラウザの `popover` (`manual`)。最前面 (top layer) に出るので、後ろの行が透けたり
     * (#481)、全画面の舞台に隠れたりしない。引き金は `popovertarget` で結ぶので、
     * **ハイドレーション前でも開く**。
     *
     * **外を押したら閉じるだけで、その押下は下へ渡さない** (`swallowPress`)。`auto` の
     * light dismiss に任せると、閉じると同時に下のボタンにも届く (録画の詳細で背景を押すと
     * 詳細まで閉じる)。引き金は外に数えないので、押せば今までどおり開け閉めする。
     *
     * 位置は CSS anchor positioning (`app.css` の `.menu`)。**枠に収めたいとき (`boundary`) と、
     * anchor positioning の無いブラウザでは JS で置く** (`place`)。
     *
     * キーボード: 引き金で Enter / Space / ↓ (↑ なら末尾から)、中は ↑↓・Home・End で動き、
     * Enter で選ぶ (項目は `<button>` / `<a>`)、Esc で閉じて引き金へ戻る。
     *
     * **項目には `menu-item` の class を付ける** (↑↓で辿る先・見た目)。`role="menuitem"` も
     * 呼び出し側が付ける。押せない項目は `data-disabled` と `aria-disabled="true"`、
     * 押しても閉じない項目 (送り終えてから閉じるフォーム) は `data-keep-open`
     */
    let {
        open = $bindable(false),
        trigger,
        children,
        side = 'bottom',
        align = 'start',
        boundary,
        nav = false,
        lazy = false,
        class: className = '',
        testid,
    }: {
        open?: boolean;
        /** 引き金。渡される属性を `<button>` に広げる */
        trigger: Snippet<[MenuTrigger]>;
        children: Snippet;
        /** 引き金のどちら側に出すか。入りきらなければ反対側へ */
        side?: 'top' | 'bottom';
        /** 引き金のどちら端に揃えるか */
        align?: 'start' | 'end';
        /** この枠の中に収める (映像の舞台)。無ければ画面 */
        boundary?: (() => HTMLElement | null) | undefined;
        /**
         * リンクを並べるだけのナビ。`menu` と読ませず (role を付けない)、Tab でそのまま外へ出られる
         */
        nav?: boolean;
        /**
         * 中身を開くまで作らない (`filled`)。一覧の行ごとに置くメニュー用 — 開かないメニューの中身まで、
         * 一覧を開いた瞬間に作らないように。中身の状態を開く前から読むメニュー (⚙ など) では使わない
         */
        lazy?: boolean;
        class?: string;
        testid?: string | undefined;
    } = $props();

    const uid = $props.id();
    const menuId = `menu-${uid}`;
    const triggerId = `${menuId}-trigger`;
    const anchor = `--${menuId}`;
    // ナビには role を付けない。menu なら引き金の名前で読ませる
    const menuRole = $derived(nav ? {} : { role: 'menu', 'aria-labelledby': triggerId });

    let content = $state<HTMLElement | null>(null);
    /**
     * 中身を作ったか。`lazy` なら**開くまで作らない** — 一覧の行ごとにメニューがあると、開かないメニューの中身 (項目とアイコン) まで
     * 開いた瞬間に作ることになり、ホームが一コマ重くなっていた。開きそうになったら (押し始め・キー・開けと言われた) 作り、
     * 一度作ったら残す (閉じるたびに作り直さない)
     */
    // svelte-ignore state_referenced_locally
    let filled = $state(!lazy);
    /** 指やマウスで開いたか。キーボードで開いたときだけ先頭の項目に入る (WAI-ARIA の menu button) */
    let byPointer = false;
    /** ↑で開いたら末尾の項目に入る */
    let fromEnd = false;

    function triggerElement(): HTMLElement | null {
        return document.getElementById(triggerId);
    }

    function items(): HTMLElement[] {
        return content === null ? [] : [...content.querySelectorAll<HTMLElement>('.menu-item:not([data-disabled])')];
    }

    /** `open` を枠に写す (呼び出し側が閉じることもある。送り終えたときなど) */
    $effect(() => {
        if (content === null) return;
        const shown = content.matches(':popover-open');
        if (open && !shown) {
            filled = true;
            content.showPopover();
        }
        else if (!open && shown) content.hidePopover();
    });

    /** 枠の開け閉めを `open` に写す */
    $effect(() => {
        const element = content;
        if (element === null) return;
        const ontoggle = (event: Event) => {
            const shown = (event as ToggleEvent).newState === 'open';
            open = shown;
            if (shown) {
                place();
                const list = items();
                const target = byPointer ? element : fromEnd ? list.at(-1) : list[0];
                (target ?? element).focus({ preventScroll: true });
            } else {
                // 中にいたフォーカスは引き金へ戻す。外の別のものを押して閉じたときは、そちらに任せる
                const active = document.activeElement;
                if (active === null || active === document.body || element.contains(active)) {
                    triggerElement()?.focus({ preventScroll: true });
                }
            }
            byPointer = false;
            fromEnd = false;
        };
        const onbefore = (event: Event) => {
            if ((event as ToggleEvent).newState === 'open') filled = true;
        };
        element.addEventListener('beforetoggle', onbefore);
        element.addEventListener('toggle', ontoggle);
        return () => {
            element.removeEventListener('beforetoggle', onbefore);
            element.removeEventListener('toggle', ontoggle);
        };
    });

    /**
     * 開いている間: 外を押したら閉じる・Esc で閉じる・画面が動いたら置き直す。
     *
     * **Esc はこちらで受けて `preventDefault` する。** ブラウザの popover に任せると keydown が
     * 素通りして、舞台の全画面 (`fullscreen.svelte.ts`) まで一緒に閉じてしまう
     */
    $effect(() => {
        if (!open) return;
        const onpointerdown = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Node && (content?.contains(target) || triggerElement()?.contains(target))) return;
            swallowPress(event);
            open = false;
        };
        const onkey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            event.preventDefault();
            open = false;
        };
        // メニューの中を巻き取ったときは置き直さない (測り直しで `max-height` を外すと、巻き取った位置が先頭に戻る)
        const update = (event: Event) => {
            if (event.target instanceof Node && content?.contains(event.target)) return;
            place();
        };
        // 中身が入れ替わったら置き直す (⚙ の選択肢の並びに入ると高さが変わる)。**置いた直後の大きさと同じなら何もしない** —
        // 置き直しが `max-height` を書き換えたぶんで、また置き直すことを繰り返さない
        const resized = new ResizeObserver(() => {
            if (content !== null && sizeOf(content) !== placed) place();
        });
        if (content !== null) resized.observe(content);
        window.addEventListener('pointerdown', onpointerdown, true);
        document.addEventListener('keydown', onkey);
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, true);
        return () => {
            resized.disconnect();
            window.removeEventListener('pointerdown', onpointerdown, true);
            document.removeEventListener('keydown', onkey);
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', update, true);
        };
    });

    /** 最後に置いたときの大きさ (`幅x高さ`)。中身の大きさが変わったかを見るのに使う */
    let placed = '';
    function sizeOf(element: HTMLElement): string {
        return `${element.offsetWidth}x${element.offsetHeight}`;
    }

    const GAP = 4;
    const PADDING = 4;

    /**
     * **JS で置く。** 収める枠 (`boundary`) があるときと、anchor positioning の無いブラウザだけ。
     * 指定の側に入りきらず反対側のほうが広ければ反対へ出し、入らないぶんは中を巻き取る (`max-height`)。
     * 横は揃えた端から始め、枠からはみ出すなら内へずらす
     */
    function place(): void {
        const element = content;
        if (element === null || !element.matches(':popover-open')) return;
        const area = boundary?.() ?? null;
        const style = element.style;
        if (area === null && anchorSupported) {
            for (const name of ['position-area', 'position-try-fallbacks', 'inset', 'margin', 'top', 'left', 'min-width', 'max-height']) {
                style.removeProperty(name);
            }
            placed = sizeOf(element);
            return;
        }
        const button = triggerElement();
        if (button === null) return;
        const scrolled = element.scrollTop;
        const at = button.getBoundingClientRect();
        const root = document.documentElement;
        const box = area?.getBoundingClientRect() ?? new DOMRect(0, 0, root.clientWidth, root.clientHeight);

        style.setProperty('position-area', 'none');
        // 入りきらないときに反対へ出すのはここで決める。CSS の `flip-block` を残すと、JS で置いた上下の位置を
        // ブラウザがさらに裏返して、枠の外 (画面の下端) へ出していた (狭い枠で ⚙ の行が増えたとき)
        style.setProperty('position-try-fallbacks', 'none');
        style.setProperty('inset', 'auto');
        style.setProperty('margin', '0');
        style.setProperty('top', '0');
        style.setProperty('left', '0');
        style.setProperty('min-width', `${at.width}px`);
        style.removeProperty('max-height');
        const width = element.offsetWidth;
        const height = element.offsetHeight;

        const above = at.top - GAP - (box.top + PADDING);
        const below = box.bottom - PADDING - (at.bottom + GAP);
        let up = side === 'top';
        if (up && height > above && below > above) up = false;
        else if (!up && height > below && above > below) up = true;
        const room = Math.max(0, up ? above : below);
        const shown = Math.min(height, room);
        const top = up ? at.top - GAP - shown : at.bottom + GAP;

        const wanted = align === 'start' ? at.left : at.right - width;
        const left = Math.max(box.left + PADDING, Math.min(wanted, box.right - PADDING - width));

        style.setProperty('max-height', `${room}px`);
        style.setProperty('top', `${top}px`);
        style.setProperty('left', `${left}px`);
        element.scrollTop = scrolled;
        placed = sizeOf(element);
    }

    function onTriggerKey(event: KeyboardEvent): void {
        filled = true;
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        fromEnd = event.key === 'ArrowUp';
        if (open) {
            const list = items();
            (fromEnd ? list.at(-1) : list[0])?.focus();
            fromEnd = false;
        } else {
            open = true;
        }
    }

    function onkeydown(event: KeyboardEvent): void {
        const list = items();
        if (list.length === 0) return;
        const at = list.indexOf(document.activeElement as HTMLElement);
        let next: HTMLElement | undefined;
        switch (event.key) {
            case 'ArrowDown':
                next = list[(at + 1) % list.length];
                break;
            case 'ArrowUp':
                next = list[at <= 0 ? list.length - 1 : at - 1];
                break;
            case 'Home':
                next = list[0];
                break;
            case 'End':
                next = list.at(-1);
                break;
            case 'Tab':
                // menu の中では Tab で動かさない (↑↓で動く)。ナビはそのまま外へ出す
                if (!nav) event.preventDefault();
                return;
            default:
                return;
        }
        event.preventDefault();
        next?.focus();
    }

    /** 項目を押したら閉じる。押せない項目と、送り終えてから閉じる項目 (`data-keep-open`) はそのまま */
    function onclick(event: MouseEvent): void {
        const item = (event.target as Element).closest('.menu-item');
        if (item === null || item.hasAttribute('data-disabled') || item.hasAttribute('data-keep-open')) return;
        open = false;
    }

    /** マウスを乗せた項目にフォーカスを移す (↑↓と同じ見た目になる)。外れたら枠へ */
    function onpointermove(event: PointerEvent): void {
        if (event.pointerType !== 'mouse') return;
        const item = (event.target as Element).closest<HTMLElement>('.menu-item:not([data-disabled])');
        if (item !== null && item !== document.activeElement) item.focus({ preventScroll: true });
    }

    function onpointerleave(event: PointerEvent): void {
        if (event.pointerType === 'mouse' && content?.contains(document.activeElement)) {
            content.focus({ preventScroll: true });
        }
    }
</script>

{@render trigger({
    id: triggerId,
    popovertarget: menuId,
    'aria-haspopup': nav ? undefined : 'menu',
    'aria-expanded': open,
    'aria-controls': menuId,
    style: `anchor-name: ${anchor}`,
    onpointerdown: () => {
        byPointer = true;
        filled = true;
    },
    onkeydown: onTriggerKey,
})}
<div
    bind:this={content}
    id={menuId}
    popover="manual"
    {...menuRole}
    tabindex="-1"
    class="menu {className}"
    style="position-anchor: {anchor}"
    data-side={side}
    data-align={align}
    data-testid={testid}
    {onkeydown}
    {onclick}
    {onpointermove}
    {onpointerleave}
>
    {#if filled}{@render children()}{/if}
</div>
