/**
 * コンポーネントが <script> で読む Pico の部品 (`@anyblades/blades/layered/*`。`app.css` の頭)。
 * 中身は CSS だけで、行き先が `.css` で終わらないので、何も出さないモジュールとして型を付ける
 * (付けないと、読むだけの import を TypeScript が「見つからない」と止める)
 */
declare module "@anyblades/blades/layered/*";
