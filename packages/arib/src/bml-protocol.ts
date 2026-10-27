/**
 * データ放送の通知の形式。**デコードする側 ([bml.ts](bml.ts)) と描く側の取り決め。**
 *
 * もとは web-bml の `server/ws_api.ts` の型を借りていた。形式はそのまま写してある —
 * 録画の隣に置いた `.bml.jsonl` はこの形式の JSON を1行ずつ持っているので、
 * **形式を変えると前に録ったものが読めなくなる**。足すのはよいが、名前や意味は変えない。
 * web-bml は MIT で、著作権表示と許諾の文は [LICENSE](../LICENSE) に置いてある。
 *
 * 載せるのは denpa が実際に作るものだけ (PMT・モジュール一覧・揃ったモジュール・
 * ストリーム記述子のイベント・番組の名乗り・放送の時刻)。web-bml が自前の
 * TS 解析のために持っていた PCR・PES・BIT・映像の URL は作らないので持たない。
 */

/** PMT の ES 1本。**部品タグ (`componentId`) を持つものだけ**並ぶ (bml.ts の `parsePmt`) */
export interface ComponentPMT {
  pid: number;
  componentId: number;
  bxmlInfo?: AdditionalAribBXMLInfo;
  streamType: number;
  dataComponentId?: number;
}

/** データ符号化方式記述子の後半 (bml.ts の `parseBxmlInfo`) */
export interface AdditionalAribBXMLInfo {
  transmissionFormat: number;
  entryPointFlag: boolean;
  entryPointInfo?: AdditionalAribBXMLEntryPointInfo;
  additionalAribCarouselInfo?: AdditionalAribCarouselInfo;
}

export interface AdditionalAribBXMLEntryPointInfo {
  autoStartFlag: boolean;
  documentResolution: number;
  useXML: boolean;
  defaultVersionFlag: boolean;
  independentFlag: boolean;
  styleForTVFlag: boolean;
  bmlMajorVersion: number;
  bmlMinorVersion: number;
  bxmlMajorVersion?: number;
  bxmlMinorVersion?: number;
}

export interface AdditionalAribCarouselInfo {
  dataEventId: number;
  eventSectionFlag: boolean;
  ondemandRetrievalFlag: boolean;
  fileStorableFlag: boolean;
  startPriority: number;
}

/**
 * `Content-Type` を読んだもの。名前は小文字にそろえ、元の綴りも持つ
 * ([multipart.ts](multipart.ts) の `parseMediaType`)
 */
export interface MediaType {
  type: string;
  originalType: string;
  subtype: string;
  originalSubtype: string;
  parameters: MediaTypeParameter[];
}

export interface MediaTypeParameter {
  attribute: string;
  originalAttribute: string;
  value: string;
}

/** モジュールの中のファイル1つ。中身は base64 (JSON で運ぶため) */
export interface ModuleFile {
  contentLocation: string | null;
  contentType: MediaType;
  dataBase64: string;
}

export interface PMTMessage {
  type: "pmt";
  components: ComponentPMT[];
}

export interface ModuleDownloadedMessage {
  type: "moduleDownloaded";
  componentId: number;
  moduleId: number;
  files: ModuleFile[];
  version: number;
  dataEventId: number;
}

export interface ModuleListEntry {
  id: number;
  version: number;
  size: number;
}

export interface ModuleListUpdatedMessage {
  type: "moduleListUpdated";
  componentId: number;
  modules: ModuleListEntry[];
  dataEventId: number;
  returnToEntryFlag?: boolean;
}

export type ESEvent = ESImmediateEvent | ESNPTEvent | NPTReference;

export interface ESImmediateEvent {
  type: "immediateEvent";
  eventMessageGroupId: number;
  timeMode: 0;
  eventMessageType: number;
  eventMessageId: number;
  privateDataByte: number[];
}

export interface ESNPTEvent {
  type: "nptEvent";
  eventMessageGroupId: number;
  timeMode: 2;
  eventMessageNPT: number;
  eventMessageType: number;
  eventMessageId: number;
  privateDataByte: number[];
}

export interface NPTReference {
  type: "nptReference";
  postDiscontinuityIndicator: boolean;
  dsmContentId: number;
  STCReference: number;
  NPTReference: number;
  scaleNumerator: number;
  scaleDenominator: number;
}

export interface ESEventUpdatedMessage {
  type: "esEventUpdated";
  componentId: number;
  events: ESEvent[];
  dataEventId: number;
}

/** 番組の名乗り。TS からではなく DB から組む (denpa の `server/live.ts`・`server/recorded-bml.ts`) */
export interface ProgramInfoMessage {
  type: "programInfo";
  originalNetworkId: number | null;
  transportStreamId: number | null;
  serviceId: number | null;
  eventId: number | null;
  eventName: string | null;
  startTimeUnixMillis: number | null;
  durationSeconds: number | null;
  indefiniteDuration: boolean | null;
  networkId: number | null;
}

/** 放送の時刻 (TDT/TOT) */
export interface CurrentTime {
  type: "currentTime";
  timeUnixMillis: number;
}

export type ResponseMessage =
  | PMTMessage
  | ModuleDownloadedMessage
  | ModuleListUpdatedMessage
  | ESEventUpdatedMessage
  | ProgramInfoMessage
  | CurrentTime;
