<!--
    ログアウトしたことを出すだけの画面。

    `/` へ戻すと SSO が効いている間は黙って入り直してしまい、出られたのかどうかが
    画面から読めない。ここで一度止めて、入り直すかどうかを人に決めさせる。
-->

<script lang="ts">
  import { resolve } from "$app/paths";
</script>

<div class="solo">
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
