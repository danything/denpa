/**
 * localStorage の読み書き。**読めない繋ぎでも落とさない。**
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

/** 頭が `prefix` のものを全部 (鍵は頭を外したもの)。読めなければ空 */
export function readAll(prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null || !key.startsWith(prefix)) continue;
      const value = localStorage.getItem(key);
      if (value !== null) out[key.slice(prefix.length)] = value;
    }
  } catch {
    // 読めなければ何も無いことにする
  }
  return out;
}
