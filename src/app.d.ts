/**
 * SvelteKit に渡す型。
 *
 * `locals` はリクエストの間だけ持ち回るもの。OIDC でログインしている人が
 * いれば `hooks.server.ts` が入れる (いなければ undefined)。
 *
 * `~icons/*` (unplugin-icons。`vite.config.ts`) は Svelte の部品として読む
 */
import "unplugin-icons/types/svelte";

declare global {
  interface ImportMetaEnv {
    /** 組んだときの Denpa Font の版 (`vite.config.ts` が Dockerfile から埋める。`#lib/font.ts`) */
    readonly DENPA_FONT_VERSION?: string;
  }
  namespace App {
    interface Locals {
      user?: { subject: string; name: string };
      /** アクセストークン (`Authorization: Bearer`) で入ったときの、そのアクセストークンの ID (device-auth.ts) */
      token?: number;
    }
    interface PageState {
      /** 舞台を広げた (iPhone の全画面の代わり) ときに積む段 (`player/fullscreen.svelte.ts`) */
      fullscreen?: boolean;
    }
  }
}
