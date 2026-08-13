import { describe, expect, test } from 'bun:test';
import { closeSync, mkdtempSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    buildArgs,
    buildConcatArgs,
    buildSegmentArgs,
    concatList,
    failureReason,
    findInputFd,
    headSkip,
    inputProgress,
    isVideoCodec,
    parseOutFrames,
    pickSmooth,
    readInputPos,
} from './encoder';

function argValue(args: string[], key: string): string | undefined {
    const i = args.indexOf(key);
    return i === -1 ? undefined : args[i + 1];
}

describe('録画エンコードの引数', () => {
    test('既定は AV1 8bit で、コマ数は増やさない', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null);
        expect(args).toContain('libsvtav1');
        // send_field だとコマ数が倍になり、時間もサイズも約2倍になる
        expect(argValue(args, '-vf')).toBe('bwdif=mode=send_frame,format=yuv420p');
        expect(args.at(-1)).toBe('/out.mkv');
    });

    /*
     * **上流の既定に任せない。** SVT-AV1 の既定 preset は版で変わる (2.3.0 は 10、
     * 4.2.0 は 8)。渡していなかった頃のまま入れ替えると、実測で時間 +32%・
     * 大きさ +27% になった。値そのものは 2.3.0 の既定と同じ
     */
    test('AV1 の preset と crf は書いてある', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null);
        expect(argValue(args, '-preset')).toBe('10');
        expect(argValue(args, '-crf')).toBe('35');
    });

    test('なめらかにすると1フィールドごとに1コマ出す', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', { smoothMotion: true });
        expect(argValue(args, '-vf')).toBe('bwdif,format=yuv420p');
    });

    /*
     * **どちらのコーデックも 8bit。**
     *
     * AV1 は 10bit で出していた。根拠が残っていなかったので測ったところ、
     * 10bit は 1.7% 小さく SSIM +0.0011 (実写100秒: 39秒 21.71MB 0.97582 ↔
     * 34秒 22.09MB 0.97472)。**差はあるが 2% で、15% 遅くなるぶんと
     * 引き合わない。** そのうえ Main10 を解ける相手が要る — 元の放送が
     * 8bit なのだから、8bit で出す
     */
    test('10bit では出さない', () => {
        for (const codec of ['av1', 'h264'] as const) {
            const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, codec);
            expect(argValue(args, '-vf'), codec).not.toContain('10le');
        }
    });
});

/**
 * **焼いたものの音声と字幕に名前を入れる** (`arib.audioTitles` / `buildPgs`)。
 *
 * 入れていなかった頃は、プレイヤーの切り替えに「Audio 1」「Audio 2」しか
 * 出なかった — 二カ国語や解説放送でどちらがどちらか分からない。
 */
describe('トラックの名前', () => {
    const title = (args: string[], key: string) => argValue(args, key);

    test('音声に番組表と同じ名前を入れる', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', {
            audioTitles: ['主音声 (日本語)', '解説 (日本語)'],
        });
        expect(title(args, '-metadata:s:a:0')).toBe('title=主音声 (日本語)');
        expect(title(args, '-metadata:s:a:1')).toBe('title=解説 (日本語)');
    });

    /*
     * **多すぎても困らない。** 番組表が言っている本数と実際に入っている本数は
     * 食い違いうるが、ffmpeg は在りもしないトラックへの指定を黙って読み飛ばす
     * (実機で確認)。名前が無いものは何も言わない
     */
    test('名前が無ければ何も言わない', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null);
        expect(args.some((arg) => arg.startsWith('-metadata:s:a:'))).toBe(false);
    });

    test('空の名前は入れない', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', { audioTitles: ['', '副音声'] });
        expect(args).not.toContain('-metadata:s:a:0');
        expect(title(args, '-metadata:s:a:1')).toBe('title=副音声');
    });

    /** 字幕は放送が名乗っている言語まで入れる。無ければ「字幕」 */
    test('字幕にも名前を入れる', () => {
        const withLabel = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', {
            pgsFile: '/x.sup',
            captionTitle: '字幕 (日本語)',
        });
        expect(title(withLabel, '-metadata:s:s:0')).toBe('title=字幕 (日本語)');

        const plain = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', { pgsFile: '/x.sup' });
        expect(title(plain, '-metadata:s:s:0')).toBe('title=字幕');
    });
});

describe('コマ数の決め方', () => {
    test('ffmpeg の stderr から書き出したコマ数を読む (最後の frame= を採る)', () => {
        const stderr = 'frame=  100 fps=0.0 q=-0.0\nframe=  967 fps=120 q=-0.0 Lsize=N/A time=00:00:50';
        expect(parseOutFrames(stderr)).toBe(967);
        expect(Number.isNaN(parseOutFrames('no frames here'))).toBe(true);
    });

    test('同じ絵が並ぶ素材 (生存率が低い) は30コマ', () => {
        // 実測: アニメの本編は 21〜32% (乙女ゲー 21% / 幼女戦記 32%)
        expect(pickSmooth([0.21, 0.32, 0.28], 0.45)).toBe(false);
    });

    test('全コマ動く素材 (生存率が高い) は60コマ', () => {
        // 実測: フジの生放送は 71%
        expect(pickSmooth([0.71, 0.68, 0.75], 0.45)).toBe(true);
    });

    test('中央値で見る。1窓だけCMや白場に当たっても引きずられない', () => {
        // 2窓が本編 (低い)、1窓がCM (高い) → 30コマ
        expect(pickSmooth([0.25, 0.3, 0.8], 0.45)).toBe(false);
        // 逆に1窓だけ静止画に当たった実写 → 60コマ
        expect(pickSmooth([0.2, 0.7, 0.75], 0.45)).toBe(true);
    });

    test('測れなければ60コマに倒す (動きは絶対に落とさない)', () => {
        expect(pickSmooth([], 0.45)).toBe(true);
        expect(pickSmooth([Number.NaN, 0], 0.45)).toBe(true);
    });

    test('入れ物は拡張子ではなく引数で決める', () => {
        // 書いている間は .mkv.encoding という名前なので、拡張子からは決まらない
        const args = buildArgs('/in.m2ts', '/out.mkv.encoding', 1, null);
        expect(argValue(args, '-f')).toBe('matroska');
        expect(args.at(-1)).toBe('/out.mkv.encoding');
    });

    test('h264 を選ぶと x264 の 8bit になる', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'h264');
        expect(args).toContain('libx264');
        expect(args).not.toContain('libsvtav1');
        expect(argValue(args, '-vf')).toBe('bwdif=mode=send_frame,format=yuv420p');
        expect(args).toContain('-preset');
    });

    test('字幕は PGS 1本だけ。入力も1回しか開かない', () => {
        for (const codec of ['av1', 'h264'] as const) {
            const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, codec, { pgsFile: '/tmp/s.sup' });
            /*
             * ASS (外字が「〓」になる) と dvdsub (1枚4色) を作るために同じ入力を
             * 2回開いていた頃の名残を残さない。PGS が放送どおりに出るので、
             * 見た目の違うものを「字幕」として並べる理由が無くなった
             */
            expect(args.filter((a) => a === '/in.m2ts')).toHaveLength(1);
            expect(args).not.toContain('ass');
            expect(args).not.toContain('dvdsub');
            expect(argValue(args, '-c:s:0')).toBe('copy');
            expect(argValue(args, '-disposition:s:0')).toBe('default');
            expect(argValue(args, '-c:s:1')).toBeUndefined();
            expect(argValue(args, '-c:a')).toBe('libopus');
        }
    });

    test('画面の大きさはここでは使わない', () => {
        // 絵にするのは .sup を作る側 (buildPgs)。エンコード側は copy するだけ
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', { canvasSize: '1920x1080' });
        expect(args).not.toContain('-canvas_size');
    });

    test('デュアルモノは左右を別トラックに分ける', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 2, null);
        expect(argValue(args, '-filter_complex')).toContain('channelsplit');
        expect(args).toContain('language=jpn');
        expect(args).toContain('language=und');
    });

    test('再試行時は頭を捨てる', () => {
        expect(argValue(buildArgs('/in.m2ts', '/out.mkv', 1, 0.2), '-ss')).toBe('0.2');
    });

    test('CMを切っても字幕は落とさない', () => {
        // CMはエンコードの前にTSの段階で切るので、エンコード側は素直に字幕を通すだけ
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', {
            keep: [{ start: 0, end: 300 }],
            pgsFile: '/tmp/s.sup',
        });
        expect(args).not.toContain('-sn');
        expect(argValue(args, '-c:s:0')).toBe('copy');
    });

    test('チャプターだけならそれが2つ目の入力になる', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', { chaptersFile: '/tmp/c.txt' });
        expect(args).toContain('/tmp/c.txt');
        expect(argValue(args, '-map_chapters')).toBe('1');
    });

    test('PGS は copy でそのまま入れる', () => {
        /*
         * 放送どおりの色数 (1枚256色) が入るのはこれだけ。ffmpeg は PGS を
         * 作れないので denpa が .sup を書いて渡す (src/lib/pgs.ts)
         */
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', { pgsFile: '/tmp/s.sup' });
        expect(args).toContain('/tmp/s.sup');
        expect(args).toContain('1:s:0?');
        expect(argValue(args, '-c:s:0')).toBe('copy');
    });

    test('PGS とチャプターが両方あっても番号がずれない', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', {
            pgsFile: '/tmp/s.sup',
            chaptersFile: '/tmp/c.txt',
        });
        expect(args).toContain('1:s:0?');
        // 入力は 本編 / sup / チャプター の順
        expect(argValue(args, '-map_chapters')).toBe('2');
    });

    /**
     * TS は音声のほうが先に始まっていることが多い。実機では映像の1コマ目が
     * 0.930 秒あとで、焼き上がりも音声だけの区間から始まっていた。
     * 1コマ目を 0 秒として数えるプレイヤーでは、そのぶん字幕が早く出る。
     *
     * **ずらすのではなく捨てる。** `-output_ts_offset` では直らなかった —
     * Matroska は負の時刻を持てないので、下がった音声を muxer が押し戻し、
     * 全トラックまとめて元の位置に戻る (実測: 0.363 渡して動いたのは 0.022 だけ)。
     * 捨てれば映像も音声も 0.000 から始まる (実測で確認)
     */
    test('映像が出るまでの音声だけの区間は捨てる', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', { videoStart: 0.93 });
        expect(argValue(args, '-ss')).toBe('0.93');
        // ずらす方式は効かないので使わない
        expect(args).not.toContain('-output_ts_offset');
    });

    test('捨てるのは入力側 (最初の -i より前)', () => {
        // 出力側に置くと、読み飛ばさずに全部復号してから捨てることになる
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', { videoStart: 0.93 });
        expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    });

    test('ほぼ 0 なら捨てない', () => {
        // 数ミリ秒のずれのために seek を掛けても、得るものが無い
        expect(argValue(buildArgs('/in.m2ts', '/out.mkv', 1, null), '-ss')).toBeUndefined();
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', { videoStart: 0.02 });
        expect(argValue(args, '-ss')).toBeUndefined();
    });

    test('再試行の頭捨てと足し算になる', () => {
        // 再試行 (PAT/PMT が固まる前) と音声だけの区間は別の理由。両方捨てる
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, 0.2, 'av1', { videoStart: 0.93 });
        expect(Number(argValue(args, '-ss'))).toBeCloseTo(1.13, 5);
    });

    /**
     * 地上波HDは 1440x1080 の横長画素で送られてくる。添え書きを見ない
     * 添え書きを見ないプレイヤー (実機の Android) では 4:3 に潰れるので、正方形に直して出す。
     * **大きさは測って渡す** — `iw*sar` と式で書くと、SAR が読めない素材で
     * 幅が 0 になって落ちる
     */
    test('横長の画素は正方形に直した大きさへ引き伸ばす', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', {
            displaySize: { width: 1920, height: 1080 },
        });
        expect(argValue(args, '-vf')).toBe('bwdif=mode=send_frame,scale=1920:1080,setsar=1,format=yuv420p');
    });

    test('渡されなければ引き伸ばさない', () => {
        // もともと正方形の素材。同じ大きさへの scale は仕事が増えるだけ
        expect(argValue(buildArgs('/in.m2ts', '/out.mkv', 1, null), '-vf')).toBe(
            'bwdif=mode=send_frame,format=yuv420p',
        );
    });

    test('PGS が無ければ字幕トラックは入らない', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null);
        expect(argValue(args, '-c:s:0')).toBeUndefined();
        expect(args.filter((a) => a.startsWith('-disposition:s'))).toHaveLength(0);
    });
});

describe('isVideoCodec', () => {
    test('知っているコーデックだけ通す', () => {
        expect(isVideoCodec('av1')).toBe(true);
        expect(isVideoCodec('h264')).toBe(true);
        expect(isVideoCodec('hevc')).toBe(false);
        expect(isVideoCodec(null)).toBe(false);
    });
});

describe('inputProgress', () => {
    /*
     * out_time_us はわざとほぼ最後を指す値にしてある。実機の TOKYO MX 録画で、
     * 入力を 65% しか読んでいないのに時刻だけ 99.1% に飛んで「あと1秒」のまま
     * 数分止まって見えた。割合は読み位置だけを信じ、時刻には釣られないこと
     */
    const block = {
        progress: 'continue',
        out_time_us: '1810000000',
        total_size: '1048576',
        bitrate: '2000.0',
        speed: '8.0x',
        drop_frames: '0',
    };

    test('読み位置から割合を出す。ffmpeg の言う時刻には釣られない', () => {
        const p = inputProgress(1000)(0, 500, block, 0);
        expect(p.percent).toBeCloseTo(0.5, 3);
    });

    test('読み位置が取れない間は直前の値を保つ', () => {
        expect(inputProgress(1000)(0, NaN, block, 0.42).percent).toBe(0.42);
    });

    test('入力の大きさが測れていなくても動じない', () => {
        expect(inputProgress(NaN)(0, 500, block, 0.1).percent).toBe(0.1);
    });

    test('割合は巻き戻らない', () => {
        const report = inputProgress(1000);
        report(0, 800, block, 0);
        expect(report(1000, 700, block, 0.8).percent).toBe(0.8);
    });

    test('progress=end で必ず100%にする', () => {
        expect(inputProgress(NaN)(0, NaN, { progress: 'end' }, 0.9).percent).toBe(1);
    });

    test('残り時間は直近の読み速度から出す。速さが読めないうちは null', () => {
        const report = inputProgress(10_000);
        expect(report(0, 1000, block, 0).etaMs).toBeNull(); // 窓がまだ短い
        // 5秒で1000バイト読めた → 残り8000バイトは40秒
        expect(report(5000, 2000, block, 0.1).etaMs).toBe(40_000);
    });

    test('読みが止まったら残り時間を出さない (「あと1秒」で張り付かせない)', () => {
        const report = inputProgress(10_000);
        report(0, 2000, block, 0);
        report(31_000, 2000, block, 0.2); // 窓から最初の1点が落ちる
        expect(report(36_000, 2000, block, 0.2).etaMs).toBeNull();
    });
});

describe('入力の読み位置を /proc から覗く', () => {
    test('自分が開いているファイルの fd と読み位置が見える', () => {
        const dir = mkdtempSync(join(tmpdir(), 'denpa-pos-'));
        const path = join(dir, 'input.ts');
        writeFileSync(path, 'abcdefgh');

        // /proc の fd は実体のパスで見えるので、実装と同じく解決してから探す
        const fd = openSync(realpathSync(path), 'r');
        try {
            expect(findInputFd(process.pid, realpathSync(path))).toBe(fd);
            expect(readInputPos(process.pid, fd)).toBe(0);
            readSync(fd, Buffer.alloc(3), 0, 3, null);
            expect(readInputPos(process.pid, fd)).toBe(3);
        } finally {
            closeSync(fd);
        }
        // 開いていない fd は読めない (ffmpeg は入力を読み終えると閉じる)
        expect(readInputPos(process.pid, 999_999)).toBeNaN();
        expect(findInputFd(process.pid, join(dir, 'closed.ts'))).toBeNull();
    });
});

describe('failureReason', () => {
    test('警告に埋もれずエラー行を拾う', () => {
        const stderr = [
            '[in#0/mpegts] Codec AVOption font has not been used for any stream.',
            'Stream mapping: Stream #0:3 -> #0:0 (mpeg2video -> av1)',
            '[libsvtav1 @ 0x1] Error initializing the encoder',
            'Conversion failed!',
        ].join('\n');
        const reason = failureReason(stderr);
        expect(reason).toContain('Error initializing the encoder');
        expect(reason).toContain('Conversion failed!');
        expect(reason).not.toContain('has not been used for any stream');
    });

    test('エラー行が無ければ末尾をそのまま出す', () => {
        expect(failureReason('a\nb\nc')).toBe('a\nb\nc');
    });
});

describe('CMを切ったTSを作る', () => {
    test('区間ごとに -c copy で切り出す', () => {
        const args = buildSegmentArgs('/in.m2ts', '/in.m2ts.part0.ts', { start: 12.5, end: 300 });
        // 再エンコードしないので速く、字幕もデータも落ちない
        expect(args).toContain('-c');
        expect(args).toContain('copy');
        expect(argValue(args, '-ss')).toBe('12.5');
        expect(argValue(args, '-to')).toBe('300');
        expect(argValue(args, '-f')).toBe('mpegts');
    });

    test('繋ぎ直しは concat デマクサで、時刻を振り直す', () => {
        const args = buildConcatArgs('/tmp/list.txt', '/out.ts');
        expect(argValue(args, '-f')).toBe('concat');
        expect(args).toContain('-safe');
        // 切れ目で時刻が飛ぶので振り直す
        expect(argValue(args, '-fflags')).toBe('+genpts');
    });

    test('一覧のパスは ' + "'" + ' をエスケープする', () => {
        expect(concatList(['/tmp/a.ts', "/tmp/b's.ts"])).toBe("file '/tmp/a.ts'\nfile '/tmp/b'\\''s.ts'");
    });
});

/*
 * **焼くほうと字幕を作るほうで、捨てる長さを同じにする。**
 *
 * 片方だけ「短いから捨てない」と判断すると、そのぶん字幕がずれる。
 * 判断そのものを1箇所に置いてある
 */
describe('頭から捨てる長さ', () => {
    test('そのまま返す', () => {
        expect(headSkip(0.93)).toBe(0.93);
    });

    test('ごく短いものと、測れなかったものは捨てない', () => {
        expect(headSkip(0.02)).toBe(0);
        expect(headSkip(0)).toBe(0);
        expect(headSkip(undefined)).toBe(0);
        expect(headSkip(Number.NaN)).toBe(0);
    });
});
