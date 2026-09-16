"""
撮った絵を docs/images へ置く。**止まっている絵はそのままの大きさ (1600×900) で、
動く絵は 1120×630 に縮めて** WebP にする。動く絵は、同じ絵が続くところを 1 枚に
まとめてその間だけ長く見せる (押した瞬間だけ変わる画面は、ほとんどのコマが同じ)。

    python3 scripts/docs-webp.py              # 撮ってあるぶん全部
    python3 scripts/docs-webp.py guide-anim   # 名前を挙げると、そのぶんだけ

元は scripts/capture-docs.ts が docs/images/.capture に置く。Pillow が要る。
"""
import json, os, sys
from pathlib import Path
from PIL import Image, ImageChops

SRC = Path(os.environ.get("OUT", "docs/images/.capture"))
DST = Path("docs/images")

want = sys.argv[1:]

# 止まっている絵。縮めない (README では小さく貼るが、押すと原寸で見られる)
for f in sorted(SRC.glob("*.png")):
    name = f.stem
    if want and name not in want:
        continue
    out = DST / f"{name}.webp"
    Image.open(f).convert("RGB").save(out, quality=80, method=6)
    print(name, "still", round(out.stat().st_size / 1024), "KB")

for d in sorted(SRC.glob("*.frames")):
    name = d.name[:-len(".frames")]
    if want and name not in want:
        continue
    delays = json.loads((d / "delays.json").read_text())
    files = sorted(p for p in d.glob("*.png"))
    frames, times = [], []
    for f, ms in zip(files, delays):
        im = Image.open(f).convert("RGB")
        # 撮るのは広い画面 (1600×900)、貼るのは 1120×630 まで縮めて軽くする
        if im.width > 1120:
            im = im.resize((1120, round(im.height * 1120 / im.width)), Image.LANCZOS)
        if frames and ImageChops.difference(frames[-1], im).getbbox() is None:
            times[-1] += ms          # 同じ絵 → 前のコマを長く
        else:
            frames.append(im)
            times.append(ms)
    # コマが多いと重くなる。40 コマを超えたら 1 つ飛ばしにして、その分だけ長く見せる
    while len(frames) > 40:
        frames = frames[::2]
        times = [times[i] + (times[i + 1] if i + 1 < len(times) else 0) for i in range(0, len(times), 2)]
    out = DST / f"{name}.webp"
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=times,
                   loop=0, quality=62, method=4)
    print(name, len(files), "->", len(frames), "frames", round(out.stat().st_size / 1024), "KB")
