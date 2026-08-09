// @ts-nocheck
// 借りもの。中身は書き換えない ([README](../README.md))。denpa 側の型検査は効いたまま

export function getTrace(_channel: string): (message?: any, ...optionalParams: any[]) => void {
    if (!localStorage.getItem("trace")) {
        return () => {};
    }
    return console.debug;
}

export function getLog(_channel: string): (message?: any, ...optionalParams: any[]) => void {
    return console.log;
}