<!--
    ログアウトしたことを出すだけの画面 (`/` へ戻さない理由は `logout/+server.ts`)。
    入り直すかどうかは人に決めさせる
-->

<script lang="ts">
  import { resolve } from "$app/paths";
</script>

<div class="solo glow">
  <h1>ログアウトしました</h1>
  <p>
    この端末のログイン情報を消しました。ログイン先 (IdP)
    からはログアウトしていないので、
    次はパスワードを聞かれずにログインできることがあります。
  </p>
  <div class="actions">
    <a class="button" href={resolve("login")}>もう一度ログイン</a>
  </div>
</div>
