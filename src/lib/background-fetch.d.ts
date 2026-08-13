/**
 * Background Fetch API の型。TS の lib.dom にまだ入っていないので自前で持つ
 * (Chrome/Edge のみ。https://wicg.github.io/background-fetch/)。
 * 使うところだけ書いてある — 仕様の写経はしない。
 */

interface BackgroundFetchRecord {
    readonly request: Request;
    readonly responseReady: Promise<Response>;
}

interface BackgroundFetchRegistration extends EventTarget {
    readonly id: string;
    readonly downloaded: number;
    readonly downloadTotal: number;
    readonly result: '' | 'success' | 'failure';
    matchAll(): Promise<BackgroundFetchRecord[]>;
    abort(): Promise<boolean>;
}

interface BackgroundFetchManager {
    fetch(
        id: string,
        requests: (Request | string)[],
        options?: {
            title?: string;
            icons?: { src: string; sizes?: string; type?: string }[];
            downloadTotal?: number;
        },
    ): Promise<BackgroundFetchRegistration>;
    get(id: string): Promise<BackgroundFetchRegistration | undefined>;
    getIds(): Promise<string[]>;
}

interface ServiceWorkerRegistration {
    readonly backgroundFetch?: BackgroundFetchManager;
}

/** サービスワーカー側のイベント。`event.registration` に成否と中身が入っている */
interface BackgroundFetchEvent extends ExtendableEvent {
    readonly registration: BackgroundFetchRegistration;
    updateUI?(options: { title?: string }): Promise<void>;
}

interface ServiceWorkerGlobalScopeEventMap {
    backgroundfetchsuccess: BackgroundFetchEvent;
    backgroundfetchfail: BackgroundFetchEvent;
    backgroundfetchabort: BackgroundFetchEvent;
    backgroundfetchclick: BackgroundFetchEvent;
}
