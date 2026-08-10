// @ts-nocheck
// 借りもの。中身は書き換えない ([README](../README.md))。denpa 側の型検査は効いたまま
import { decodeEUCJP, encodeEUCJP } from "./euc_jp";
import { decodeShiftJIS, encodeShiftJIS } from "./shift_jis";
import { Profile } from "./resource";

export type TextDecodeFunction = (input: Uint8Array) => string;
export type TextEncodeFunction = (input: string) => Uint8Array;

export function getTextDecoder(profile: Profile | undefined): TextDecodeFunction {
    if (profile === Profile.TrProfileC) {
        return decodeShiftJIS;
    } else {
        return decodeEUCJP;
    }
}

export function getTextEncoder(profile: Profile | undefined): TextEncodeFunction {
    if (profile === Profile.TrProfileC) {
        return encodeShiftJIS;
    } else {
        return encodeEUCJP;
    }
}
