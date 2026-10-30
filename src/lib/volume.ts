/**
 * 音量の決め方 (`sound.ts`・`components/player/volume.svelte.ts` の中身のうち、画面にも Web Audio にも触らない所)。
 *
 * 単体テストで見るために分けてある (`volume.test.ts`)
 */

/** 端末ごとに覚える鍵 (`keep.ts`)。速さ・バックグラウンド再生と同じ置き場 */
export const VOLUME_KEY = "player-volume";

/**
 * **100% のときに足す大きさ (dB)。**
 *
 * 放送は ARIB TR-B32 で -24 LKFS にそろえてあり、動画サイト (-14 LUFS 前後) より 10 dB ほど小さく
 * 聞こえる。差を全部は埋めない — 埋めると大きな音の山がリミッタ (`LIMITER`) に当たり続けて、潰れた音に
 * なる。+6 dB なら差の半分より多くを埋めつつ、リミッタに当たるのは大きな山だけで済む
 */
export const BOOST_DB = 6;
/** つまみの上限 (%)。**既定もここ** — 開いたときは +6 dB で鳴らし、つまみは下げる向きにだけ動く */
export const MAX_LEVEL = 100;
/** つまみと ↑↓ の刻み (%) */
export const LEVEL_STEP = 5;

/** 覚えていた値。**既定は 100%**。読めない・範囲の外のものは既定か端に寄せる */
export function storedVolume(saved: string | null): number {
  if (saved === null || saved.trim() === "") return MAX_LEVEL;
  const level = Number(saved);
  return Number.isFinite(level) ? clampLevel(level) : MAX_LEVEL;
}

/** 0〜`MAX_LEVEL` の整数に */
export function clampLevel(level: number): number {
  return Math.min(MAX_LEVEL, Math.max(0, Math.round(level)));
}

/** ↑↓ で1刻み動かす。刻みの途中にいたら、次の刻みの目に乗せる */
export function stepLevel(level: number, direction: number): number {
  const at = level / LEVEL_STEP;
  const next = direction > 0 ? Math.floor(at) + 1 : Math.ceil(at) - 1;
  return clampLevel(next * LEVEL_STEP);
}

/**
 * **つまみの値 (%) → 掛ける大きさ (振幅の倍率)。振幅をつまみの値の2乗に比例させる。**
 *
 * 0% は無音、100% は +6 dB (`BOOST_DB`)。50% は 100% より 12 dB 小さい (放送より 6 dB 小さい)。
 *
 * 人が感じる大きさは振幅のおよそ 0.6 乗に比例する (Stevens のべき法則)。2乗に比例させると感じる大きさは
 * つまみの値の 1.2 乗になり、**つまみの位置と聞こえる大きさがほぼ比例する** — 半分まで下げれば、
 * ほぼ半分の大きさに聞こえる。
 *
 * - 振幅に比例させると感じる大きさは 0.6 乗で、上半分を動かしても 6 dB しか変わらず、変わるのは下の端ばかりになる
 * - dB に比例させると 0% に届かない (どこかで下限を決めて無音へ飛ばすことになり、その手前が急に小さくなる)
 */
export function volumeGain(level: number): number {
  const at = clampLevel(level) / MAX_LEVEL;
  return 10 ** (BOOST_DB / 20) * at * at;
}

/**
 * **割れないように必ず通すリミッタ** (DynamicsCompressorNode)。
 *
 * - 当たり始めは -3 dBFS。山が当たっても 0 dBFS までに余白が残り、`attack` の間に越えるぶんを飲み込む
 * - `knee` 0・`ratio` 20 で、当たった所からほぼ平らに抑える (リミッタとして)
 * - `attack` 3ms で山を素早く捕まえ、`release` 250ms で戻す (速く戻すと音がうねる)
 */
export const LIMITER = {
  threshold: -3,
  knee: 0,
  ratio: 20,
  attack: 0.003,
  release: 0.25,
} as const;

/**
 * DynamicsCompressorNode が自分で足す大きさ (makeup gain) の指数。
 *
 * Chromium・Firefox・WebKit は同じ作り (Blink の `DynamicsCompressorKernel`) で、当たり始めより小さい音にも
 * 「0 dBFS を入れたときに出てくる大きさ」の逆数を 0.6 乗したものを掛ける。仕様には書かれていない
 */
const MAKEUP_EXPONENT = 0.6;

/**
 * **リミッタの後ろで掛ける大きさ。** リミッタが足す makeup gain をちょうど打ち消す — 当たらない音の
 * 大きさは、つまみの値どおり (`volumeGain`) のまま通す。
 *
 * `knee` 0 では、0 dBFS を入れると `threshold + (0 - threshold) / ratio` dB で出てくる
 */
export function limiterTrim(limiter: {
  threshold: number;
  ratio: number;
}): number {
  const full = limiter.threshold - limiter.threshold / limiter.ratio;
  return 10 ** ((full * MAKEUP_EXPONENT) / 20);
}

/**
 * **`<audio>` を通すか** (`sound.ts` の `Outlet`)。バックグラウンド再生・小窓で、裏でも止まらないように。
 *
 * - Safari (Audio Session が言える) は通さない — `playback` と言えば裏でも止まらない
 * - ストリームを作れない端末は直に鳴らすまま
 */
export function throughAudio(now: {
  /** 通したいか (バックグラウンド再生・小窓) */
  wanted: boolean;
  /** Audio Session API があるか (Safari) */
  session: boolean;
  /** `createMediaStreamDestination` があるか */
  streamable: boolean;
}): boolean {
  return now.wanted && !now.session && now.streamable;
}

/**
 * **`<video>` の音を Web Audio に通すか** (`volume.svelte.ts`)。
 *
 * 一度通した要素の音は、もう Web Audio からしか出ない。**AudioContext が鳴らせる (`running`) まで
 * 通さない** — 自動再生の許しが無いまま通すと、`<video>` は鳴っているのに何も聞こえない
 */
export function tapVideo(now: {
  /** `<video>` で観ているか (canvas に描いていない) */
  video: boolean;
  /** AudioContext の状態。作れなければ null */
  state: AudioContextState | "interrupted" | null;
}): boolean {
  return now.video && now.state === "running";
}
