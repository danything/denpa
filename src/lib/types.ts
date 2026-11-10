import type {
  ENCODE_KINDS,
  ENCODE_PHASES,
  encodeJobs,
  programs,
  recordings,
  reservations,
  rules,
  services,
} from "./server/schema";

export type ChannelType = "GR" | "BS" | "CS" | "SKY";

/**
 * 録画の番組のうち、元の TS に映像が無かった長さ (`recordings.video_loss`。秒)。測るのは CM 検出のとき (`server/video-loss.ts`)
 */
export interface VideoLoss {
  /** 映像があるはずだった長さ。番組の時刻のうち、録り始めてから録り終えるまで */
  span: number;
  /** そのうち映像が無かった長さ */
  lost: number;
  /** 映像が無いまま録画が終わった (途中で切れた) */
  tail: boolean;
}

/**
 * 番組表・ライブで並べる種別とその順 (地上波・BS・CS)。
 * SKY (スカパー！プレミアム) は復号できないので番組表とライブには出さない (`decodable`)。
 * 受信の設定では受けられる機材があるときだけ並べ (`shownTypes`)、ルールの条件では SKY の局があれば選べる (`RuleDraft`)
 */
export const CHANNEL_TYPES: readonly ChannelType[] = ["GR", "BS", "CS"];

/** 種別の全部とその順。SKY は最後 */
export const ALL_CHANNEL_TYPES: readonly ChannelType[] = [
  ...CHANNEL_TYPES,
  "SKY",
];

/**
 * 受信の設定で並べる種別。**SKY は、受けられる機材か SKY を選んだチューナーがあるときだけ足す** (`sky`)。
 * 受けられる機材が無ければ、地上波・BS・CS のまま
 */
export function shownTypes(sky: boolean): readonly ChannelType[] {
  return sky ? ALL_CHANNEL_TYPES : CHANNEL_TYPES;
}

/**
 * スクランブルを復号できる種別か。**SKY (スカパー！プレミアム) は復号できない。** B-CAS ではない専用のカードが要り、
 * そのカードにまだ対応していない (エージェントもスクランブルされたまま流す。#1578)。
 * 復号できない局は受信の設定の「受信できるチャンネル」にだけ出し、番組表・ライブ・ロゴは取得しない
 */
export function decodable(type: string): boolean {
  return type !== "SKY";
}

/** 復号できない局 (`decodable`) をライブで開こうとしたときの理由 */
export const UNDECODABLE =
  "スカパー！プレミアムの局は、スクランブルを復号できないため観られません。スカパー！プレミアムのカードには、これから対応する予定です";

/**
 * 番組表の 1 マスぶん。**番組の全列は持たない。**
 *
 * 出演者やあらすじ (`extended`)、音声 (`audios`)、ジャンルの中分類
 * (`genre_detail`) は詳細を開いたときにしか使わないのに、BS の 24 時間ぶん
 * (2,171 件) で応答 1.43 MB のうち 41% を占めていた。しかも前日・翌日の先読みが
 * 同じ形式の応答をもう 2 つ取る。詳細は開いた 1 件だけ `/api/programs/<id>` で取る
 * (予約・録画の一覧と同じ経路)
 */
export interface GridProgram extends Pick<
  Program,
  | "id"
  | "service_id"
  | "start_at"
  | "end_at"
  | "name"
  | "description"
  | "genres"
  | "copy_never"
> {
  reservation_state: ReservationState | null;
  /** 録らない理由 (`reservations.conflict_reason`)。競合・コピー禁止など。予約が無ければ null */
  conflict_reason: string | null;
  /** 予約を立てたルール。手で入れた予約と、予約の無い番組は null */
  rule_id: number | null;
  /**
   * その番組で録れたもの。番組表から詳細を開いたときに、そのまま再生できるようにする。
   * 録画一覧まで戻って同じ番組を探し直させないため
   */
  recording_id: number | null;
  /** 録画そのものが失敗していれば再生のボタンを出さない (一覧の `hasFile` と同じ) */
  recording_state: Recording["state"] | null;
  /** 配信は library_path ?? ts_path を返すので、どちらかがあれば開ける */
  library_path: string | null;
  ts_path: string | null;
}

/** 番組表の中身 (`/api/guide`)。組めなかったときは `programs` を空にして、理由を `failed` に入れる */
export interface GuideSheet {
  programs: GridProgram[];
  failed: string | null;
}

/**
 * 番組の詳細に添える注記。失敗・削除の理由はサーバが返したままの字を等幅で出し、見出しは赤。
 * `warning` は録れてはいるが欠けがある録画 (映像が途中で欠けた) で、一覧の行と同じ注意の色の見出しに、文をそのまま続ける
 */
export interface DetailNote {
  title: string;
  text: string;
  tone?: "warning";
}

/**
 * 番組詳細に出す分。番組表・ホーム (録画)・検索のどこから開いても同じ見た目で見せる。
 * 予約や録画からは局名しか手元に無いので、局 ID ではなく名前で持つ。
 */
export interface ProgramDetail {
  name: string;
  service_name: string;
  start_at: number;
  end_at: number;
  description: string;
  extended: Program["extended"];
  genre_detail: Program["genre_detail"];
  audios: Program["audios"];
  video_type: string | null;
  video_resolution: string | null;
  is_free: boolean;
  /** コピー禁止の番組か。禁止の番組は録らない (`format.COPY_NEVER_REASON`) */
  copy_never: boolean;
  /** シリーズの話数・全何話・再放送の印 (`programs` の同じ名前の列)。載せない局は NULL */
  series_episode: number | null;
  series_last_episode: number | null;
  series_repeat: number | null;
}

/**
 * 録画をどう出すか。
 *
 * av1  : 既定。同じ画質でファイルが小さいが、エンコードに時間がかかる
 * hevc : H.265。**GPU でだけエンコードする** (`#lib/hw.ts` の `SOFTWARE_CODECS`)。AV1 をデコードできない端末向けに H.264 より小さく
 * h264 : エンコードが速く、非力なマシンや古いクライアント向け
 * none : **エンコードしない。** 元の TS のまま保存先へ置く
 *
 * いくつもエンコードするときもこの型は主のほうだけ (一覧は `Settings.codecs`)。
 * 別に「エンコードする」のチェックを持っていた頃は、外したときにコーデックの
 * 選択だけが残って、どちらが効いているのか画面から読めなかった。それで `none` もここに入れる
 */
export type VideoCodec = "av1" | "hevc" | "h264" | "none";

/*
 * **行の型はテーブルの定義から導く** (`server/schema.ts`)。
 *
 * ここに interface として書き写していた頃は、列を足したときに片方だけ直しても
 * TS は何も言わなかった。テーブルの定義はマイグレーションで作った DB と突き合わせるテストがあるので (`server/schema.test.ts`)、
 * そこから導いた型は DB と食い違わない。列ごとの説明もあちらにある
 */
export type Service = typeof services.$inferSelect;
export type Program = typeof programs.$inferSelect;
export type Rule = typeof rules.$inferSelect;

/**
 * 画面に出す予約の状態。
 *
 * DB の列に入っているのは `scheduled | conflict | skipped | canceled | missed` だけ
 * (`Reservation['state']`)。録り始めてからの `recording | done | failed` は
 * **録画の行から引いた結果**で、一覧を組み立てるときに足す
 * (routes/+page.server.ts で録画の行から引く)。
 * 予約側にも書き写していた頃は、録画が失敗しても予約は録画中のまま残っていた
 */
export type ReservationState =
  Reservation["state"] | "recording" | "done" | "failed";

export type Reservation = typeof reservations.$inferSelect;

export type Recording = typeof recordings.$inferSelect;

/**
 * エンコードの段階。`encode` 以外は ffmpeg が回る前の下ごしらえで、
 * 進み具合が出せない代わりにこれを状態として出す。
 */
export type EncodePhase = (typeof ENCODE_PHASES)[number];
export type EncodeKind = (typeof ENCODE_KINDS)[number];

export type EncodeJob = typeof encodeJobs.$inferSelect;
