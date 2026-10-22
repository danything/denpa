// denpa-aio の入口。本体とチューナーエージェントを起こし、両方の面倒を見る。
//
// - 止めるとき (SIGTERM) は両方に渡し、両方が録画の終わりを待って畳むのを待つ
//   (stop_grace_period はそれに合わせて長くしておく。compose.prod.yml と同じ)
// - どちらかが落ちたら、もう片方も畳んでコンテナごと終わる。片方だけ生きていても
//   録れないので、起こし直しは restart に任せる
//
// **シェルで書かない。** 本体のイメージの土台は distroless でシェルが無いので、
// イメージに入っている bun で回す (.github/aio.Dockerfile)

import { constants } from 'node:os';

const io = { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' } as const;
const agent = Bun.spawn(['/usr/local/bin/denpa-agent'], io);
const denpa = Bun.spawn([process.execPath, '/app/server.js'], { ...io, cwd: '/app' });
const children = [agent, denpa];

let stopping = false;
const stop = () => {
    for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
};
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
        stopping = true;
        stop();
    });
}

const first = await Promise.race(children.map((child) => child.exited.then(() => child)));
stop();
await Promise.all(children.map((child) => child.exited));
// 止めるよう言われたなら 0。自分から落ちたなら、落ちたほうの終了コードを返す
// (シグナルで落ちたときは、シェルと同じく 128 + 番号)
const code = first.exitCode ?? 128 + (first.signalCode === null ? 0 : constants.signals[first.signalCode]);
process.exit(stopping ? 0 : code);
