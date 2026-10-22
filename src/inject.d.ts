/**
 * `?inject` で読むもの (`vite.config.ts` の `inject`)。import ごと 1 本に束ねた script の文字
 */
declare module '*?inject' {
    const code: string;
    export default code;
}
