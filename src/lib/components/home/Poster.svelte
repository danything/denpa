<script lang="ts" module>
    import { fadeIn } from '#lib/motion.svelte.js';

    /**
     * ポスターに付ける (`{@attach}`)。読み込めたらふわっと出し (`fadeIn`)、読めなかったら隠して枠だけ残す
     * (ポスターの無い録画もある)。ハイドレーションの前に失敗していたらイベントはもう来ないので、付けた時点の様子も見る。
     *
     * **`use:` や `onerror` にしない。** `<img>` にそれを書くと、Svelte はサーバの HTML に
     * `onerror="this.__e=event"` を足す (ハイドレーション前のイベントを拾うため)。インラインのハンドラなので
     * CSP に止められる (`script-src-attr`)。`{@attach}` には足さない
     */
    function poster(img: HTMLImageElement): () => void {
        fadeIn(img);
        const hide = () => {
            img.style.display = 'none';
        };
        if (img.complete && img.naturalWidth === 0 && img.currentSrc !== '') hide();
        img.addEventListener('error', hide);
        return () => img.removeEventListener('error', hide);
    }
</script>

<script lang="ts">
    import { resolve } from '$app/paths';

    /** 録画のポスター (`api/recordings/<id>/poster` = エンコードしたときの `-poster.jpg`) */
    let { id }: { id: number } = $props();
</script>

<!-- 読めなければ画像を隠して枠だけ残す (`poster`) -->
<img src={resolve(`api/recordings/${id}/poster`)} alt="" loading="lazy" class="poster-img" {@attach poster} />
