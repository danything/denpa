/**
 * 解けた YUV を **WebGL2 で描く** (生で送る道。docs/stream.md §5.5)。worker の中で動く。
 *
 * 面は3枚 (Y・Cb・Cr) を別々のテクスチャに上げ、RGB への変換はシェーダでやる。
 * CPU で RGB にすると 1080 の1コマで 600 万画素ぶんの計算が毎コマ要る。
 *
 * ## インタレ解除は bob (フィールドごとに出して、抜けた行を上下から埋める)
 *
 * 放送は 1080i — 1コマに時刻の違う2枚 (フィールド) が1行おきに入っている。そのまま
 * 出すと動くところが櫛になる。焼く道の `bwdif` は前後のコマまで見て埋め方を選ぶが、
 * ここでは**そのフィールドの上下の行の平均**で埋めるだけにする:
 *
 * - **動きが 60 枚/秒のまま出る。** スポーツやスクロールする字幕が滑らか (焼く道と同じ)
 * - **前後のコマを持たなくてよい。** 上げたテクスチャ1組だけで描ける。GPU の手間も
 *   1画素につきテクスチャを2回読むだけで、どの端末でも誤差
 * - 引き換えに、**止まっている細かい模様 (テロップの縁) が上下に 1 行ぶん揺らいで見える**
 *   (bob の宿命)。前のコマと比べて止まっているところだけ織り直す (motion adaptive) 手は
 *   あるが、テクスチャを2組持って毎コマ比べることになる。まず bob で出して、実機で
 *   気になるようなら足す
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
 * 色差 (4:2:0) もインタレでは1行おきにフィールドが入れ替わるので、同じ埋め方をする。
 * 縦は行の真ん中を読む (隣の行と混ぜない)、横は LINEAR で補う (1440 → 1920 の引き伸ばし)
 */
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D planeY;
uniform sampler2D planeU;
uniform sampler2D planeV;
uniform int field;
uniform vec2 rows;
uniform mat3 matrix;
in vec2 uv;
out vec4 color;

float pick(sampler2D plane, float count) {
    if (field < 0) return texture(plane, uv).r;
    float row = min(floor(uv.y * count), count - 1.0);
    if (mod(row, 2.0) == float(field)) return texture(plane, vec2(uv.x, (row + 0.5) / count)).r;
    float above = row - 1.0 < 0.0 ? row + 1.0 : row - 1.0;
    float below = row + 1.0 > count - 1.0 ? row - 1.0 : row + 1.0;
    return 0.5 * (texture(plane, vec2(uv.x, (above + 0.5) / count)).r
        + texture(plane, vec2(uv.x, (below + 0.5) / count)).r);
}

void main() {
    // 放送は限定レンジ (Y 16〜235 / C 16〜240)
    float y = (pick(planeY, rows.x) - 16.0 / 255.0) * (255.0 / 219.0);
    float u = (pick(planeU, rows.y) - 128.0 / 255.0) * (255.0 / 224.0);
    float v = (pick(planeV, rows.y) - 128.0 / 255.0) * (255.0 / 224.0);
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
    private matrix = BT709;

    constructor(private readonly canvas: OffscreenCanvas) {
        // 描いたものを読み戻さないので、残しておく必要は無い
        const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false });
        if (gl === null) throw new Error('WebGL2 が使えません');
        this.gl = gl;
        this.program = link(gl);
        gl.useProgram(this.program);

        const quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const pos = gl.getAttribLocation(this.program, 'pos');
        gl.enableVertexAttribArray(pos);
        gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

        this.textures = ['planeY', 'planeU', 'planeV'].map((name, unit) => {
            const texture = gl.createTexture();
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.uniform1i(gl.getUniformLocation(this.program, name), unit);
            return texture;
        });
        // 面の幅は 4 の倍数とは限らない
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    }

    /**
     * 1コマ上げる。**大きさが変わったら器ごと作り直す** (局を変えると 1440 ⇔ 1920 がある)
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
        const sd = SD_SPACES.has(planes.colorspace) || (planes.colorspace === 2 && height <= 576);
        this.matrix = sd ? BT601 : BT709;
        for (let i = 0; i < 3; i++) {
            const w = i === 0 ? width : (width + 1) >> 1;
            const h = i === 0 ? height : (height + 1) >> 1;
            gl.activeTexture(gl.TEXTURE0 + i);
            gl.bindTexture(gl.TEXTURE_2D, this.textures[i]!);
            gl.pixelStorei(gl.UNPACK_ROW_LENGTH, planes.strides[i]!);
            const data = planes.data[i]!;
            if (resized) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
            else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, data);
        }
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    }

    /** 描く。`field` は 0 (上) / 1 (下) / -1 (プログレッシブ) */
    draw(field: number): void {
        const gl = this.gl;
        if (this.size.width === 0) return;
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.uniform1i(gl.getUniformLocation(this.program, 'field'), field);
        gl.uniform2f(
            gl.getUniformLocation(this.program, 'rows'),
            this.size.height,
            (this.size.height + 1) >> 1,
        );
        gl.uniformMatrix3fv(gl.getUniformLocation(this.program, 'matrix'), false, this.matrix);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    /** 黒で塗る。**出せなくなったときに前の局の絵を残さない** */
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
            throw new Error(`シェーダを組めません: ${gl.getShaderInfoLog(shader)}`);
        }
        return shader;
    };
    const program = gl.createProgram() as WebGLProgram;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`シェーダを繋げません: ${gl.getProgramInfoLog(program)}`);
    }
    return program;
}
