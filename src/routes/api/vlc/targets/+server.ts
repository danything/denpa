import { json } from '@sveltejs/kit';
import { targets } from '$lib/server/vlc';

/** 設定してあるテレビのVLCの一覧。「テレビで再生」を出すかどうかを画面がこれで決める */
export function GET() {
    return json({ targets: targets() });
}
