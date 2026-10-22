/**
 * デコードできた YUV を **WebGL2 で描く** (変換せずに送る経路。docs/stream.md#放送そのままmpeg-2を送る)。worker の中で動く。
 *
 * 面は3枚 (Y・Cb・Cr) を別々のテクスチャに上げ、RGB への変換はシェーダでやる。
 * CPU で RGB にすると 1080 の1コマで 600 万画素ぶんの計算が毎コマ要る。
 *
 * ## インタレ解除は bob に「**止まっているところと、櫛になっていないところは織る**」を足したもの
 *
 * 放送は 1080i — 1コマに時刻の違う2枚 (フィールド) が1行おきに入っている。そのまま
 * 出すと動くところが櫛になる。エンコードする経路の `bwdif` は前後のコマまで見て埋め方を選ぶが、
 * ここでは**そのコマと、ひとつ前のコマ**で決める:
 *
 * - フィールドごとに出す。**動きが 60 枚/秒のまま出る** (スポーツやスクロールする字幕が
 *   滑らか。エンコードする経路と同じ)
 * - 抜けた行は、**前のコマから変わっていなければ、もう片方のフィールドのその行をそのまま使う** (織る)
 * - 変わっていれば、**もう片方のフィールドのその行が上下の行の間に収まっていれば織る**。
 *   はみ出していれば櫛 (2枚の間に動いた) なので、上下の平均で埋める (bob)
 * - 前のコマは輝度のテクスチャを 1 枚残しておくだけ (2 枚を交互に使うので、上げ直しは増えない)
 *
 * 平均で埋めるだけ (素の bob) だと、**止まっているテロップの縁が 1 行ぶん上下に揺れて
 * ちらつく** — 上のフィールドと下のフィールドでは縁になる行が1行ずれるので、交互に出すと
 * 縁が毎秒 30 回上下する。止まっているところは、どちらのフィールドの番でも織った同じ映像に
 * なるので揺れない。
 *
 * **そのコマの中だけでは、止まっているかを決めきれない。** 縁取りのある字や細い横線は縦にくっきり
 * した模様で、上下の行の間に収まらない — 櫛と見分けがつかず、埋める側に回ってちらついていた。
 * そこで抜けた行とその上下の行を、**前のコマの同じ行と比べる** (2 フィールド離れた、同じ並びの行どうし)。
 * 局を変えた直後や大きさが変わった直後は前のコマが無いので、そのコマの中だけで決める
 *
 * プログレッシブのコマ (720p や、インタレの印が無いもの) はそのまま出す。
 */

const VERTEX = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() {
    uv = vec2((pos.x + 1.0) * 0.5, (1.0 - pos.y) * 0.5);
    gl_Position = vec4(pos, 0.0, 1.0);
}`;

/*
 * `field` が 0 なら上のフィールド (偶数行)、1 なら下 (奇数行)、負ならそのまま。
 * 色差 (4:2:0) もインタレでは1行おきにフィールドが入れ替わるので、同じ埋め方をする
 * (はみ出しで織るか埋めるかは面ごと、止まっているかは輝度で決める)。
 * 縦は行の真ん中を読む (隣の行と混ぜない)、横は LINEAR で補う (1440 → 1920 の引き伸ばし)
 */
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D planeY;
uniform sampler2D planeU;
uniform sampler2D planeV;
/** 前のコマの輝度 (止まっているかを見る) */
uniform sampler2D planeYPrev;
uniform bool hasPrev;
uniform int field;
uniform vec2 rows;
uniform mat3 matrix;
in vec2 uv;
out vec4 color;

float at(sampler2D plane, float row, float count) {
    return texture(plane, vec2(uv.x, (row + 0.5) / count)).r;
}

/*
 * 抜けた行が止まっている度合い (1 止まっている〜0 動いている)。抜けた行とその上下の行を、前のコマの
 * 同じ行と比べる。**輝度だけで決めて色差にも使う** (4:2:0 の色差は行が粗い)。
 * 4/255 までは雑音として止まっている、12/255 からは動いている (間はなだらかに)
 */
float stillness() {
    if (field < 0 || !hasPrev) return 0.0;
    float count = rows.x;
    float row = min(floor(uv.y * count), count - 1.0);
    if (mod(row, 2.0) == float(field)) return 0.0;
    float up = row - 1.0 < 0.0 ? row + 1.0 : row - 1.0;
    float down = row + 1.0 > count - 1.0 ? row - 1.0 : row + 1.0;
    float moved = max(
        abs(at(planeY, row, count) - at(planeYPrev, row, count)),
        max(abs(at(planeY, up, count) - at(planeYPrev, up, count)), abs(at(planeY, down, count) - at(planeYPrev, down, count)))
    );
    return 1.0 - smoothstep(4.0 / 255.0, 12.0 / 255.0, moved);
}

float pick(sampler2D plane, float count, float still) {
    if (field < 0) return texture(plane, uv).r;
    float row = min(floor(uv.y * count), count - 1.0);
    if (mod(row, 2.0) == float(field)) return at(plane, row, count);
    float a = at(plane, row - 1.0 < 0.0 ? row + 1.0 : row - 1.0, count);
    float b = at(plane, row + 1.0 > count - 1.0 ? row - 1.0 : row + 1.0, count);
    float other = at(plane, row, count);
    // 上下の間からどれだけはみ出しているか。**8/255 までは雑音として織り、16/255 からは
    // 櫛として埋める** (間はなだらかに混ぜる。画素ごとに織る・埋めるが入れ替わってざらつかないように)
    float over = max(other - max(a, b), min(a, b) - other);
    float filled = mix(other, 0.5 * (a + b), smoothstep(8.0 / 255.0, 16.0 / 255.0, over));
    // 止まっていれば、はみ出していても織る (縁取りのある字・細い横線)
    return mix(filled, other, still);
}

void main() {
    float still = stillness();
    // 放送は限定レンジ (Y 16〜235 / C 16〜240)
    float y = (pick(planeY, rows.x, still) - 16.0 / 255.0) * (255.0 / 219.0);
    float u = (pick(planeU, rows.y, still) - 128.0 / 255.0) * (255.0 / 224.0);
    float v = (pick(planeV, rows.y, still) - 128.0 / 255.0) * (255.0 / 224.0);
    color = vec4(clamp(matrix * vec3(y, u, v), 0.0, 1.0), 1.0);
}`;

/** YCbCr → RGB (列優先)。**HD は BT.709、SD は BT.601** */
const BT709 = [1, 1, 1, 0, -0.1873, 1.8556, 1.5748, -0.4681, 0];
const BT601 = [1, 1, 1, 0, -0.344136, 1.772, 1.402, -0.714136, 0];
/** FFmpeg の AVColorSpace で SD を指すもの (BT470BG / SMPTE170M) */
const SD_SPACES = new Set([5, 6]);

/** 1コマぶんの面。`data` は WASM のメモリの上の見え方 (写さずに上げる) */
export interface Planes {
  width: number;
  height: number;
  /** 各面の1行のバイト数 (右に詰め物がある) */
  strides: [number, number, number];
  data: [Uint8Array, Uint8Array, Uint8Array];
  /** AVColorSpace。2 (未指定) なら高さで決める */
  colorspace: number;
}

export class YuvRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly textures: WebGLTexture[];
  private readonly program: WebGLProgram;
  private size = { width: 0, height: 0 };
  /**
   * 輝度のテクスチャ 2 枚 (今のコマと前のコマ)。上げるたびに入れ替える。
   * `lumaSize` はそれぞれに今の大きさで上げてあるか (局を変えて大きさが変わると、前のコマは使えない)
   */
  private readonly lumas: [WebGLTexture, WebGLTexture];
  private readonly lumaSize = ["", ""];
  private turn = 0;
  private hasPrev = false;
  private matrix = BT709;

  constructor(private readonly canvas: OffscreenCanvas) {
    // 描いたものを読み戻さないので、残しておく必要は無い
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
    });
    if (gl === null) throw new Error("WebGL2 が使えません");
    this.gl = gl;
    this.program = link(gl);
    gl.useProgram(this.program);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const pos = gl.getAttribLocation(this.program, "pos");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    this.textures = ["planeY", "planeU", "planeV", "planeYPrev"].map(
      (name, unit) => {
        const texture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.uniform1i(gl.getUniformLocation(this.program, name), unit);
        return texture;
      },
    );
    this.lumas = [this.textures[0]!, this.textures[3]!];
    // 面の幅は 4 の倍数とは限らない
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  /**
   * 1コマ上げる。**大きさが変わったらテクスチャごと作り直す** (局を変えると 1440 ⇔ 1920 がある)
   *
   * @param displayWidth 見せる幅 (画素の縦横比を掛けたもの。1440x1080 の放送は 1920)
   */
  upload(planes: Planes, displayWidth: number): void {
    const gl = this.gl;
    const { width, height } = planes;
    const resized = width !== this.size.width || height !== this.size.height;
    if (resized) this.size = { width, height };
    if (this.canvas.width !== displayWidth || this.canvas.height !== height) {
      this.canvas.width = displayWidth;
      this.canvas.height = height;
    }
    const sd =
      SD_SPACES.has(planes.colorspace) ||
      (planes.colorspace === 2 && height <= 576);
    this.matrix = sd ? BT601 : BT709;
    // 輝度は前のコマのテクスチャを残し、もう 1 枚へ上げる (入れ替えて、今のを 0 番、前のを 3 番に置く)
    const sized = `${width}x${height}`;
    const next = 1 - this.turn;
    this.hasPrev = this.lumaSize[this.turn] === sized;
    const luma = this.lumas[next]!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, luma);
    this.put(planes, 0, width, height, this.lumaSize[next] !== sized);
    this.lumaSize[next] = sized;
    this.turn = next;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.lumas[1 - next]!);
    for (let i = 1; i < 3; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[i]!);
      this.put(planes, i, (width + 1) >> 1, (height + 1) >> 1, resized);
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  }

  /** 面を 1 枚、いま結び付けてあるテクスチャへ上げる。`fresh` なら大きさごと作り直す */
  private put(
    planes: Planes,
    i: number,
    w: number,
    h: number,
    fresh: boolean,
  ): void {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, planes.strides[i]!);
    const data = planes.data[i]!;
    if (fresh)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R8,
        w,
        h,
        0,
        gl.RED,
        gl.UNSIGNED_BYTE,
        data,
      );
    else
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        w,
        h,
        gl.RED,
        gl.UNSIGNED_BYTE,
        data,
      );
  }

  /** 描く。`field` は 0 (上) / 1 (下) / -1 (プログレッシブ) */
  draw(field: number): void {
    const gl = this.gl;
    if (this.size.width === 0) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform1i(gl.getUniformLocation(this.program, "field"), field);
    gl.uniform1i(
      gl.getUniformLocation(this.program, "hasPrev"),
      this.hasPrev ? 1 : 0,
    );
    gl.uniform2f(
      gl.getUniformLocation(this.program, "rows"),
      this.size.height,
      (this.size.height + 1) >> 1,
    );
    gl.uniformMatrix3fv(
      gl.getUniformLocation(this.program, "matrix"),
      false,
      this.matrix,
    );
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * いま上げてあるコマを描き直して、画素を読み出す (切り抜き)。
   *
   * **描き直してから読む。** 描いたものは残さない作り (`preserveDrawingBuffer` 無し) なので、
   * 画面へ渡した後の面は空になっている。同じコマを描き直せば、その回のうちは読める。
   * 読み出しは下から上の順なので、上下を返す
   */
  capture(field: number): ImageData | null {
    const gl = this.gl;
    if (this.size.width === 0) return null;
    this.draw(field);
    const { width, height } = this.canvas;
    const pixels = new Uint8ClampedArray(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const row = width * 4;
    const swap = new Uint8ClampedArray(row);
    for (let top = 0, bottom = height - 1; top < bottom; top++, bottom--) {
      const a = top * row;
      const b = bottom * row;
      swap.set(pixels.subarray(a, a + row));
      pixels.copyWithin(a, b, b + row);
      pixels.set(swap, b);
    }
    return new ImageData(pixels, width, height);
  }

  /** 黒で塗る。**出せなくなったときに前の局の映像を残さない** */
  clear(): void {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}

function link(gl: WebGL2RenderingContext): WebGLProgram {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type) as WebGLShader;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`シェーダを作れません: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  };
  const program = gl.createProgram() as WebGLProgram;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(
      `シェーダをリンクできません: ${gl.getProgramInfoLog(program)}`,
    );
  }
  return program;
}
