import type {
    ENCODE_PHASES,
    ENCODE_STATES,
    encodeJobs,
    programs,
    RECORDING_STATES,
    recordings,
    reservations,
    rules,
    services,
} from './server/schema';

export type ChannelType = 'GR' | 'BS' | 'CS' | 'SKY';

/**
 * 番組詳細に出す分。番組表・予約一覧・録画一覧のどこから開いても同じ形で見せる。
 * 予約や録画からは局名しか手元に無いので、局IDではなく名前で持つ。
 */
export interface ProgramDetail {
    name: string;
    service_name: string;
    start_at: number;
    end_at: number;
    description: string;
    extended: string | null;
    genre_detail: string | null;
    audios: string | null;
    video_type: string | null;
    video_resolution: string | null;
    is_free: number;
}

/**
 * CMの扱い。
 * off     : 何もしない
 * chapter : CM区間をチャプターとして書き込むだけ(ファイルは切らない)
 * cut     : CM区間を実際に落とす。検出を誤ると本編が消えるので明示指定のときだけ
 */
export type CmMode = 'off' | 'chapter' | 'cut';

/**
 * 録画をどう出すか。
 *
 * av1  : 既定。同じ画質でファイルが小さいが、エンコードに時間がかかる
 * h264 : エンコードが速く、非力なマシンや古いクライアント向け
 * none : **エンコードしない。** 生TSのまま保存先へ置く
 *
 * 別に「エンコードする」のチェックを持っていた頃は、外したときにコーデックの
 * 選択だけが残って、どちらが効いているのか画面から読めなかった。選ぶものは1つでいい
 */
export type VideoCodec = 'av1' | 'h264' | 'none';

/*
 * **行の型はテーブルの定義から導く** (`server/tables.ts`)。
 *
 * ここに interface として書き写していた頃は、列を足したときに片方だけ直しても
 * TS は何も言わなかった (`queryOne<Recording>` はキャストなので)。テーブルの定義は
 * 実際の DB と突き合わせるテストがあるので (`tables.test.ts`)、そこから導いた型は
 * DB と食い違わない。列ごとの説明もあちらにある
 */
export type Service = typeof services.$inferSelect;
export type Program = typeof programs.$inferSelect;
export type Rule = typeof rules.$inferSelect;

/**
 * 画面に出す予約の状態。
 *
 * DBの列に入っているのは `scheduled | conflict | canceled | missed` だけ
 * (`Reservation['state']`)。録り始めてからの `recording | done | failed` は
 * **録画の行から引いた結果**で、一覧を組み立てるときに足す
 * (routes/+page.server.ts の RESERVATION_STATE)。
 * 予約側にも書き写していた頃は、録画が失敗しても予約は録画中のまま残っていた
 */
export type ReservationState = Reservation['state'] | 'recording' | 'done' | 'failed';

export type Reservation = typeof reservations.$inferSelect;

/**
 * 録画の状態。**列ではなく生成列**で、他の列から毎回決まる (schema.RECORDING_STATE)。
 *
 * `encoding` はここに無い。動いているエンコードは encode_jobs にしか無く、
 * 一覧はそれを見て「エンコード中」を出す (format.encodeLabel)
 */
export type RecordingState = (typeof RECORDING_STATES)[number];

export type Recording = typeof recordings.$inferSelect;

export type EncodeState = (typeof ENCODE_STATES)[number];

/**
 * エンコードの段階。`encode` 以外は ffmpeg が回る前の下ごしらえで、
 * 進み具合が出せない代わりにこれを状態として出す。
 */
export type EncodePhase = (typeof ENCODE_PHASES)[number];

export type EncodeJob = typeof encodeJobs.$inferSelect;
