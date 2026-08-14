import { fail } from '@sveltejs/kit';
import { BASIC_AUTH_USER, generatePassword } from '$lib/server/auth';
import { isCmMode } from '$lib/server/cm';
import { database, now, queryAll, queryOne } from '$lib/server/db';
import { available as migrateAvailable, source, start, status } from '$lib/server/migrate';
import { enabled as oidcEnabled } from '$lib/server/oidc';
import { normalizePostalCode, saveSettings, settings } from '$lib/server/settings';
import { serializeTargets, targets, type VlcTarget } from '$lib/server/vlc';
import { send, type Webhook } from '$lib/server/webhook';
import type { VideoCodec } from '$lib/types';
import { normalizeVlcHost } from '$lib/vlc-host';
import { EVENTS } from '$lib/webhook-events';

export function load() {
    const current = settings();
    return {
        recording: current,
        /** データ放送に渡すもの。いまは郵便番号だけ */
        broadcast: { postalCode: current.postalCode, bmlNetwork: current.bmlNetwork },
        /** テレビの VLC の居場所。画面は名前+ホストの行として編集する */
        vlc: { targets: targets() },
        auth: {
            user: current.basicAuthUser,
            /*
             * パスワードそのものを返す。
             *
             * プレイヤーに登録するときに必要になるが、覚えていないと入れ直すしかなく、
             * 入れ直せば既に登録した端末が全部つながらなくなる。
             *
             * 隠す意味も薄い。**この画面まで来られている時点で持っている人**
             * (ベーシック認証か OIDC のどちらかを通っている)
             */
            password: current.basicAuthPassword,
            /** OIDC があるなら画面はそちらが守っている。説明の書き分けに使う */
            oidc: oidcEnabled(),
        },
        webhooks: queryAll<Webhook>('SELECT * FROM webhooks ORDER BY id'),
        events: EVENTS,
        migrate: {
            available: migrateAvailable(),
            source: source.recordedDir,
            status: status(),
        },
    };
}

export const actions = {
    /**
     * ベーシック認証。**掛かる範囲は選べない** — 掛けたら全部に掛かる
     * (OIDC を設定してあるところだけ、画面はそちらに譲る)。
     *
     * **空にはできない。** 空にすると録画のファイルが誰でも取れる状態になり、
     * しかもそうなったことが画面から分からない。消したいなら作り直す
     */
    saveAuth: async ({ request }) => {
        const form = await request.formData();
        const password = String(form.get('basicAuthPassword') ?? '');
        if (password === '') return fail(400, { message: 'パスワードは空にできません' });

        // ユーザー名は denpa 固定 (画面から変えられない)
        saveSettings({ basicAuthUser: BASIC_AUTH_USER, basicAuthPassword: password });
        return { success: true, saved: true };
    },

    /**
     * パスワードを作り直して、そのまま保存する。
     *
     * 考えて決めるものではないし、入れたのに保存を忘れると
     * 「掛けたつもりで掛かっていない」になる。1回の操作で終わらせる。
     */
    newPassword: () => {
        const password = generatePassword();
        saveSettings({ basicAuthUser: BASIC_AUTH_USER, basicAuthPassword: password });
        /*
         * **ログにも出す。** 画面にもベーシック認証が掛かっているので、作り直した
         * 瞬間から**その端末は入れなくなる** (ブラウザが持っているのは古いほう)。
         * 新しいものを受け取る道が画面しか無いと、押した本人が締め出される
         */
        console.log(`[auth] パスワードを作り直しました: ${BASIC_AUTH_USER} / ${password}`);
        return { success: true, saved: true };
    },

    /** 録画のしかた。番組ごとに変えたくなることが実際にはほとんど無いので全体で1つ */
    saveRecording: async ({ request }) => {
        const form = await request.formData();
        /*
         * **コーデックは複数選べる** (`av1` / `h264` を両方)。1つも選ばなければ
         * 「エンコードしない」。カンマ区切りで持ち、`encode` も一緒に合わせて
         * 書く — 古いDBに残っている `encode=false` を確実に上書きするため
         */
        const codecs = form
            .getAll('codecs')
            .map(String)
            .filter((c): c is 'av1' | 'h264' => c === 'av1' || c === 'h264');
        const cmCut = String(form.get('cmCut') ?? '');
        if (!isCmMode(cmCut)) {
            return fail(400, { message: 'CMの指定が不正です' });
        }
        saveSettings({
            // AV1 を先頭に寄せる (settings() が主を決めるときの順序と揃える)
            codec: (codecs.length > 0 ? codecs.join(',') : 'none') as VideoCodec,
            encode: codecs.length > 0,
            cmCut,
            cmDetector: form.get('cmDetector') === 'silence' ? 'silence' : 'jls',
            logoLevel: Number(form.get('logoLevel')),
            keepOriginal: form.get('keepOriginal') === 'on',
            freeOnly: form.get('freeOnly') === 'on',
            fpsDetect: form.get('fpsDetect') === 'on',
        });
        return { success: true, saved: true };
    },

    /**
     * データ放送に渡す郵便番号。
     *
     * **空にできる** (「渡さない」という選択)。ベーシック認証と違って、
     * 空にしても危なくない — 放送のアプリが地域を決められなくなるだけ
     */
    saveBroadcast: async ({ request }) => {
        const form = await request.formData();
        const raw = String(form.get('postalCode') ?? '').trim();
        const postalCode = normalizePostalCode(raw);
        if (raw !== '' && postalCode === '') {
            return fail(400, { message: '郵便番号は数字7桁で入れてください (例 1000001)' });
        }
        saveSettings({ postalCode, bmlNetwork: form.get('bmlNetwork') === 'on' });
        return { success: true, saved: true };
    },

    /**
     * テレビの VLC の居場所。画面からは**名前+IP+ポート+コーデックの行**で来る
     * (vlcName / vlcIp / vlcPort / vlcCodec の同順の配列)。DBには
     * `名前=ホスト:ポート#コーデック` のカンマ区切りで置く (serializeTargets) —
     * 名前とコーデックは略せるので、古いDBの `名前=ホスト:ポート` もそのまま読める。
     * 全部外して保存すれば空にできる — 「テレビで再生」ボタンが出なくなるだけ
     */
    saveVlc: async ({ request }) => {
        const form = await request.formData();
        const names = form.getAll('vlcName').map(String);
        const ips = form.getAll('vlcIp').map(String);
        const ports = form.getAll('vlcPort').map(String);
        const codecs = form.getAll('vlcCodec').map(String);
        const list: VlcTarget[] = [];
        for (const [i, rawIp] of ips.entries()) {
            /*
             * IPの欄は貼り付けも受ける (http:// 剥がし等は normalizeVlcHost)。
             * `IP:ポート` ごと貼っても読めるが、ポートの欄に入れた値が勝つ。
             * ポートを空にしたら VLC の既定 (8080、normalizeVlcHost が補う)
             */
            const base = normalizeVlcHost(rawIp);
            // IPの無い行 (名前だけ・空行) と、読めないポートの行は黙って落とす
            if (base === '') continue;
            const port = (ports[i] ?? '').trim();
            if (port !== '' && !/^\d{1,5}$/.test(port)) continue;
            const host = port === '' ? base : `${base.split(':')[0]}:${port}`;
            // 同じテレビを2行入れても1つに。録画詳細の {#each} がホストを
            // 鍵にしているので、重複したまま保存すると一覧が描けなくなる
            if (list.some((t) => t.host === host)) continue;
            // `,` `=` `#` は保存の書式の区切り。名前に混ざると読み直せない
            const name = (names[i] ?? '').trim().replace(/[,=#]/g, '');
            const codec = codecs[i];
            list.push({
                name: name === '' ? host : name,
                host,
                codec: codec === 'h264' || codec === 'ts' ? codec : 'auto',
            });
        }
        saveSettings({ vlcTargets: serializeTargets(list) });
        return { success: true, saved: true };
    },

    addWebhook: async ({ request }) => {
        const form = await request.formData();
        const url = String(form.get('url') ?? '').trim();
        if (!/^https?:\/\//.test(url)) {
            return fail(400, { message: 'http(s) で始まるURLを入力してください' });
        }
        // 何も選ばなければ全部の通知を受け取る
        const events = form.getAll('events').map(String).filter(Boolean);

        database()
            // name は廃止したが、既存DBの列が NOT NULL のままなので空文字を入れる。
            // CREATE TABLE IF NOT EXISTS では列定義が変わらないため
            .prepare('INSERT INTO webhooks (name, url, events, enabled, created_at) VALUES (?, ?, ?, 1, ?)')
            .run('', url, JSON.stringify(events), now());
        return { success: true, webhookAdded: true };
    },

    toggleWebhook: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'IDが不正です' });
        database().prepare('UPDATE webhooks SET enabled = 1 - enabled WHERE id = ?').run(id);
        return { success: true };
    },

    deleteWebhook: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'IDが不正です' });
        database().prepare('DELETE FROM webhooks WHERE id = ?').run(id);
        return { success: true };
    },

    testWebhook: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        const webhook = queryOne<Webhook>('SELECT * FROM webhooks WHERE id = ?', id);
        if (webhook === undefined) return fail(400, { message: '通知先が見つかりません' });

        const status = await send(webhook, {
            event: 'recording.finished',
            text: 'denpa からのテスト送信です',
        });
        return { success: true, tested: status };
    },

    /**
     * EPGStation からの引き継ぎ。数百GBのコピーになるので開始だけ受けて裏で進める。
     * 進捗は SSE で降ってくる。
     */
    migrate: async ({ request }) => {
        const form = await request.formData();
        const options = { apply: form.get('apply') === 'on', move: form.get('move') === 'on' };
        const result = start(options);
        if (!result.started) return fail(409, { message: result.message });
        return { success: true, migrate: result.message };
    },
};
