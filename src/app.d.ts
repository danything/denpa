/**
 * SvelteKit に渡す型。
 *
 * `locals` はリクエストの間だけ持ち回るもの。OIDC でログインしている人が
 * 居れば `hooks.server.ts` が入れる (居なければ undefined)。
 *
 * `~icons/*` (unplugin-icons。`vite.config.ts`) は Svelte の部品として読む
 */
import 'unplugin-icons/types/svelte';

declare global {
    namespace App {
        interface Locals {
            user?: { subject: string; name: string };
            /** アプリの鍵 (`Authorization: Bearer`) で入ったときの鍵の ID (device-auth.ts) */
            token?: number;
        }
    }
}
