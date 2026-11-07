// denpa.ico を作る。形は static/favicon.svg と同じ電波塔 (暗い角丸の四角に、水色の電波と塔)。
//   dotnet run tray/Denpa.Tray/make-icon.cs tray/Denpa.Tray/denpa.ico
// ICO の中身は 32 bit の DIB で、ライブラリを使わずに書く。縁は 1 ピクセルを 4×4 に割って塗り、ぼかす
// (通知領域の 16〜24 ピクセルでもつぶれにくい)。座標は favicon.svg と同じ 32 の升目で書く。

var output = args.Length > 0 ? args[0] : "denpa.ico";
int[] sizes = [16, 20, 24, 32, 40, 48, 64];
var images = sizes.Select(s => (Size: s, Data: Dib(s))).ToList();

using (var file = File.Create(output))
using (var w = new BinaryWriter(file))
{
    w.Write((short)0);
    w.Write((short)1);
    w.Write((short)images.Count);
    var offset = 6 + 16 * images.Count;
    foreach (var (s, data) in images)
    {
        w.Write((byte)s);
        w.Write((byte)s);
        w.Write((byte)0);
        w.Write((byte)0);
        w.Write((short)1);
        w.Write((short)32);
        w.Write(data.Length);
        w.Write(offset);
        offset += data.Length;
    }
    foreach (var (_, data) in images) w.Write(data);
}

// 地の色 #1d232a、電波と塔の色 #7dd3fc
static byte[] Dib(int s)
{
    const int n = 4;
    var px = new byte[s * s * 4];
    for (var y = 0; y < s; y++)
    for (var x = 0; x < s; x++)
    {
        double r = 0, g = 0, b = 0, a = 0;
        for (var j = 0; j < n; j++)
        for (var i = 0; i < n; i++)
        {
            var u = (x + (i + 0.5) / n) * 32.0 / s;
            var v = (y + (j + 0.5) / n) * 32.0 / s;
            if (!InRoundRect(u, v)) continue;
            var fg = Mark(u, v);
            r += fg ? 0x7d : 0x1d;
            g += fg ? 0xd3 : 0x23;
            b += fg ? 0xfc : 0x2a;
            a += 1;
        }
        var k = ((s - 1 - y) * s + x) * 4; // 下の行から
        if (a > 0)
        {
            px[k] = (byte)Math.Round(b / a);
            px[k + 1] = (byte)Math.Round(g / a);
            px[k + 2] = (byte)Math.Round(r / a);
        }
        px[k + 3] = (byte)Math.Round(255 * a / (n * n));
    }
    var mask = new byte[(s + 31) / 32 * 4 * s];
    using var ms = new MemoryStream();
    using var w = new BinaryWriter(ms);
    w.Write(40); w.Write(s); w.Write(s * 2); w.Write((short)1); w.Write((short)32);
    w.Write(0); w.Write(px.Length + mask.Length); w.Write(0); w.Write(0); w.Write(0); w.Write(0);
    w.Write(px);
    w.Write(mask);
    return ms.ToArray();
}

// rect width=32 height=32 rx=6
static bool InRoundRect(double u, double v)
{
    const double rx = 6;
    var qx = Math.Max(0, Math.Max(rx - u, u - (32 - rx)));
    var qy = Math.Max(0, Math.Max(rx - v, v - (32 - rx)));
    return qx * qx + qy * qy <= rx * rx;
}

static bool Mark(double u, double v)
{
    // circle cx=16 cy=14 r=2.5
    if ((u - 16) * (u - 16) + (v - 14) * (v - 14) <= 2.5 * 2.5) return true;
    // path M16 16.5 13 27h6z (塔)
    if (InTriangle(u, v, (16, 16.5), (13, 27), (19, 27))) return true;
    // 電波 4 本 (stroke-width 2、端は丸)。a8 8 で弦 10 と、a13 13 で弦 17 の弧
    return OnArc(u, v, 11, 9, 19, 8, left: true) || OnArc(u, v, 21, 9, 19, 8, left: false)
        || OnArc(u, v, 7.5, 5.5, 22.5, 13, left: true) || OnArc(u, v, 24.5, 5.5, 22.5, 13, left: false);
}

// (x, top) から (x, bottom) への半径 r の小さい弧。left なら左へふくらむ。線の幅は 2 (中心から 1)
static bool OnArc(double u, double v, double x, double top, double bottom, double r, bool left)
{
    var half = (bottom - top) / 2;
    var cy = (top + bottom) / 2;
    var cx = left ? x + Math.Sqrt(r * r - half * half) : x - Math.Sqrt(r * r - half * half);
    var dx = u - cx;
    var dy = v - cy;
    // 弧の範囲 (中心から見て、弦の両端の間) の中なら、円からの距離
    if ((left ? dx < 0 : dx > 0) && Math.Abs(dy) / Math.Sqrt(dx * dx + dy * dy) <= half / r)
        return Math.Abs(Math.Sqrt(dx * dx + dy * dy) - r) <= 1;
    // 外なら、両端の丸
    return (u - x) * (u - x) + (v - top) * (v - top) <= 1 || (u - x) * (u - x) + (v - bottom) * (v - bottom) <= 1;
}

static bool InTriangle(double u, double v, (double X, double Y) a, (double X, double Y) b, (double X, double Y) c)
{
    double Side((double X, double Y) p, (double X, double Y) q) => (q.X - p.X) * (v - p.Y) - (q.Y - p.Y) * (u - p.X);
    var d1 = Side(a, b);
    var d2 = Side(b, c);
    var d3 = Side(c, a);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
