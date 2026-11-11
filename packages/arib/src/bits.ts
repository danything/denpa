/**
 * ビット単位の読み取り (大きい桁が先)。LATM の AudioMuxElement (`mmt-media.ts`) と、HEVC の SPS のように
 * バイトの区切りに揃っていない並びを読む。**中身の意味は持たない。**
 *
 * 終わりを越えて読むと 0 を返し、`overrun` を立てる。読む側は最後に `overrun` を見て、壊れた並びを捨てる
 * (1 ビットごとに長さを確かめなくて済む)
 */
export class BitReader {
  /** 次に読むビットの位置 (先頭から) */
  at = 0;
  /** 終わりを越えて読もうとした */
  overrun = false;

  constructor(private readonly data: Uint8Array) {}

  /** 残りのビット数 */
  get left(): number {
    return this.data.length * 8 - this.at;
  }

  /** `count` ビット (32 まで) を符号なしの整数で読む */
  bits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) value = value * 2 + this.bit();
    return value;
  }

  bit(): number {
    const byte = this.data[this.at >> 3];
    if (byte === undefined) {
      this.overrun = true;
      this.at++;
      return 0;
    }
    const value = (byte >> (7 - (this.at & 7))) & 1;
    this.at++;
    return value;
  }

  skip(count: number): void {
    this.at += count;
    if (this.at > this.data.length * 8) this.overrun = true;
  }

  /** 指数ゴロム符号 (符号なし。H.264・HEVC の ue(v)) */
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      // 32 を越える 0 は壊れた並び (overrun で止まる)
      if (++zeros > 32 || this.overrun) {
        this.overrun = true;
        return 0;
      }
    }
    return 2 ** zeros - 1 + this.bits(zeros);
  }

  /** `from` ビット目から `count` ビットを、先頭に詰めたバイト列にする (端数の後ろは 0) */
  slice(from: number, count: number): Uint8Array {
    const out = new Uint8Array(Math.ceil(count / 8));
    const reader = new BitReader(this.data);
    reader.at = from;
    for (let i = 0; i < count; i++)
      if (reader.bit()) out[i >> 3]! |= 0x80 >> (i & 7);
    return out;
  }
}
