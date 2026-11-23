-- 字幕のインデックス (schema.ts の CAPTION_FTS。caption-index.ts)。drizzle の表として書けない (FTS5 の仮想表) ので手で書く。
-- 中身は持たず (caption_lines が持つ)、揃えた字幕を 2 字ずつ区切って空白でつないだもの (caption-key.captionGrams) だけを入れる。
-- 空白と制御文字のほかは全部を語の字にする (句読点・記号・まだ割り当てのない字も)。区切ったものの 1 つが、そのまま 1 つの語になる。
-- contentless_delete は使わない (SQLite 3.43 から。Mac の bun は OS の SQLite を読む)。消すときは 'delete' に入れたものを渡し直す
CREATE VIRTUAL TABLE `caption_fts` USING fts5(`grams`, content='', tokenize="unicode61 remove_diacritics 0 categories 'L* N* M* P* S* Co Cn'");
