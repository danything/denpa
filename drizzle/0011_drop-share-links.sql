-- 再生リンク (ログインせずに録画を開ける期限付きの URL) をやめた。控え (share_links) をテーブルごと消す。出したリンクはこれで開けなくなる (docs/app.md「再生リンクをやめた」)
DROP TABLE `share_links`;