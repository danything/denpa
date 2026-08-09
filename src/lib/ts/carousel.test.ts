import { describe, expect, test } from 'bun:test';
import { Carousel, KEEP_MODULES } from './carousel';

type Message = Parameters<Carousel['take']>[0];

function moduleOf(componentId: number, moduleId: number, version = 0): Message {
    return {
        type: 'moduleDownloaded',
        componentId,
        moduleId,
        version,
        files: [{ contentLocation: `/${moduleId}.bml`, contentType: {}, dataBase64: '' }],
    } as unknown as Message;
}

const pmt = { type: 'pmt', components: [{ pid: 2064, componentId: 96, streamType: 13 }] } as Message;
const programInfo = { type: 'programInfo', eventId: 1 } as unknown as Message;

describe('データ放送の覚え書き', () => {
    test('何も来ていなければ渡すものは無い', () => {
        expect(new Carousel().replay()).toEqual([]);
    });

    /*
     * **順が命。** 何番のコンポーネントを出すかが決まってからでないと、
     * モジュールを渡しても置き場所が無い
     */
    test('pmt を先に、そのあとモジュール', () => {
        const held = new Carousel();
        held.take(moduleOf(96, 1));
        held.take(pmt);
        held.take(programInfo);
        const out = held.replay();
        expect(out.map((message) => message.type)).toEqual(['pmt', 'programInfo', 'moduleDownloaded']);
    });

    /*
     * **版が上がると中身が変わる。** 古いほうを渡すと、いま出ている画面と
     * 食い違ったものが出る
     */
    test('同じモジュールは新しいほうで置き換わる', () => {
        const held = new Carousel();
        held.take(moduleOf(96, 4096, 1));
        held.take(moduleOf(96, 4096, 2));
        expect(held.held).toBe(1);
        expect(held.replay()).toEqual([moduleOf(96, 4096, 2)]);
    });

    test('コンポーネントが違えば別のものとして持つ', () => {
        const held = new Carousel();
        held.take(moduleOf(64, 0));
        held.take(moduleOf(96, 0));
        expect(held.held).toBe(2);
    });

    /*
     * **落とすのは古いほうから。** 新しいほうが、いま出ている画面に近い。
     * 来るたびに末尾へ動かしているので、**上書きされたものは若返る**
     */
    test('上限を超えたら古いほうから落とす', () => {
        const held = new Carousel();
        for (let id = 0; id < KEEP_MODULES; id++) held.take(moduleOf(96, id));
        // いちばん古いものを来させ直す。これは残るはず
        held.take(moduleOf(96, 0, 1));
        held.take(moduleOf(96, KEEP_MODULES));

        expect(held.held).toBe(KEEP_MODULES);
        const ids = held.replay().map((message) => (message as { moduleId: number }).moduleId);
        expect(ids).toContain(0);
        expect(ids).toContain(KEEP_MODULES);
        // 2番目に古かったものが落ちる
        expect(ids).not.toContain(1);
    });

    /** 覚えないものは、渡すものにも数にも出てこない */
    test('pcr と時刻は覚えない', () => {
        const held = new Carousel();
        held.take({ type: 'pcr', pcrBase: 1, pcrExtension: 0 } as unknown as Message);
        held.take({ type: 'currentTime', timeUnixMillis: 1 } as unknown as Message);
        expect(held.replay()).toEqual([]);
        expect(held.held).toBe(0);
    });

    /*
     * **配るかどうか。** サイドチャネルは映像と同じ1本なので、中身の変わらない
     * ものを流し続けると受け側がそれを捌くだけで手一杯になる (実際に詰まらせた)
     */
    describe('配る価値のあるものだけ通す', () => {
        test('pcr は通さない。時計は映像が持っている', () => {
            const held = new Carousel();
            expect(held.take({ type: 'pcr', pcrBase: 1, pcrExtension: 0 } as unknown as Message)).toBe(false);
        });

        test('pmt は変わったときだけ', () => {
            const held = new Carousel();
            expect(held.take(pmt)).toBe(true);
            expect(held.take({ ...pmt } as Message), '同じ表を配り直している').toBe(false);
            expect(held.take({ type: 'pmt', components: [] } as Message)).toBe(true);
        });

        test('programInfo も変わったときだけ', () => {
            const held = new Carousel();
            expect(held.take(programInfo)).toBe(true);
            expect(held.take({ ...programInfo } as Message)).toBe(false);
        });

        test('モジュールは毎回通す。版が上がっていなくても回ってくる', () => {
            const held = new Carousel();
            expect(held.take(moduleOf(96, 1))).toBe(true);
            expect(held.take(moduleOf(96, 1))).toBe(true);
        });

        test('知らない種別は通す。落とすかどうかを決めるのは受け側', () => {
            const held = new Carousel();
            expect(held.take({ type: 'currentTime', timeUnixMillis: 1 } as unknown as Message)).toBe(true);
        });
    });

    test('pmt は差し替わったら上書きする', () => {
        const held = new Carousel();
        held.take(pmt);
        const next = { type: 'pmt', components: [] } as Message;
        held.take(next);
        expect(held.replay()).toEqual([next]);
    });
});
