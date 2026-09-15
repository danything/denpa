<!--
    ログアウトしたことを出すだけの画面。

    `/` へ戻すと SSO が効いている間は黙って入り直してしまい、出られたのかどうかが
    画面から読めない。ここで一度止めて、入り直すかどうかを人に決めさせる。
-->
<div class="wrap">
    <div class="panel card">
        <h1>ログアウトしました</h1>
        <p class="small muted">
            この端末のログイン情報は消しました。Microsoft からは出ていないので、
            入り直すときはパスワードを聞かれないことがあります。
        </p>
        <div class="card-actions">
            <a class="button" href="/login">もう一度ログイン</a>
        </div>
    </div>
</div>

<style>
    .wrap {
        display: flex;
        min-height: 60vh;
        align-items: center;
        justify-content: center;
        padding: 1rem;
    }
    .card {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        max-width: 24rem;
        padding: 2rem;
        text-align: center;
        box-shadow: 0 1px 3px rgb(0 0 0 / 0.2);
    }
    h1 {
        font-size: 1.25rem;
    }
    .card-actions {
        margin-top: 0.5rem;
    }
</style>
