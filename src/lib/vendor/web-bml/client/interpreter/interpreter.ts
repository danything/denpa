// @ts-nocheck
// 借りもの。中身は書き換えない ([README](../README.md))。denpa 側の型検査は効いたまま
import { EPG } from "../bml_browser";
import { BrowserAPI } from "../browser";
import { Content } from "../content";
import { Resources } from "../resource";

export interface Interpreter {
    reset(): void;
    // trueが返った場合launchDocumentなどで実行が終了した
    addScript(script: string, src?: string): Promise<boolean>;
    // trueが返った場合launchDocumentなどで実行が終了した
    runEventHandler(funcName: string): Promise<boolean>;
    destroyStack(): void;
    resetStack(): void;
    get isExecuting(): boolean;
    setupEnvironment(browserAPI: BrowserAPI, resources: Resources, content: Content, epg: EPG): void;
}