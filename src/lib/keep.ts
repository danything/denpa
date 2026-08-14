/**
 * localStorage の口。**読めない繋ぎでも落とさない。**
 *
 * プライベート窓や埋め込みでは、触っただけで投げることがある。覚えられなくても
 * 画面は動くものしか置かないので、転びは全部ここで握り潰す。
 * 3箇所が別々に try/catch を書いていたのを1本にした (measure は防御が無く、
 * プライベート窓で落ちえた)。
 */

export function read(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

export function write(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // 覚えられなくても支障は無い
    }
}

export function forget(key: string): void {
    try {
        localStorage.removeItem(key);
    } catch {
        // 消せなくても支障は無い
    }
}

/** 前方一致で消す。鍵にホスト名などが入っていて、全部は列挙できないものの掃除用 */
export function forgetPrefix(prefix: string): void {
    try {
        for (const key of Object.keys(localStorage)) {
            if (key.startsWith(prefix)) localStorage.removeItem(key);
        }
    } catch {
        // 消せなくても支障は無い
    }
}
