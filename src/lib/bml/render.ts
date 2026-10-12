/**
 * 文書 ([document.ts](document.ts)) をページに描く。
 *
 * - 作るのは絶対配置の div / span / br と、画像の img だけ。**innerHTML も属性の写しも
 *   使わない** — 字は textContent、見た目は確かめた値 (px の数・CLUT の色・列挙) から組んだ
 *   style だけ。放送の on* や任意の属性がページに出ることは無い
 * - 映像は動かさない。映像の object の場所を `onVideoRect` で知らせ、そこより前に描くものの
 *   背景には穴を開ける (映像は下に居て、穴から見える。web-bml の clipVideoPlane と同じ考え)
 * - 文書の世代 (`generation`) が変わったときだけ描き直す。変わった style だけ書き換える
 */

import { cssColor, type Rgba } from './clut';
import { parseUrl } from './css';
import type { BmlDocument, BmlElement, BmlNode } from './document';
import { isDrcs, toDisplay } from './euc';
import { visibleFrames } from './mng';
import type { Computed } from './style';

export interface Fonts {
    /** 丸ゴシック (CSS の font-family の並び) */
    round: string;
    /** 太丸ゴシック */
    boldRound: string;
    /** 角ゴシック */
    square: string;
}

export interface Rect {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** 描くのに要るもの (エンジンが渡す) */
export interface RenderHost {
    fonts: Fonts;
    clut(): readonly Rgba[];
    /** 画面の大きさ (resolution) */
    resolution(): { width: number; height: number };
    /** 文書の中の URL を、描ける URL (blob:) にする。まだ無ければ null (届いたら描き直す) */
    image(url: string, kind: 'background' | 'object', type: string): ImageSource | null;
    /** DRCS の絵 (mask に使う URL)。無ければ null */
    drcs(unit: number, fontSize: number, family: string): string | null;
    /**
     * 動く絵 (MNG) を決めた回数だけ動かし終えた。streamstatus を pause にし、出しているコマを
     * streamposition にするのはエンジン (付属2 4.8.5.3「回し終えたら pause」)
     */
    finished(element: BmlElement, position: number): void;
}

/** 動く絵のコマ (描ける URL と置き方) */
export interface AnimationFrame {
    url: string;
    x: number;
    y: number;
    /** 次のコマまでの間 (ミリ秒) */
    delay: number;
    /** 前のコマの上に重ねるか (false なら消してから描く) */
    keep: boolean;
}

export interface ImageSource {
    url: string;
    width: number | null;
    height: number | null;
    /** 動く絵 (MNG)。`url` は 1 コマ目 */
    animation?: { frames: AnimationFrame[]; iterations: number };
}

/** 動かしている MNG */
interface Playing {
    key: string;
    timer: ReturnType<typeof setTimeout> | null;
    layer: HTMLElement;
}

interface View {
    element: HTMLElement;
    /** 最後に書いた style (同じなら書かない) */
    css: string;
    /** 背景の穴を開けるための下敷き (映像を含む要素だけ) */
    under: HTMLElement | null;
    underCss: string;
    image: HTMLImageElement | null;
    imageKey: string;
    /** 動かしている MNG (object だけ) */
    playing: Playing | null;
}

interface TextView {
    container: HTMLElement;
    key: string;
}

const VIDEO_TYPES = new Set(['video/x-arib-mpeg2', 'video/x-arib-h264', 'video/x-arib-h265']);

export function isVideo(element: BmlElement): boolean {
    return element.tag === 'object' && VIDEO_TYPES.has((element.attr('type') ?? '').toLowerCase());
}

/** 映像の object と、その場所 (画面の座標。祖先の位置と枠と、はみ出しの切り取りを足したもの) */
export function videoRect(document: BmlDocument): { element: BmlElement; rect: Rect } | null {
    for (const element of document.root.descendants()) {
        if (!isVideo(element)) continue;
        // 見える見えないは継いだ結果 (祖先が hidden でも、object が visible と書けば CSS と同じく見える)
        if (!element.style().visible) return null;
        let { left, top } = element.style();
        let { width, height } = element.style();
        for (let parent = element.parent; parent !== null && parent.tag !== 'body'; parent = parent.parent) {
            const s = parent.style();
            const inset = s.borderStyle === 'none' ? 0 : s.borderWidth;
            // 子は親の枠の内側 (padding の箱) から置く。div の padding は既定のスタイルで 0 に固定
            left += s.left + inset;
            top += s.top + inset;
            // 親ははみ出しを切る
            const right = Math.min(left + width, s.left + inset + s.width);
            const bottom = Math.min(top + height, s.top + inset + s.height);
            left = Math.max(left, s.left + inset);
            top = Math.max(top, s.top + inset);
            width = Math.max(0, right - left);
            height = Math.max(0, bottom - top);
        }
        return { element, rect: { left, top, width, height } };
    }
    return null;
}

/** 四角に穴を開ける clip-path (要素の中の座標) */
function hole(rect: Rect): string {
    const { left: l, top: t } = rect;
    const r = rect.left + rect.width;
    const b = rect.top + rect.height;
    return `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${l}px ${t}px, ${r}px ${t}px, ${r}px ${b}px, ${l}px ${b}px, ${l}px ${t}px)`;
}

export class Renderer {
    private readonly views = new Map<BmlElement, View>();
    private readonly texts = new Map<BmlNode, TextView>();
    private drawn = -1;
    /** 最後に知らせた映像の場所 (初めの描画では必ず知らせる) */
    private lastVideo: string | null = null;
    readonly root: HTMLDivElement;

    constructor(
        container: HTMLElement | ShadowRoot,
        private readonly document: BmlDocument,
        private readonly host: RenderHost,
        private readonly onVideoRect: (rect: Rect | null) => void,
    ) {
        const owner = (container instanceof ShadowRoot ? container.host : container).ownerDocument;
        this.root = owner.createElement('div');
        this.root.style.cssText = 'position:absolute;left:0;top:0;overflow:hidden;';
        this.build(document.root, this.root);
        container.appendChild(this.root);
    }

    destroy(): void {
        for (const view of this.views.values()) this.stopAnimation(view);
        this.root.remove();
        this.views.clear();
        this.texts.clear();
    }

    /** 変わっていれば描き直す */
    draw(force = false): void {
        if (!force && this.drawn === this.document.generation) return;
        this.drawn = this.document.generation;
        const { width, height } = this.host.resolution();
        this.root.style.width = `${width}px`;
        this.root.style.height = `${height}px`;
        const video = videoRect(this.document);
        const key = video === null ? '' : JSON.stringify(video.rect);
        if (key !== this.lastVideo) {
            this.lastVideo = key;
            this.onVideoRect(video?.rect ?? null);
        }
        // 映像より前 (文書の順) の要素と、映像を含む要素の背景に穴を開ける
        const before = new Set<BmlElement>();
        const containing = new Set<BmlElement>();
        if (video !== null) {
            for (let p = video.element.parent; p !== null; p = p.parent) containing.add(p);
            for (const element of this.document.root.descendants()) {
                if (element === video.element) break;
                if (!containing.has(element)) before.add(element);
            }
        }
        // 要素の枠の左上 (border-box。画面の座標)。clip-path の基準はここ
        const corners = new Map<BmlElement, { left: number; top: number }>();
        const inset = (element: BmlElement): number => {
            const s = element.style();
            return element.tag === 'body' || s.borderStyle === 'none' ? 0 : s.borderWidth;
        };
        const corner = (element: BmlElement): { left: number; top: number } => {
            const known = corners.get(element);
            if (known !== undefined) return known;
            const parent = element.parent;
            let at = { left: 0, top: 0 };
            if (parent !== null && element.tag !== 'body') {
                // 子は親の枠の内側から置く (div の padding は既定のスタイルで 0 に固定)
                const p = corner(parent);
                const s = element.style();
                at = { left: p.left + inset(parent) + s.left, top: p.top + inset(parent) + s.top };
            }
            corners.set(element, at);
            return at;
        };
        for (const [element, view] of this.views) {
            const s = element.style();
            let clip: string | null = null;
            if (video !== null && (before.has(element) || containing.has(element))) {
                // 映像を含む要素は、枠の内側に敷く下敷きに穴を開ける
                const base = corner(element);
                const shift = containing.has(element) ? inset(element) : 0;
                const at = { left: base.left + shift, top: base.top + shift };
                const local = {
                    ...video.rect,
                    left: video.rect.left - at.left,
                    top: video.rect.top - at.top,
                };
                clip = hole(local);
            }
            this.apply(element, view, s, clip, containing.has(element));
        }
        for (const [node, view] of this.texts) this.text(node, view);
    }

    private build(element: BmlElement, parent: HTMLElement): void {
        const owner = parent.ownerDocument;
        let target = parent;
        switch (element.tag) {
            case 'body':
            case 'div':
            case 'p':
            case 'object':
            case 'input':
            case 'span':
            case 'a': {
                const inline = element.tag === 'span' || element.tag === 'a';
                const made = owner.createElement(inline ? 'span' : 'div');
                parent.appendChild(made);
                this.views.set(element, {
                    element: made,
                    css: '',
                    under: null,
                    underCss: '',
                    image: null,
                    imageKey: '',
                    playing: null,
                });
                target = made;
                break;
            }
            case 'br':
                parent.appendChild(owner.createElement('br'));
                return;
            case 'bml':
                break;
            default:
                // head・script・style・bevent などは描かない
                return;
        }
        for (const child of element.children) {
            if (child.kind === 'element') {
                this.build(child, target);
                continue;
            }
            if (element.tag === 'object') continue;
            const container = owner.createElement('span');
            target.appendChild(container);
            this.texts.set(child, { container, key: '' });
        }
    }

    private family(name: string): string {
        const fonts = this.host.fonts;
        if (name.includes('角ゴシック')) return fonts.square;
        if (name.includes('太丸ゴシック')) return fonts.boldRound;
        return fonts.round;
    }

    private apply(
        element: BmlElement,
        view: View,
        s: Computed,
        clip: string | null,
        contains: boolean,
    ): void {
        const clut = this.host.clut();
        const css: string[] = [];
        const inline = element.tag === 'span' || element.tag === 'a';
        const block = !inline;
        if (element.tag === 'body') {
            const { width, height } = this.host.resolution();
            css.push(`position:absolute;left:0;top:0;width:${width}px;height:${height}px;overflow:hidden`);
        } else if (block) {
            css.push(
                `position:absolute;left:${s.left}px;top:${s.top}px;width:${s.width}px;height:${s.height}px;overflow:hidden`,
            );
        }
        css.push(`visibility:${s.visible ? 'visible' : 'hidden'}`);
        const background =
            element.tag === 'object'
                ? 'transparent'
                : (s.backgroundColor ?? cssColor(clut[s.backgroundColorIndex]));
        let image: string | null = null;
        if (s.backgroundImage !== null) {
            const url = parseUrl(s.backgroundImage);
            const source = url === null ? null : this.host.image(url, 'background', 'image/jpeg');
            if (source !== null) {
                image = `background-image:url("${source.url}");background-repeat:${element.tag === 'body' ? 'repeat' : 'no-repeat'}`;
                // 960x540 の画面では静止画を半分の大きさで描く (960x540 の画像はそのまま)
                if (source.width !== null && source.height !== null && this.host.resolution().width === 960) {
                    const full = source.width === 960 && source.height === 540;
                    const scale = full ? 1 : 0.5;
                    image += `;background-size:${source.width * scale}px ${source.height * scale}px`;
                }
            }
        }
        // 映像を含む要素は、背景を下敷きに移して穴を開ける (子は切らない)
        const moveBackground = contains && clip !== null;
        if (!moveBackground) {
            css.push(`background-color:${background}`);
            if (image !== null) css.push(image);
        }
        // 行内の要素 (span・a) は親の p の clip-path に一緒に切られる
        if (clip !== null && !contains && block) css.push(`clip-path:${clip}`);
        if (block && s.borderStyle !== 'none' && s.borderWidth > 0) {
            const [t, r, b, l] = s.borderColorIndex.map((i) => cssColor(clut[i]));
            css.push(`border:${s.borderWidth}px ${s.borderStyle === 'solid' ? 'solid' : s.borderStyle}`);
            css.push(`border-color:${t} ${r} ${b} ${l}`);
        }
        if (block) css.push(`padding:${s.padding.map((n) => `${n}px`).join(' ')}`);
        css.push(`color:${s.color ?? cssColor(clut[s.colorIndex])}`);
        css.push(`font-family:${this.family(s.fontFamily)}`);
        css.push(`font-size:${s.fontSize}px`);
        css.push(
            `font-weight:${s.fontWeight === 'bold' || s.fontFamily.includes('太丸') ? 'bold' : 'normal'}`,
        );
        css.push(`line-height:${s.lineHeight ?? s.fontSize}px`);
        css.push(`text-align:${s.textAlign}`);
        css.push(`letter-spacing:${s.letterSpacing}px`);
        if (element.tag === 'p' || element.tag === 'input') {
            css.push('white-space:pre-wrap;word-break:break-all;line-break:anywhere;overflow-wrap:anywhere');
        }
        css.push('box-sizing:content-box;margin:0');
        const text = css.join(';');
        if (text !== view.css) {
            view.css = text;
            view.element.style.cssText = text;
        }
        this.under(
            view,
            moveBackground
                ? `position:absolute;left:0;top:0;width:100%;height:100%;background-color:${background};${image ?? ''};clip-path:${clip}`
                : '',
        );
        if (element.tag === 'object') this.objectImage(element, view);
    }

    private under(view: View, css: string): void {
        if (css === view.underCss) return;
        view.underCss = css;
        if (css === '') {
            view.under?.remove();
            view.under = null;
            return;
        }
        if (view.under === null) {
            view.under = view.element.ownerDocument.createElement('div');
            view.element.prepend(view.under);
        }
        view.under.style.cssText = css;
    }

    /**
     * MNG を出す (付属2 4.8.5.3)。streamstatus が stop なら出さない、pause なら streamposition の
     * コマ、play ならそこから動かす (くり返しは TERM の回数 × streamlooping)。回し終えたら
     * 最後のコマのまま pause にする (エンジンが属性を書く)
     */
    private mng(element: BmlElement, view: View, data: string): void {
        const status = (element.attr('streamstatus') ?? 'stop').toLowerCase();
        const position = Math.max(0, Number.parseInt(element.attr('streamposition') ?? '0', 10) || 0);
        const source =
            status === 'stop' || data === '' ? null : this.host.image(data, 'object', 'image/x-arib-mng');
        const animation = source?.animation;
        const looping = Math.max(1, Number.parseInt(element.attr('streamlooping') ?? '1', 10) || 1);
        const key =
            animation === undefined ? '' : `${source!.url}\u0000${status}\u0000${position}\u0000${looping}`;
        if (key === (view.playing?.key ?? '')) return;
        this.stopAnimation(view);
        if (animation === undefined || animation.frames.length === 0) return;
        const owner = view.element.ownerDocument;
        const layer = owner.createElement('div');
        layer.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden';
        view.element.appendChild(layer);
        const playing: Playing = { key, timer: null, layer };
        view.playing = playing;
        const frames = animation.frames;
        const show = (index: number): void => {
            const imgs = visibleFrames(frames, index).map((frame) => {
                const img = owner.createElement('img');
                img.alt = '';
                img.src = frame.url;
                img.style.cssText = `position:absolute;left:${frame.x}px;top:${frame.y}px;display:block`;
                return img;
            });
            layer.replaceChildren(...imgs);
        };
        let index = Math.min(position, frames.length - 1);
        show(index);
        if (status !== 'play') return;
        let rounds = animation.iterations * looping;
        const step = (): void => {
            playing.timer = setTimeout(() => {
                if (view.playing !== playing) return;
                if (index + 1 < frames.length) {
                    index++;
                } else if (--rounds > 0) {
                    index = 0;
                } else {
                    playing.timer = null;
                    this.host.finished(element, index);
                    return;
                }
                show(index);
                step();
            }, frames[index]!.delay);
        };
        step();
    }

    private stopAnimation(view: View): void {
        const playing = view.playing;
        if (playing === null) return;
        if (playing.timer !== null) clearTimeout(playing.timer);
        playing.layer.remove();
        view.playing = null;
    }

    private objectImage(element: BmlElement, view: View): void {
        const type = (element.attr('type') ?? '').toLowerCase();
        const data = element.attr('data') ?? '';
        if (type === 'image/x-arib-mng') {
            this.mng(element, view, data);
            return;
        }
        const drawable = type === 'image/jpeg' || type === 'image/x-arib-png' || type === 'image/gif';
        const source = drawable && data !== '' ? this.host.image(data, 'object', type) : null;
        const key = source === null ? '' : source.url;
        if (key === view.imageKey) return;
        view.imageKey = key;
        if (source === null) {
            view.image?.remove();
            view.image = null;
            return;
        }
        if (view.image === null) {
            view.image = view.element.ownerDocument.createElement('img');
            view.image.alt = '';
            view.element.appendChild(view.image);
        }
        const img = view.image;
        img.style.cssText = 'position:absolute;left:0;top:0;display:block;';
        img.src = source.url;
        const size = (width: number, height: number): void => {
            // JPEG は 960x540 の画面で半分の大きさ (付属2 表5-3。960x540 で 960x540 の画像だけそのまま)
            let w = width;
            let h = height;
            if (type === 'image/jpeg' && this.host.resolution().width === 960) {
                const s = element.style();
                if (!(s.width === 960 && s.height === 540 && width === 960 && height === 540)) {
                    w = Math.floor(width / 2);
                    h = Math.floor(height / 2);
                }
            }
            img.style.width = `${w}px`;
            img.style.height = `${h}px`;
        };
        if (source.width !== null && source.height !== null) {
            img.onload = null;
            size(source.width, source.height);
        } else {
            img.onload = () => size(img.naturalWidth, img.naturalHeight);
        }
    }

    /** 字を描く。DRCS は 1 字ずつ mask の span に (色は字の色) */
    private text(node: BmlNode, view: TextView): void {
        if (node.kind !== 'text') return;
        const parent = node.parent;
        const s = parent?.style();
        const family = s === undefined ? '' : s.fontFamily;
        const size = s?.fontSize ?? 24;
        const data = node.data;
        let drcs = false;
        for (let i = 0; i < data.length && !drcs; i++) drcs = isDrcs(data.charCodeAt(i));
        const key = drcs ? `${data}\u0000${size}\u0000${family}` : data;
        if (key === view.key) return;
        view.key = key;
        const owner = view.container.ownerDocument;
        if (!drcs) {
            view.container.textContent = toDisplay(data);
            return;
        }
        view.container.replaceChildren();
        let run = '';
        const flush = (): void => {
            if (run === '') return;
            view.container.append(owner.createTextNode(toDisplay(run)));
            run = '';
        };
        for (let i = 0; i < data.length; i++) {
            const unit = data.charCodeAt(i);
            if (!isDrcs(unit)) {
                run += data[i];
                continue;
            }
            flush();
            const glyph = owner.createElement('span');
            const mask = this.host.drcs(unit, size, family);
            const css = [`display:inline-block;width:${size}px;height:${size}px;vertical-align:text-bottom`];
            if (mask !== null) {
                css.push(
                    `background-color:currentColor;mask-image:url("${mask}");-webkit-mask-image:url("${mask}")`,
                );
                css.push('mask-size:100% 100%;-webkit-mask-size:100% 100%');
            }
            glyph.style.cssText = css.join(';');
            view.container.append(glyph);
        }
        flush();
    }
}
