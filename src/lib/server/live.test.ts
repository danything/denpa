import { describe, expect, test } from "bun:test";

import {
  askedTrack,
  type AudioSide,
  audioTracks,
  pickTrack,
} from "#lib/arib.js";
import { CHANNEL, codecsFor } from "#lib/live.js";

import type { LiveHw } from "./hwenc";
import {
  audioArgs,
  blameLiveHw,
  CHASE_STREAM_HOLD,
  encodeArgs,
  EncodeLag,
  encodeSpeed,
  keepLight,
  key,
  type Light,
  LIGHT_LAG,
  lightNotices,
  LIVE_STREAM_BACKLOG,
  liveHwFailed,
  nextLight,
  openingLine,
  parseCommand,
  parsePlayable,
  rawEnding,
  rungCodec,
  rungPlan,
  rungSlot,
  sessionStream,
  softwareEncodes,
  takeLight,
  videoArgs,
  whyNotTuned,
} from "./live";

/** 1 本目の音声をそのまま。番組表が何も言っていないときの既定 */
const stereo = audioTracks([])[0]!;
/** デュアルモノの中から選ぶ。0=主音声 1=副音声 2=主+副 */
const dual = (side: AudioSide) => {
  const tracks = audioTracks([{ componentType: 2, langs: ["jpn", "eng"] }]);
  const found = tracks.find((track) => track.side === side);
  if (found === undefined) throw new Error(`デュアルモノに ${side} が無い`);
  return found;
};

/** 実写・ステレオ・NHK総合1 (T27 に 2 局入っている) */
const plain = () => encodeArgs(1024, stereo);

/**
 * **エンコード方法の指定は、間違えても映像は出る。** 出たうえで見づらいだけなので、
 * 気付くのに時間がかかる。実機で測って分かったものをここで固定する。
 */
describe("ライブのエンコード方法", () => {
  /*
   * **`-flags low_delay` を入れない。**
   *
   * `-i` より前に書くとエンコーダではなくデコーダに効く。放送の MPEG-2 には
   * B フレームがあるので、この指定を受けたデコーダは表示順ではなく復号順で
   * フレームを出し、1 枚進んでは戻るように見える。実測で隣り合うコマの差の比が
   * 2.17 → 1.11 に落ちた (素材のフィールドを直に測ると 1.02)。
   * エンコーダ側の遅れは `-tune zerolatency` が見ている。
   */
  test("デコーダに低遅延を指図しない", () => {
    expect(plain()).not.toContain("low_delay");
  });

  /*
   * **入口の解析で読んだぶんを捨てさせない。**
   *
   * `-fflags nobuffer` を付けると、解析 (`-probesize`) の間に読んだ I フレームを捨てて
   * 次の GOP を待つ。合成の TS を実時間で流し込むと、I フレームが頭から 40ms の位置で
   * 最初の moof が 781〜803ms → 外して 270〜291ms。1 秒ぶん出そろう時刻は変わらなかった
   * (遅れは増えない)。どの音声・コーデックでも同じ
   */
  test("入口の解析で読んだぶんを捨てさせない", () => {
    for (const codec of ["h264", "av1", "audio"] as const) {
      expect(encodeArgs(1024, stereo, codec)).not.toContain("nobuffer");
    }
  });

  /*
   * **入口の解析は小さくてよい。渡す前に 1 局へ絞るから。**
   *
   * ffmpeg は名指しした局を `-probesize` のぶん読む間に見つけられなければ、
   * **そのまま終了する**。実機の tvk (T15。tvk1/2/3 + ワンセグ + データで、
   * 局ごとに 14 本以上のストリーム) では 400KB でも足りず、
   * `Failed to set value '0:p:24632:v:0' for option 'map'` で降りていた。
   *
   * わざと probesize を下げて T15 で測ったもの (3 回ずつ):
   *
   *     20KB   丸ごと 0/3 通る   1 局に絞る 3/3
   *     50KB   丸ごと 0/3 通る   1 局に絞る 3/3
   *    120KB   丸ごと 1/3 通る   1 局に絞る 3/3
   *
   * 絞れば 20KB でも通る。映像だけをエンコードしていた頃はそこまで下げてあった
   * (6 回ずつ測ると 100KB は最短 474ms、20KB は最短 441ms で、33ms は固定の費用)。
   * **いまは 100KB に戻してある。** 同じ ffmpeg に**字幕まで見つけさせる**ので、
   * 映像だけのときの値では足りない
   */
  test("入口の解析は 100KB まで", () => {
    const args = plain();
    expect(args[args.indexOf("-probesize") + 1]).toBe("100000");
  });

  /*
   * **コマごとに切らない。** `frag_every_frame` だと映像だけ・音声だけの塊が
   * 交互に並び (トラックごとにコマの間隔が違うため)、受け側の MSE が
   * それぞれを別の区切りとして扱って映像と音声を別々に並べ直す。
   * 実機では毎秒 95 個出ていた。
   *
   * **細かさの下限は音声のコマが決める。** AAC は 1024 標本 = 約 21ms なので、
   * それより短く切ると音声の入らない塊が出る (実機で 16ms にすると
   * 塊あたりのトラック数が 1.94 → 1.74 に落ちた)
   */
  test("音声のコマより短く区切らない", () => {
    const args = plain();
    expect(args.join(" ")).not.toContain("frag_every_frame");
    const µs = Number(args[args.indexOf("-frag_duration") + 1]);
    expect(µs).toBeGreaterThanOrEqual(25_000);
    expect(µs).toBeLessThanOrEqual(200_000);
  });

  /*
   * **インタレは常に 60 コマでデコードする。** 放送は 1080i なので、デコードせずに渡すと
   * 動きのある場面が櫛状になる。録画と違い、ライブは映像が来る前に決める
   * しかないので、動きが絶対に落ちない側 (60) に倒す
   */
  test("インタレを 60 コマでデコードする", () => {
    const live = encodeArgs(1024, stereo);
    expect(live[live.indexOf("-vf") + 1]).toBe("bwdif");
  });

  /*
   * **局を名指しで選ぶ。** 1 つの物理チャンネルに複数の局が入っているので、
   * `0:v:0` は「最初に見つけた映像」でしかない。実機の T26 には Eテレ1/2/3 と
   * **ワンセグ** (320x180 の H.264) が並んでいて、それを選んでしまうこともある
   */
  test("選んだ局の中から映像と音声を採る", () => {
    const args = encodeArgs(1032, stereo);
    expect(args).toContain("0:p:1032:v:0");
    expect(args).toContain("0:p:1032:a:0");
  });

  /** 局が分からないときは従来どおり。**映像が出ないより、先頭の局のほうがまし** */
  test("局が分からなければ最初に見つけた映像を採る", () => {
    const args = encodeArgs(0, stereo);
    expect(args).toContain("0:v:0");
    expect(args).toContain("0:a:0");
  });

  /*
   * **二カ国語は左右に別の言語。** そのままステレオにすると両方同時に鳴る。
   * 録画は左右を 2 トラックに分けるが、こちらは出す音声トラックが 1 つなので選ばれた側を両耳へ。
   *
   * 右 (`c1`) を左右に配るのが副音声。**左右を取り違えると、選んだのと逆の
   * 言語が鳴る**。映像は出るので、気付くのは音を聞いたときだけ
   */
  test("二カ国語は選ばれた側だけを両耳へ", () => {
    const main = encodeArgs(1024, dual("main"));
    const sub = encodeArgs(1024, dual("sub"));
    expect(main[main.indexOf("-af") + 1]).toBe("pan=stereo|c0=c0|c1=c0");
    expect(sub[sub.indexOf("-af") + 1]).toBe("pan=stereo|c0=c1|c1=c1");
  });

  /** 「主+副」はテレビと同じで、左右から別の言語が同時に鳴る状態 */
  test("主+副はそのまま出す", () => {
    expect(encodeArgs(1024, dual("both"))).not.toContain("-af");
  });

  test("普通のステレオでは音をいじらない", () => {
    expect(plain()).not.toContain("-af");
  });

  /*
   * **音声が 2 本以上入っている放送では、0 が選ばれるとは限らない。**
   * 解説放送などは音声そのものが別に入っているので、何本目かを名指しする
   */
  test("2 本目の音声を選べる", () => {
    const tracks = audioTracks([
      { componentType: 3, langs: ["jpn"] },
      { componentType: 3, langs: ["eng"] },
    ]);
    const args = encodeArgs(1032, tracks[1]!);
    expect(args).toContain("0:p:1032:a:1");
    expect(args).not.toContain("0:p:1032:a:0");
  });

  /*
   * **`-copyts` は付けない。**
   *
   * 付けると放送の絶対時刻が mp4 の muxer まで届き、あれが 0 に詰め直すので
   * 受け側から見た 0 の意味が分からなくなる (実機では `next_dts` の assertion で
   * 落ちもした)。付けなければ ffmpeg が入口で 1 回だけ 0 に寄せ、**その寄せが
   * 字幕の出口にも同じだけ効く**。映像と字幕が同じ物差しに乗る
   */
  test("放送の絶対時刻は持ち込まない", () => {
    expect(plain()).not.toContain("-copyts");
  });

  /*
   * **字幕も同じ ffmpeg でエンコードする。** 出口を 2 つ持ち、字幕は `pipe:3` に出す。
   * 別々に起こすと入口の寄せ幅が違って、時刻を突き合わせられない
   */
  test("字幕は 2 つ目の出口へ出す", () => {
    const args = plain();
    expect(args).toContain("pipe:1");
    expect(args).toContain("pipe:3");
    // 映像の出口が先。字幕はそのあと
    expect(args.indexOf("pipe:1")).toBeLessThan(args.indexOf("pipe:3"));
    // 字幕はデコードせずに写す。描く指定 (-sub_type) も要らない
    expect(args.join(" ")).toContain("-map 0:p:1024:s:0 -c:s copy");
    expect(args).not.toContain("-sub_type");
  });

  /*
   * **字幕を持たない放送はある** (ショッピングやサブチャンネル)。
   * そこで字幕を求めると ffmpeg は組み立ての時点で降りて**映像も出ない**ので、
   * 字幕を外して再エンコードできるようにしてある (`Session.run`)
   */
  test("字幕なしでも組める", () => {
    const args = encodeArgs(1024, stereo, "h264", null);
    expect(args).not.toContain("pipe:3");
    expect(args).not.toContain("-filter_complex");
    expect(args).not.toContain("-sub_type");
    // 映像はいつもどおり
    expect(args).toContain("pipe:1");
    expect(args).toContain("libx264");
  });

  /** **言語が複数ある放送**では 2 本目を選べる */
  test("何本目の字幕かを選べる", () => {
    expect(encodeArgs(1024, stereo, "h264", 1).join(" ")).toContain(
      "-map 0:p:1024:s:1 -c:s copy",
    );
  });

  /*
   * **コマごとに showinfo を出力させない。**
   *
   * 時刻と「空かどうか」を標準エラーに出力させて標準出力のフレームと組にしていた頃は、
   * 数が合わずにずれた (`captions.ts`)。いまは時刻がコマに付いてくる
   */
  test("コマごとに showinfo を出力させない", () => {
    expect(plain()[plain().indexOf("-vf") + 1]).not.toContain("showinfo");
    expect(plain()).not.toContain("showinfo");
  });

  /*
   * **`-loglevel` は下げられない。** 選べる字幕は入口の見出しから読み取っていて
   * (`TrackList`)、あれは info で出る。字幕を映像と同じ ffmpeg でエンコードするように
   * したので、こちらも下げられなくなった。要らない行は読む側で落とす。
   * **数字の進み具合だけは止める。** 毎秒何行も流れるだけで読むものが無い
   */
  test("進み具合は出力させない", () => {
    const args = plain();
    expect(args).toContain("-nostats");
    expect(args).not.toContain("-loglevel");
  });
});

/**
 * **エンコード方式は見ながら選べる** (`LiveCodec`)。映像の中身ではなく「その端末で出るか」
 * の話なので、音声とは別に選ばせる。
 *
 * AV1 は設計 (stream.md#前提) が最初から狙っていた方式。実機は HW エンコーダを
 * 持たないが 44 スレッドあり、同じ電波を 40 秒ずつ通した実測では落ちこぼれない:
 *
 *     x264 veryfast   1 バイト目 729ms   エンコードできた尺 38.5 秒/41 秒
 *     AV1 preset 12   1 バイト目 1177ms  エンコードできた尺 39.1 秒/41 秒
 *
 * **量は中身次第。** どちらも品質を指定してエンコードしているので、ある 40 秒では
 * AV1 が 15% 小さく (3.3 → 2.8 Mbit/s)、別の 25 秒ではほぼ同じ (11.6 → 11.4) だった
 */
describe("エンコード方式を選ぶ", () => {
  const av1 = () => encodeArgs(1024, stereo, "av1");

  test("既定は H.264。**どの端末でも出る**", () => {
    expect(plain()).toContain("libx264");
    expect(encodeArgs(1024, stereo, "h264")).toContain("libx264");
  });

  test("AV1 を選ぶと SVT-AV1 でエンコードする", () => {
    expect(av1()).toContain("libsvtav1");
    expect(av1()).not.toContain("libx264");
  });

  /*
   * **先読みを切る。** SVT-AV1 は既定で先を読むぶん貯めるので、付けないと
   * その貯めがそのまま遅れになる。ライブは待たせないほうが優先
   */
  test("AV1 に先を読ませない", () => {
    expect(av1().join(" ")).toContain("lookahead=0");
  });

  /*
   * **キーフレームの間隔は揃える。** 途中から入ってきた人が待つ長さはここで
   * 決まるので、方式を選び直したら待ちが変わる、では困る
   */
  test("キーフレームの間隔は方式を変えても同じ", () => {
    const gap = (args: string[]) => args[args.indexOf("-g") + 1];
    expect(gap(av1())).toBe(gap(plain()));
  });

  /*
   * **MSE はこれが合っていないと受け取らない。** Chromium で実際に聞くと
   * `avc1.640029` も `av01.0.08M.08` も通り、`mp2v.61` (放送そのまま) は通らない
   */
  test("ブラウザに渡す名前は方式ごとに変わる", () => {
    expect(codecsFor("h264")).toContain("avc1.");
    expect(codecsFor("av1")).toContain("av01.");
    expect(codecsFor("hevc")).toContain("hvc1.");
  });
});

/**
 * **AV1 と組むときは Opus。**
 *
 * 設計 (stream.md#前提) が狙っていた組み合わせで、録画と同じ扱いでもある
 * (`encoder.ts` は前から `libopus -b:a 256k`)。ライブだけ 192k AAC で
 * 低かったのを、放送 (AAC 256kbps) に合わせた 256k へ寄せる。
 *
 * H.264 は AAC のまま。**どの端末でも出る**ほうを既定にしている以上、
 * 音声まで替える理由が無い。
 */
describe("音声も組で決まる", () => {
  const args = (codec: "h264" | "av1") => encodeArgs(1024, stereo, codec);
  const rate = (a: string[]) => a[a.indexOf("-b:a") + 1];

  test("AV1 は Opus 256k", () => {
    expect(args("av1")).toContain("libopus");
    expect(rate(args("av1"))).toBe("256k");
    expect(codecsFor("av1")).toBe('video/mp4; codecs="av01.0.08M.08,Opus"');
  });

  test("H.264 は AAC のまま", () => {
    expect(args("h264")).toContain("aac");
    expect(args("h264")).not.toContain("libopus");
    expect(codecsFor("h264")).toContain("mp4a.40.2");
  });

  /** デュアルモノの配り直しは音声の方式より手前。どちらを選んでも効く */
  test("左右の配り直しは方式によらず効く", () => {
    const sub = audioTracks([{ componentType: 2, langs: ["jpn", "eng"] }])[1]!;
    for (const codec of ["h264", "av1"] as const) {
      const out = encodeArgs(1024, sub, codec);
      expect(out[out.indexOf("-af") + 1]).toContain("c0=c1");
    }
  });

  /** どちらも 2ch に落とす。出す音声トラックが 1 つなので、5.1ch をそのまま渡せない */
  test("どちらも 2ch に落とす", () => {
    for (const codec of ["h264", "av1"] as const) {
      const out = args(codec);
      expect(out[out.indexOf("-ac") + 1]).toBe("2");
    }
  });
});

/**
 * **H.264 は量を捨てて速さを採る。** AV1 と役割が分かれていて、
 * あちらが「小さく」、こちらが「速く」。
 *
 * 実機で 6 回ずつ測ったもの。ばらつきは放送の GOP 待ち (0〜501ms) なので、
 * 短いほうの 2 つを見る:
 *
 *     veryfast  既定      最短 438ms  2 番目 535ms   2.5 Mbit/s  ← 前
 *     ultrafast 既定      最短 386ms  2 番目 429ms   8.2 Mbit/s  ← これ
 *     ultrafast crf 20    最短 524ms  2 番目 584ms  10.7 Mbit/s
 *     ultrafast crf 18    最短 478ms  2 番目 511ms  14.6 Mbit/s
 *     ultrafast crf 14    最短 586ms              35.9 Mbit/s
 *     ultrafast 無劣化    最短 643ms             235.7 Mbit/s
 */
describe("H.264 は速さを優先する", () => {
  test("いちばん速い設定でエンコードする", () => {
    expect(plain()[plain().indexOf("-preset") + 1]).toBe("ultrafast");
  });

  /*
   * **画質は据え置き。** 上げると必ず遅くなる (最初の 1 枚が太り、書き出すのに
   * 時間がかかる)。速さが目的なので、ここは触らない。出てくる映像は今までと
   * 同じで、増えるのは量だけ
   */
  test("画質は指定しない (上げると遅くなる)", () => {
    expect(plain()).not.toContain("-crf");
    expect(plain()).not.toContain("-qp");
  });

  /**
   * **山は抑えない。**
   *
   * 動きの多い場面は 14.5 Mbit/s まで出る。`-maxrate 8M` で 8.4 Mbit/s まで
   * 削れるが、**ライブは宅内で見るもの**という前提で入れていない。帯域は
   * 余っていて、削るのは動きの多い場面の映像のほう。細い経路には AV1 がある。
   *
   * 途切れも「映像だけ遅れる」も、**症状から流量を疑って 2 回とも外した**
   * (本当は受け側の貯め方と復号。`server/live.ts`)
   */
  test("山は抑えない (宅内で見るものなので)", () => {
    expect(plain()).not.toContain("-maxrate");
    // `-bufsize` は `-maxrate` と対でしか効かない。片方だけ残さない
    expect(plain()).not.toContain("-bufsize");
  });

  /** AV1 は量のほう。こちらの設定を持ち込まない */
  test("AV1 には持ち込まない", () => {
    const av1 = encodeArgs(1024, stereo, "av1");
    expect(av1).not.toContain("ultrafast");
    expect(av1).toContain("libsvtav1");
  });
});

/**
 * **コマ数の上限を言っておく。**
 *
 * `-probesize` を削ってあるので、ffmpeg は入口でコマ数を読み切れず、
 * 時間の刻み (90kHz) からでたらめな値を起こすことがある。x264 は黙って受けるが、
 * **SVT-AV1 はエラーにする** (`The maximum allowed frame rate is 240 fps`)。
 * 実機で 20KB のまま AV1 を選ぶと 0/3、上限を付けると 3/3 通った。
 */
describe("コマ数の上限", () => {
  const cap = (args: string[]) => args[args.indexOf("-fpsmax") + 1];

  test("インタレ解除の出方に合わせる", () => {
    // フィールドを起こす = 59.94
    expect(cap(encodeArgs(1024, stereo))).toBe("60000/1001");
  });

  /*
   * **固定 (`-r`) ではなく上限。** 固定すると、放送が本当に 59.94p だったとき
   * (720p の局) にコマを落とす
   */
  test("固定はしない", () => {
    expect(encodeArgs(1024, stereo)).not.toContain("-r");
  });

  /** どちらのエンコード方式でも要る。読み切れないのは入口の話 */
  test("どちらのエンコード方式でも付ける", () => {
    for (const codec of ["h264", "av1"] as const) {
      expect(encodeArgs(1024, stereo, codec)).toContain("-fpsmax");
    }
  });
});

/**
 * **使えなかったことを、画面に出す言葉にする。**
 *
 * エージェントの言い分 (「電波が来ていないか、その周波数に放送がありません」) は
 * 言い切りとしては正しいが、アンテナや配線を疑う文面になる。実機で「T27 が
 * ときどき同期しない」として出たものは、調べると**NHK総合が保守の晩に停波して
 * いた**だけだった (48 時間で 10 回、全部 01:04〜02:54。番組表では 00:11〜05:00 が
 * 放送休止。窓の外では一発で通り、5 秒で 11.3MB 流れてきた)。
 */
describe("使えなかった理由", () => {
  const NOT_LOCKED =
    "選局できません (500) 同期しませんでした (電波が来ていないか、その周波数に放送がありません)";
  // その土地の 05:00。**時計はコンテナの TZ で読む** (`server/library.ts`) ので、
  // ここも土地の時刻で組む
  const until = new Date(2026, 7, 9, 5, 0).getTime();

  test("番組表が休止だと言っていれば、そう言う", () => {
    expect(whyNotTuned(NOT_LOCKED, until)).toBe(
      "いまは放送休止です (05:00 まで)",
    );
  });

  test("休止でなければ、いつもどおり", () => {
    expect(whyNotTuned(NOT_LOCKED, null)).toBe("選局できませんでした");
  });

  /*
   * **言い換えるのは「同期しなかった」ときだけ。** 塞がっていたときや
   * ffmpeg が降りたときに「放送休止です」と出すと、今度はこちらが嘘をつく
   */
  test("別の理由で使えなかったときは言い換えない", () => {
    expect(whyNotTuned("チューナーに空きがありません", until)).toBe(
      "選局できませんでした",
    );
    expect(whyNotTuned("ffmpeg が終了しました (1)", until)).toBe(
      "選局できませんでした",
    );
  });
});

describe("音声だけのエンコード方式 (外から使う API の ?audio=only)", () => {
  test("映像も字幕もエンコードせず、AAC だけを fMP4 で出す", () => {
    const args = encodeArgs(1024, stereo, "audio", 0);
    expect(args).not.toContain("-vf");
    expect(args.some((a) => a.endsWith(":v:0"))).toBe(false);
    expect(args).not.toContain("-filter_complex");
    expect(args.join(" ")).toContain("-c:a aac");
    expect(args.join(" ")).toContain("-f mp4");
  });
});

/**
 * **HTTP の API で音声を選ぶ** (`live?audio=<id>`・`chase?audio=<id>`)。画面の WebSocket と同じ
 * ID (`AudioTrack.id`) を、同じ `pickTrack` → `encodeArgs` に通す
 */
describe("外から選ぶ音声 (?audio=<id>)", () => {
  const tracks = audioTracks([{ componentType: 2, langs: ["jpn", "eng"] }]);
  const chosen = (asked: string | null) => pickTrack(tracks, askedTrack(asked));

  test("デュアルモノの副音声は右だけを両耳に配ってエンコードする", () => {
    const args = encodeArgs(1024, chosen("0:sub"));
    expect(args).toContain("0:p:1024:a:0");
    expect(args[args.indexOf("-af") + 1]).toBe("pan=stereo|c0=c1|c1=c1");
  });

  test("知らないものは主音声でエンコードする (断らない)", () => {
    const args = encodeArgs(1024, chosen("3:sub"));
    expect(args[args.indexOf("-af") + 1]).toBe("pan=stereo|c0=c0|c1=c0");
    expect(chosen("only").id).toBe("0:main");
  });

  /*
   * **音声が違えば共有しない。** 同じ局を主音声で観ている人のエンコードしたものに、
   * 副音声を選んだ人がそれを共有すると、選んだ音が出ない。放送そのままなら全部の音声を送るので分けない
   */
  test("エンコードするものは音声ごとに別のセッション、放送そのままは 1 つ", () => {
    const main = chosen("0:main");
    const sub = chosen("0:sub");
    expect(key("GR", "27", 1, main, "h264", 0)).not.toBe(
      key("GR", "27", 1, sub, "h264", 0),
    );
    expect(key("GR", "27", 1, main, "raw", 0)).toBe(
      key("GR", "27", 1, sub, "raw", 0),
    );
  });
});

/**
 * **GPU でエンコードする** (issue #417)。経路を選ぶのは `hwenc.liveHw` で、ここは引数の組み立てだけ。
 * 手元に GPU が無いので、**字幕・コマ数の上限・音声がソフトウェアのときと同じに残る**ことを見る
 */
describe("GPU でエンコードする", () => {
  const device = "/dev/dri/renderD128";
  const encodeOnly = () =>
    encodeArgs(1024, stereo, "h264", 0, {
      way: { device, kind: "vaapi" },
      full: false,
    });
  const full = () =>
    encodeArgs(1024, stereo, "h264", 0, {
      way: { device, kind: "vaapi" },
      full: true,
    });
  const before = (args: string[], what: string) =>
    args.indexOf(what) < args.indexOf("-i");

  test("エンコードするところだけ GPU。インタレ解除は CPU の bwdif のまま、上げてから渡す", () => {
    const args = encodeOnly();
    expect(before(args, "-init_hw_device")).toBe(true);
    expect(args[args.indexOf("-vf") + 1]).toBe("bwdif,format=nv12,hwupload");
    expect(args.join(" ")).toContain("-c:v h264_vaapi");
    expect(args.join(" ")).toContain("-bf 0 -async_depth 1 -g 60");
    expect(args).not.toContain("libx264");
    expect(args).not.toContain("-hwaccel");
  });

  test("復号から GPU。`-hwaccel` は入力より前、CPU のフィルタは挟まない", () => {
    const args = full();
    expect(before(args, "-hwaccel")).toBe(true);
    expect(before(args, "-hwaccel_output_format")).toBe(true);
    expect(args[args.indexOf("-vf") + 1]).toBe("deinterlace_vaapi=rate=field");
    expect(args.join(" ")).not.toContain("bwdif");
    expect(args.join(" ")).not.toContain("hwupload");
  });

  test("字幕の出口・コマ数の上限・音声はソフトウェアのときと同じ", () => {
    for (const args of [encodeOnly(), full()]) {
      expect(args[args.indexOf("-fpsmax") + 1]).toBe("60000/1001");
      expect(args.join(" ")).toContain("-map 0:p:1024:s:0 -c:s copy");
      expect(args).toContain("pipe:3");
      expect(args.join(" ")).toContain("-c:a aac");
    }
    // AV1 は Opus のまま
    const av1 = encodeArgs(1024, stereo, "av1", 0, {
      way: { device, kind: "vaapi" },
      full: false,
    });
    expect(av1.join(" ")).toContain("-c:v av1_vaapi");
    expect(av1.join(" ")).toContain("-c:a libopus");
  });

  /*
   * **H.265 は GPU でだけ。** 音声は H.264 と同じ AAC で、入れ物の中の名前は `hvc1` (Safari は `hev1` を受け取らない)。
   * GPU が無いのにリクエストされたら投げる (選局の指示を受けるところで H.264 にしてあるので、ふつうは来ない)
   */
  test("H.265 は GPU でだけエンコードし、hvc1 の名前で出し、音声は AAC", () => {
    const args = encodeArgs(1024, stereo, "hevc", 0, {
      way: { device, kind: "vaapi" },
      full: false,
    });
    expect(args.join(" ")).toContain("-c:v hevc_vaapi");
    expect(args.join(" ")).toContain("-g 60 -tag:v hvc1");
    expect(args.join(" ")).toContain("-c:a aac");
    expect(args).not.toContain("libx264");
    expect(codecsFor("hevc")).toBe(
      'video/mp4; codecs="hvc1.1.6.L123.B0,mp4a.40.2"',
    );
    expect(() => encodeArgs(1024, stereo, "hevc", 0, null)).toThrow();
  });

  test("音声だけなら GPU デバイスも開かない", () => {
    const args = encodeArgs(1024, stereo, "audio", 0, {
      way: { device, kind: "vaapi" },
      full: true,
    });
    expect(args).not.toContain("-init_hw_device");
    expect(args).not.toContain("-hwaccel");
  });

  test("NVENC は GPU の番号で選び、低遅延の引数で渡す (デバイスは開かない)", () => {
    const args = encodeArgs(1024, stereo, "h264", 0, {
      way: { device: "/dev/nvidia0", kind: "nvenc", gpu: 0 },
      full: false,
    });
    expect(args).not.toContain("-init_hw_device");
    expect(args[args.indexOf("-vf") + 1]).toBe("bwdif,format=nv12");
    expect(args.join(" ")).toContain("-c:v h264_nvenc -gpu 0");
    expect(args.join(" ")).toContain("-zerolatency 1 -delay 0 -g 60");
    expect(args).not.toContain("-async_depth");
  });

  /*
   * 消費者向けの GPU は同時に開けるエンコードの数に上限がある (`hwenc.nvencBusy`)。
   * 超えて降りたのは GPU が壊れているのではないので、15 分外すことはしない
   */
  test("同時に開ける数を超えて降りただけなら、方式を覚えない", () => {
    // ほかのテストと混ざらないよう、ここだけのデバイス
    const hw = {
      way: { device: "/dev/nvidia-test-busy", kind: "nvenc" as const, gpu: 0 },
      full: false,
    };
    expect(blameLiveHw("h264", hw, true)).toBe(false);
    expect(liveHwFailed("h264", hw)).toBe(false);
    // ほかの理由なら覚えて、しばらくソフトウェア
    expect(blameLiveHw("h264", hw, false)).toBe(true);
    expect(liveHwFailed("h264", hw)).toBe(true);
    // コーデックが違えば別の方式
    expect(liveHwFailed("av1", hw)).toBe(false);
  });
});

/*
 * HTTP の追っかけ (`chaseStream`)。倍速で送り込むので、読む側が追いつかなければ
 * 送り込みを止める。止める量は閉じる量より手前でないと、止める前に閉じてしまう
 */
describe("HTTP で流すところ (sessionStream)", () => {
  test("止める量は閉じる量より小さい", () => {
    expect(CHASE_STREAM_HOLD).toBeLessThan(LIVE_STREAM_BACKLOG);
  });

  test("読まれないまま溜まったら送り込みを止めさせ、閉じはしない", () => {
    let send:
      ((kind: number, pts: bigint, payload: Uint8Array) => void) | null = null;
    let held: () => boolean = () => false;
    const stream = sessionStream((viewer, hold) => {
      send = viewer.connection.send as typeof send;
      held = hold;
      return null;
    });
    const chunk = new Uint8Array(1024 * 1024);
    // 溜まりはじめは止めない
    send!(CHANNEL.videoMedia, 0n, chunk);
    expect(held()).toBe(false);
    // 止める量を超えるまで積む (読まない)。閉じる量には届かない
    for (let i = 0; i < CHASE_STREAM_HOLD / chunk.length + 2; i++)
      send!(CHANNEL.videoMedia, 0n, chunk);
    expect(held()).toBe(true);
    expect(stream.locked).toBe(false);
    void stream.cancel();
  });

  /*
   * **チューナーから外されたら閉じる。** HTTP で観ているもの (テレビのアプリ) は閉じたら同じ局を
   * リクエストし直す。閉じずに黙ると、何も流れないまま止まったと判断するまでの 10 秒を待つことになる
   */
  test("外された (`lost`) ら閉じる", async () => {
    let send:
      ((kind: number, pts: bigint, payload: Uint8Array) => void) | null = null;
    const stream = sessionStream((viewer) => {
      send = viewer.connection.send as typeof send;
      return null;
    });
    const reader = stream.getReader();
    send!(CHANNEL.videoMedia, 0n, new Uint8Array([1, 2, 3]));
    const notice = { type: "lost", recording: null };
    send!(
      CHANNEL.control,
      0n,
      new TextEncoder().encode(JSON.stringify(notice)),
    );
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
    expect((await reader.read()).done).toBe(true);
  });
});

/**
 * **開くまでの内訳の 1 行** (docs/stream.md「開いてから映像が出るまでの内訳」)。本番の記録から
 * 表を作るので、形を変えるなら docs も一緒に直す
 */
describe("開くまでの内訳", () => {
  test("届いた順に並べ、ミリ秒は丸める", () => {
    expect(
      openingLine(
        "GR:T27",
        { tuned: 312.4, firstByte: 520.6, spawned: 521, init: 780, media: 790 },
        "h264",
      ),
    ).toBe(
      "[live] GR:T27: 開くまで 選局 312ms / 最初のバイト 521ms / ffmpeg 521ms / init 780ms / 最初の fMP4 790ms (h264)",
    );
  });

  test("チューナーを使わない追っかけは選局を - にする", () => {
    expect(
      openingLine("GR:T27", { spawned: 3, init: 250, media: 260 }, "av1"),
    ).toBe(
      "[live] GR:T27: 開くまで 選局 - / 最初のバイト - / ffmpeg 3ms / init 250ms / 最初の fMP4 260ms (av1)",
    );
  });
});

/** 画面から来た指示の読み方 (`parseCommand`)。追っかけを元の TS で受ける `raw` と、送るのを止める `hold` */
describe("画面からの指示 (parseCommand)", () => {
  test("追っかけの raw は true のときだけ。省けばエンコードしたもの", () => {
    expect(
      parseCommand({ type: "chase", recordingId: 3, at: 10, raw: true }),
    ).toMatchObject({ type: "chase", recordingId: 3, at: 10, raw: true });
    expect(parseCommand({ type: "chase", recordingId: 3 })).toMatchObject({
      raw: false,
      codec: "h264",
    });
    expect(
      parseCommand({ type: "chase", recordingId: 3, raw: "yes" }),
    ).toMatchObject({ raw: false });
  });

  test("hold は on が true のときだけ止める", () => {
    expect(parseCommand({ type: "hold", on: true })).toEqual({
      type: "hold",
      on: true,
    });
    expect(parseCommand({ type: "hold" })).toEqual({ type: "hold", on: false });
  });
});

/** 元の TS を配る経路が、入力が尽きたあとにすること (`rawEnding`) */
describe("元の TS が尽きたあと (rawEnding)", () => {
  test("追っかけは読み切ったので ended", () => {
    expect(rawEnding({ chase: true, fed: true, stopped: false })).toBe("ended");
    expect(rawEnding({ chase: true, fed: false, stopped: false })).toBe(
      "ended",
    );
  });

  test("ライブは届いたあとなら外された (lost)、届く前なら died", () => {
    expect(rawEnding({ chase: false, fed: true, stopped: false })).toBe("lost");
    expect(rawEnding({ chase: false, fed: false, stopped: false })).toBe(
      "died",
    );
  });

  test("畳んだあとは何も伝えない", () => {
    expect(rawEnding({ chase: true, fed: true, stopped: true })).toBe("quiet");
    expect(rawEnding({ chase: false, fed: true, stopped: true })).toBe("quiet");
  });
});

/**
 * **エンコードが遅れたときに軽くする** (`Session` の `lighten`)。60 コマ → 30 コマ、ソフトウェア → GPU の順で、
 * コーデックは替えない。軽くしたものは作り直した次のセッションが受け継ぐ
 */
describe("エンコードが遅れたときの軽い組み合わせ", () => {
  const fresh: Light = { half: false, gpu: false };
  const base = {
    codec: "h264" as const,
    rung: 0 as const,
    light: fresh,
    software: true,
    gpuReady: () => true,
  };

  test("段 0 はまず 30 コマ、次に GPU、どちらも済めば何もしない", () => {
    expect(nextLight(base)).toBe("half");
    expect(nextLight({ ...base, light: { half: true, gpu: false } })).toBe(
      "gpu",
    );
    expect(nextLight({ ...base, light: { half: true, gpu: true } })).toBeNull();
  });

  test("段 1〜3 はもう 30 コマなので GPU だけ。GPU で動いている・GPU が使えないなら何もしない", () => {
    expect(nextLight({ ...base, rung: 2 })).toBe("gpu");
    expect(nextLight({ ...base, rung: 2, software: false })).toBeNull();
    expect(nextLight({ ...base, rung: 2, gpuReady: () => false })).toBeNull();
    expect(nextLight({ ...base, codec: "audio" })).toBeNull();
  });

  test("GPU を調べるのは GPU に移せるときだけ (振り分けの順を進めない)", () => {
    let asked = 0;
    const gpuReady = () => {
      asked++;
      return true;
    };
    nextLight({ ...base, gpuReady });
    nextLight({ ...base, rung: 1, software: false, gpuReady });
    nextLight({
      ...base,
      rung: 1,
      light: { half: false, gpu: true },
      gpuReady,
    });
    expect(asked).toBe(0);
    nextLight({ ...base, rung: 1, gpuReady });
    expect(asked).toBe(1);
  });

  test("速さが 0.95 を切ったまま 5 秒続いたら 1 回だけ軽くする。戻れば数え直す", () => {
    const lag = new EncodeLag();
    expect(lag.tick(0, null, base)).toBeNull();
    expect(lag.tick(1_000, 0.9, base)).toBeNull();
    // 0.95 以上に戻った。数え直す
    expect(lag.tick(3_000, 0.97, base)).toBeNull();
    expect(lag.tick(4_000, 0.9, base)).toBeNull();
    expect(lag.tick(8_999, 0.9, base)).toBeNull();
    expect(lag.tick(4_000 + LIGHT_LAG, 0.9, base)).toEqual({
      step: "half",
      light: { half: true, gpu: false },
    });
    // 答えは 1 回だけ (セッションはここで畳む)
    expect(lag.tick(20_000, 0.5, base)).toBeNull();
  });

  test("速さ 0 は測れていない値として数えない (画面の adapt.ts と同じ)", () => {
    const lag = new EncodeLag();
    expect(lag.tick(0, 0, base)).toBeNull();
    expect(lag.tick(LIGHT_LAG, 0, base)).toBeNull();
    expect(lag.tick(2 * LIGHT_LAG, 0, base)).toBeNull();
  });

  test("起こし直した ffmpeg は遅れを数え直す", () => {
    const lag = new EncodeLag();
    lag.tick(0, 0.9, base);
    lag.reset();
    expect(lag.tick(LIGHT_LAG, 0.9, base)).toBeNull();
    expect(lag.tick(2 * LIGHT_LAG, 0.9, base)).not.toBeNull();
  });

  test("これより軽くできなければ heavy を 1 回だけ返す", () => {
    const lag = new EncodeLag();
    const done = { ...base, light: { half: true, gpu: true } };
    lag.tick(0, 0.5, done);
    expect(lag.tick(LIGHT_LAG, 0.5, done)).toBe("heavy");
    expect(lag.tick(2 * LIGHT_LAG, 0.5, done)).toBeNull();
  });

  /*
   * **遅れてから作り直すまでの流れ** (`Session.lighten` が順に呼ぶもの)。遅れを数え (`EncodeLag`)、軽くしたものを預け
   * (`keepLight`)、断り書きと `restart` を送る (`lightNotices`)。画面がリクエストし直して作られた次のセッションは
   * 預けたものを受け取り (`takeLight`)、軽い組み合わせで ffmpeg を起こす (`encodeArgs` の `half`)。もう一度遅れたら次は GPU
   */
  test("遅れたら 30 コマで作り直し、次のセッションが受け継ぐ。また遅れたら GPU", () => {
    const id = "GR:T27:1024:0:both:h264:0";
    const first = new EncodeLag();
    for (let at = 0; at < LIGHT_LAG; at += 500)
      expect(first.tick(at, 0.8, base)).toBeNull();
    const verdict = first.tick(LIGHT_LAG, 0.8, base);
    if (verdict === null || verdict === "heavy")
      throw new Error("軽くしていない");
    keepLight(id, verdict.light, LIGHT_LAG);
    expect(lightNotices(verdict.step)).toEqual([
      {
        type: "notice",
        message:
          "サーバのエンコードが追いつかないため、30 コマに切り替えました",
      },
      { type: "restart" },
    ]);

    // 画面がリクエストし直して、同じ目印の新しいセッションができる
    const light = takeLight(id, LIGHT_LAG + 1_000) ?? fresh;
    expect(light).toEqual({ half: true, gpu: false });
    const args = encodeArgs(1024, stereo, "h264", 0, null, 0, light.half);
    expect(args).toContain("bwdif=mode=send_frame");
    expect(args.join(" ")).toContain("-g 30");

    // 新しいセッションでもまだ遅い。次は GPU
    const second = new EncodeLag();
    const now = { ...base, light };
    second.tick(0, 0.8, now);
    const again = second.tick(LIGHT_LAG, 0.8, now);
    expect(again).toEqual({ step: "gpu", light: { half: true, gpu: true } });
    expect(lightNotices("gpu")[0]).toEqual({
      type: "notice",
      message:
        "サーバのエンコードが追いつかないため、GPU のエンコードに切り替えました",
    });
  });

  test("30 コマは放送のインタレ解除を 1 コマずつにして、キーフレームは 1 秒ごと", () => {
    const soft = videoArgs("h264", null, true, 0, null, true);
    expect(soft.filter).toBe("bwdif=mode=send_frame");
    expect(soft.encoder.join(" ")).toContain("-g 30");
    expect(encodeArgs(1024, stereo, "h264", 0, null, 0, true)).toContain(
      "bwdif=mode=send_frame",
    );
    const vaapi: LiveHw = {
      way: { device: "/dev/dri/renderD128", kind: "vaapi" },
      full: true,
    };
    expect(videoArgs("h264", vaapi, true, 0, null, true).filter).toBe(
      "deinterlace_vaapi=rate=frame",
    );
    expect(videoArgs("h264", vaapi, true, 0).filter).toBe(
      "deinterlace_vaapi=rate=field",
    );
    // 指定しなければ今までどおり 60 コマ
    expect(videoArgs("h264", null, true, 0).encoder.join(" ")).toContain(
      "-g 60",
    );
  });

  test("軽くしたものは次のセッションが 1 回だけ受け取り、期限を過ぎたら受け取らない", () => {
    keepLight("GR:T27:1", { half: true, gpu: false }, 1_000);
    expect(takeLight("GR:T27:1", 2_000)).toEqual({ half: true, gpu: false });
    expect(takeLight("GR:T27:1", 2_000)).toBeNull();
    keepLight("GR:T27:1", { half: true, gpu: false }, 1_000);
    expect(takeLight("GR:T27:1", 60_000)).toBeNull();
    expect(takeLight("GR:T16:1", 2_000)).toBeNull();
  });
});

/**
 * **回線に合わせて下げた段** (`videoArgs` の `rung`。段の表は `#lib/rungs.ts`)。段 0 は今までと同じ引数で、
 * 段 1〜3 は 30 コマ・段の高さ・ビットレートの上限
 */
describe("段を下げた映像の引数", () => {
  const rkmpp: LiveHw = {
    way: { device: "/dev/mpp_service", kind: "rkmpp" },
    full: false,
  };
  const vaapi = (full: boolean): LiveHw => ({
    way: { device: "/dev/dri/renderD128", kind: "vaapi" },
    full,
  });
  const nvenc: LiveHw = {
    way: { device: "/dev/nvidia0", kind: "nvenc", gpu: 0 },
    full: false,
  };

  test("段 0 は段を渡さないときと同じ", () => {
    for (const hw of [null, rkmpp, vaapi(true), nvenc])
      for (const interlaced of [true, false])
        expect(videoArgs("h264", hw, interlaced, 0)).toEqual(
          videoArgs("h264", hw, interlaced),
        );
    expect(encodeArgs(1024, stereo, "h264", 0, null, 0)).toEqual(plain());
  });

  test("x264 は veryfast の上限つき crf。放送は bwdif で 30 コマにして縮め、キーフレームは 1 秒ごと", () => {
    const args = videoArgs("h264", null, true, 2);
    expect(args.filter).toBe("bwdif=mode=send_frame,scale=-2:540");
    expect(args.encoder.join(" ")).toBe(
      "-c:v libx264 -preset veryfast -tune zerolatency -crf 23 -maxrate:v 1500000 -bufsize:v 1500000 -g 30",
    );
  });

  test("エンコード済みは、元が 30 コマを超えるか分からなければ fps で 30 コマにそろえて縮める", () => {
    expect(videoArgs("h264", null, false, 1).filter).toBe(
      "fps=30000/1001,scale=-2:720",
    );
    expect(videoArgs("h264", null, false, 1, 60000 / 1001).filter).toBe(
      "fps=30000/1001,scale=-2:720",
    );
  });

  test("エンコード済みで元が 30 コマ以下なら、コマを足さずにそのままのコマ数。キーフレームは 1 秒ごと", () => {
    const film = videoArgs("h264", null, false, 1, 24000 / 1001);
    expect(film.filter).toBe("scale=-2:720");
    expect(film.encoder.join(" ")).toContain("-g 24");
    const thirty = videoArgs("h264", rkmpp, false, 2, 30000 / 1001);
    expect(thirty.filter).toBe("scale=-2:540,format=nv12");
    expect(thirty.encoder.join(" ")).toContain("-g 30");
    // 放送 (インタレ) はコマ数を渡しても bwdif で 30 コマ
    expect(videoArgs("h264", null, true, 1, 24000 / 1001).filter).toBe(
      "bwdif=mode=send_frame,scale=-2:720",
    );
  });

  test("Rockchip MPP は段の上限を AVBR に渡し、縮めるのは CPU", () => {
    const args = videoArgs("hevc", rkmpp, true, 1);
    expect(args.filter).toBe("bwdif=mode=send_frame,scale=-2:720,format=nv12");
    expect(args.encoder.join(" ")).toBe(
      "-c:v hevc_rkmpp -rc avbr -b:v 3000000 -maxrate 3187500 -minrate 187500 -g 30 -tag:v hvc1",
    );
  });

  test("NVENC は段の上限を VBR の平均に渡す", () => {
    expect(videoArgs("h264", nvenc, true, 3).encoder.join(" ")).toContain(
      "-rc vbr -b:v 600000 -maxrate 1200000 -bufsize 1200000",
    );
  });

  test("VA-API は CQP をやめて VBR。デコードから GPU なら GPU の上で縮める", () => {
    const full = videoArgs("h264", vaapi(true), true, 1);
    expect(full.filter).toBe(
      "deinterlace_vaapi=rate=frame,scale_vaapi=w=-2:h=720",
    );
    expect(full.encoder.join(" ")).toContain(
      "-rc_mode VBR -b:v 3000000 -maxrate:v 3000000",
    );
    expect(full.encoder).not.toContain("CQP");
    const upload = videoArgs("h264", vaapi(false), true, 1);
    expect(upload.filter).toBe(
      "bwdif=mode=send_frame,scale=-2:720,format=nv12,hwupload",
    );
    // エンコード済みは GPU でデコードしない (`full` を外す)
    expect(videoArgs("h264", vaapi(true), false, 1).filter).toBe(
      "fps=30000/1001,scale=-2:720,format=nv12,hwupload",
    );
  });

  test("ソフトウェアで段を下げるのは H.264 だけ (SVT-AV1・x265 は使わない)", () => {
    expect(() => videoArgs("av1", null, true, 1)).toThrow();
    expect(() => videoArgs("hevc", null, true, 1)).toThrow();
  });

  test("段 1〜3 の音声は 96k", () => {
    expect(audioArgs("h264", 1)).toEqual([
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-ac",
      "2",
    ]);
    expect(audioArgs("av1", 3)).toContain("libopus");
    expect(audioArgs("h264")).toContain("256k");
    expect(encodeArgs(1024, stereo, "h264", 0, null, 2).join(" ")).toContain(
      "-c:a aac -b:a 96k",
    );
  });
});

/**
 * **段を下げるときのコーデック** (`rungCodec`)。AV1 → H.265 → H.264 のうち、端末が再生できて GPU でエンコードできる最初のもの。
 * 無ければソフトウェアの H.264
 */
describe("段を下げるときのコーデック", () => {
  const hw: LiveHw = { way: { device: "d", kind: "rkmpp" }, full: false };
  /** GPU でエンコードできるコーデックだけ経路を返す */
  const gpu =
    (...codecs: string[]) =>
    (codec: string) =>
      codecs.includes(codec) ? hw : null;

  test("RK3588 (H.265 と H.264 だけ) は、H.265 を再生できれば H.265、できなければ H.264", () => {
    const rk = gpu("hevc", "h264");
    expect(rungCodec(["av1", "hevc", "h264"], true, rk)).toBe("hevc");
    expect(rungCodec(["av1", "h264"], true, rk)).toBe("h264");
  });

  test("AV1 を GPU でエンコードできて再生できれば AV1", () => {
    expect(rungCodec(["av1", "h264"], true, gpu("av1", "h264"))).toBe("av1");
  });

  test("GPU が無ければソフトウェアの H.264 (再生できると言われていなくても)", () => {
    expect(rungCodec(["av1", "hevc"], true, gpu())).toBe("h264");
  });

  test("再生できるコーデックの読み方。省けばリクエストされたものと H.264、知らない値は捨てる", () => {
    expect(parsePlayable(undefined, "av1")).toEqual(["av1", "h264"]);
    expect(parsePlayable("", "h264")).toEqual(["h264"]);
    expect(parsePlayable("hevc,x,h264,hevc", "av1")).toEqual(["hevc", "h264"]);
    expect(parsePlayable(["av1", 3], "h264")).toEqual(["av1"]);
    // `?playable=av1, hevc` の空白は読み飛ばす (`viewing.parseFormats` と同じ)
    expect(parsePlayable("av1, hevc", "h264")).toEqual(["av1", "hevc"]);
  });
});

/** **段を下げたライブの枠** (`rungSlot`)。段 0 と共有は使わず、新しく段を下げてエンコードするときだけ 1 つ使う */
describe("段を下げたライブの枠", () => {
  test("段 0 と、同じ段のセッションに入るときは枠を取らない", () => {
    let asked = 0;
    const hold = () => {
      asked++;
      return () => undefined;
    };
    expect(rungSlot(0, false, hold)).not.toBeNull();
    expect(rungSlot(2, true, hold)).not.toBeNull();
    expect(asked).toBe(0);
  });

  test("新しく段を下げるときは 1 つ取り、埋まっていれば null", () => {
    let held = 0;
    const hold = () => {
      if (held >= 1) return null;
      held++;
      return () => {
        held--;
      };
    };
    const release = rungSlot(1, false, hold);
    expect(release).not.toBeNull();
    expect(rungSlot(3, false, hold)).toBeNull();
    release?.();
    expect(rungSlot(3, false, hold)).not.toBeNull();
  });

  /*
   * **抜けるかは枠を取る前に決める** (`rungPlan`)。抜けたあとで取れないと、映像が切れたうえに今の段にも戻れない
   * (段 0 で開き直していた)
   */
  test("空いていれば取る。共有するなら空きを見ない", () => {
    expect(rungPlan({ shared: false, room: 1, leaving: false })).toBe("hold");
    expect(rungPlan({ shared: true, room: 0, leaving: false })).toBe("hold");
  });

  test("埋まっていても、自分だけの段のセッションから移るなら抜けてから取る", () => {
    expect(rungPlan({ shared: false, room: 0, leaving: true })).toBe("leave");
  });

  test("抜けても空かないなら抜けずに今の段のまま (上限を下げた直後は空きが負)", () => {
    expect(rungPlan({ shared: false, room: -1, leaving: true })).toBe("stay");
    expect(rungPlan({ shared: false, room: 0, leaving: false })).toBe("stay");
  });

  test("ソフトウェアでエンコードしてよいのは H.264 と段 0 の AV1 だけ", () => {
    expect(softwareEncodes("h264", 0)).toBe(true);
    expect(softwareEncodes("h264", 2)).toBe(true);
    expect(softwareEncodes("av1", 0)).toBe(true);
    expect(softwareEncodes("av1", 1)).toBe(false);
    expect(softwareEncodes("hevc", 0)).toBe(false);
  });

  test("共有の目印に段が入る。段 0 は段を足す前と同じ", () => {
    expect(key("GR", "27", 1, stereo, "h264", 0, null, 0)).toBe(
      key("GR", "27", 1, stereo, "h264", 0),
    );
    expect(key("GR", "27", 1, stereo, "h264", 0, null, 0)).not.toBe(
      key("GR", "27", 1, stereo, "h264", 0, null, 1),
    );
    expect(key("GR", "27", 1, stereo, "h264", 0, null, 1)).not.toBe(
      key("GR", "27", 1, stereo, "h264", 0, null, 2),
    );
  });
});

/** **段と再生できるコーデックの指示** (`parseCommand`)。読めない段は 0 (下げない) */
describe("段の指示 (parseCommand)", () => {
  const tune = { type: "tune", channelType: "GR", channel: "27", serviceId: 1 };

  test("tune の段と再生できるコーデックを読む", () => {
    expect(
      parseCommand({ ...tune, rung: 2, playable: ["hevc", "h264"] }),
    ).toMatchObject({ rung: 2, playable: ["hevc", "h264"] });
    expect(parseCommand({ ...tune, codec: "av1" })).toMatchObject({
      rung: 0,
      playable: ["av1", "h264"],
    });
    expect(parseCommand({ ...tune, rung: 5 })).toMatchObject({ rung: 0 });
    expect(parseCommand({ ...tune, rung: "1" })).toMatchObject({ rung: 1 });
  });

  test("追っかけも同じ。段 0 の H.265 は H.264 にする", () => {
    expect(
      parseCommand({ type: "chase", recordingId: 3, rung: 3 }),
    ).toMatchObject({ rung: 3, playable: ["h264"] });
    expect(
      parseCommand({
        type: "chase",
        recordingId: 3,
        codec: "hevc",
        rung: 1,
        playable: ["hevc"],
      }),
    ).toMatchObject({ codec: "h264", rung: 1, playable: ["hevc"] });
  });

  test("音声だけ (codec: audio) は選局でだけ受け、追っかけでは H.264 にする", () => {
    expect(parseCommand({ ...tune, codec: "audio", rung: 3 })).toMatchObject({
      codec: "audio",
      rung: 3,
    });
    expect(
      parseCommand({ type: "chase", recordingId: 3, codec: "audio" }),
    ).toMatchObject({ codec: "h264" });
  });
});

/** **セッションのエンコードの速さ** (`encodeSpeed`)。測るのは映像の長さなので、映像の無いものは null */
describe("エンコードの速さ", () => {
  test("エンコードしているなら測った値を返す", () => {
    expect(encodeSpeed(false, "h264", () => 0.8)).toBe(0.8);
  });

  test("放送そのままと音声だけは null (音声だけで 0 と返すと、画面がエンコードの遅れと読む)", () => {
    expect(encodeSpeed(true, "h264", () => 0)).toBeNull();
    expect(encodeSpeed(false, "audio", () => 0)).toBeNull();
  });
});
