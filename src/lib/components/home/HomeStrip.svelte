<script lang="ts">
    /**
     * **サイドバーの無い幅 (1000px 未満) の、一覧の頭の帯。** 「続きから観る」のポスターを横に流せる帯と、
     * 「見てほしいこと」の1行 (押すと一覧をそれで絞る)。どちらも無ければ出さない。
     * 帯は畳める (`<details>`。開け閉めはブラウザに任せ、指でも押せる高さの見出し)
     */
    import Icon from '#lib/components/player/Icon.svelte';
    import type { Filter } from '#lib/timeline.js';
    import ChevronRight from '~icons/lucide/chevron-right';
    import { home, type Rec, watchLeft } from './context';
    import Poster from './Poster.svelte';

    let {
        watchNext,
        attention,
        setFilter,
    }: {
        watchNext: Rec[];
        attention: number;
        setFilter: (next: Filter) => void;
    } = $props();
    const ctx = home();
</script>

{#if watchNext.length > 0 || attention > 0}
    <div class="t-strip" data-testid="home-strip">
        {#if attention > 0}
            <button type="button" class="t-attention" onclick={() => setFilter('attention')} data-testid="strip-attention">
                <span class="rec-dot" aria-hidden="true"></span>
                見てほしいこと <span class="num">{attention}件</span>
                <Icon icon={ChevronRight} size="size-4" />
            </button>
        {/if}
        {#if watchNext.length > 0}
            <details class="t-watch" open>
                <summary>続きから観る <span class="num muted">{watchNext.length}</span></summary>
                <ul class="t-watch-list">
                    {#each watchNext as rec (rec.id)}
                        <li>
                            <a class="t-watch-item" href={ctx.watchLink(rec)} data-testid="strip-continue-item">
                                <span class="a-poster" aria-hidden="true">
                                    {#if rec.library_path !== null}<Poster id={rec.id} />{/if}
                                    {#if rec.progress !== null && rec.progress.length > 0}
                                        <span class="t-resume"
                                            ><span
                                                class="resume-fill"
                                                style="width: {Math.min(1, rec.progress.at / rec.progress.length) * 100}%"
                                            ></span></span
                                        >
                                    {/if}
                                </span>
                                <span class="a-title broadcast">{rec.name}</span>
                                <span class="a-sub num">{watchLeft(rec)}</span>
                            </a>
                        </li>
                    {/each}
                </ul>
            </details>
        {/if}
    </div>
{/if}
