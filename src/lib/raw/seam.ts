/**
 * **音のコマを継ぎ目なく並べる** (docs/stream.md#継ぎ目はサンプル単位でつなぐ)。
 *
 * 自前で鳴らす音 (MPEG-2 の経路の `engine.ts`、WebKit のライブの `native-audio.ts`) は、AAC の 1 コマ
 * (48kHz で 1024 サンプル、約 21ms) ごとに `AudioBufferSourceNode` を作って予約する。継ぎ目に 1 サンプルでも
 * 隙間や重なりがあると、そこで波形が飛び「チリチリ」と聞こえる (#2684)。起きる所は 2 つ:
 *
 * - **AudioContext と音のサンプルレートが違う** (端末の出力が 44.1kHz)。1 コマが 940.8 サンプルになり、
 *   ノードごとにサンプルレートを変換した端がずれる。**AudioContext を放送と同じ 48kHz で作る** (`audioContext`)。
 *   サンプルレートはブラウザが出力の手前で 1 回だけ変換する
 * - **予約の時刻が 1 サンプルの倍数にならない** (PTS の揺れ・秒に直したときの丸め)。前のコマの終わりと
 *   `SNAP` 以内なら、前のコマの終わりのサンプルにつなぐ (`Seam`)
 *
 * DOM も Web Audio も触らないので、`Seam` は単体で確かめられる (`seam.test.ts`)。
 */

/** AudioContext のサンプルレート。日本の放送の AAC (ARIB STD-B32) とエンコードした Opus はどちらも 48kHz */
export const SAMPLE_RATE = 48_000;
/** 前のコマの終わりとこれ以内のずれなら、前のコマの終わりにつなぐ (秒)。これより離れていれば本当の途切れ */
export const SNAP = 0.001;

/**
 * 音を鳴らす AudioContext を 48kHz で作る。**指定できないブラウザは端末のサンプルレートのまま**
 * (継ぎ目は `Seam` だけで並べる)
 */
export function audioContext(
  latencyHint: AudioContextLatencyCategory,
): AudioContext {
  try {
    return new AudioContext({ latencyHint, sampleRate: SAMPLE_RATE });
  } catch {
    return new AudioContext({ latencyHint });
  }
}

/** 予約したコマの終わりを保持し、次のコマをそこへつなぐ。止めた・飛んだら `reset` */
export class Seam {
  /** 前のコマが鳴り終わる位置 (AudioContext のサンプル)。まだ無ければ null */
  private next: number | null = null;

  /** @param rate AudioContext のサンプルレート */
  constructor(private readonly rate: number) {}

  /**
   * `when` 秒から `length` 秒鳴らすコマを置く。**予約する時刻 (秒) を返す。**
   * 前のコマの終わりに近ければそこへ、離れていればいちばん近いサンプルへ置く
   */
  place(when: number, length: number): number {
    const at = when * this.rate;
    const frame =
      this.next !== null && Math.abs(at - this.next) <= SNAP * this.rate
        ? this.next
        : Math.round(at);
    this.next = frame + length * this.rate;
    return frame / this.rate;
  }

  reset(): void {
    this.next = null;
  }
}
