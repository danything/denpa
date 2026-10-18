<script lang="ts">
    import Toasts, { errorNotice, type Notice } from '#lib/components/Toasts.svelte';
    import { liveUpdates } from '#lib/live-updates.svelte.js';
    import Migrate from './Migrate.svelte';
    import Notifications from './Notifications.svelte';
    import Tv from './Tv.svelte';

    let { data, form } = $props();

    // 引き継ぎの進み具合はサーバから流れてくる
    liveUpdates(['migrate']);

    /** 押した結果は画面で1か所に出す。引き継ぎの進み具合そのものは、その節の中に出したまま */
    const notices = $derived.by(() => {
        const list: Notice[] = [];
        list.push(...errorNotice(form, 'settings-error'));
        if (form?.webhookAdded) list.push({ key: 'webhook-added', kind: 'success', text: '通知先を追加しました' });
        if (form?.tested) {
            list.push({
                key: 'webhook-tested',
                kind: form.tested === 'ok' ? 'success' : 'error',
                // 届いたら `ok` が返る (`server/webhook.ts`)。英語のまま出さない
                text: form.tested === 'ok' ? 'テスト送信が届きました' : `テスト送信に失敗しました: ${form.tested}`,
            });
        }
        if (form?.migrate) list.push({ key: 'migrate-started', kind: 'info', text: form.migrate });
        return list;
    });
</script>

<Toasts {notices} source={form} />

<!-- 節の並びと名前は `#lib/settings-sections.ts`。`id` は左の一覧から飛ぶ先 -->
<div class="part" id="notifications" data-part><Notifications {data} /></div>
<div class="part" id="tv" data-part><Tv {data} /></div>
<div class="part" id="migrate" data-part><Migrate {data} /></div>
