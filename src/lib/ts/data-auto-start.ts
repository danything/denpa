/**
 * **入口の部品に自動起動の指定があるか。** データ符号化方式記述子の `auto_start_flag`
 * (TR-B14 第二分冊 2.1.4・TR-B15 第一分冊 5.1.5)。テレビは指定のある入口を選局したら裏で動かし、無い入口は d を押されてから始める。
 *
 * 使うのは 3 か所で、決まりはこの 1 つ。エンジンが開く前に入口を始めるか (`bml/engine.ts` の `mayStart`)、
 * ライブのサーバが画面に知らせる値 (`server/databroadcast.ts` の `AutoStartWatch`)、
 * 録画の変化ログから決める値 (`server/recorded-bml.ts` の `recordedAutoStart`)
 */

import type { ComponentPMT } from "@danything/arib/bml-protocol";

/** 入口の部品の部品タグ (地上波 A プロファイル・BS/CS とも 0x40。`bml/resources.ts` の `STARTUP_COMPONENT`) */
const ENTRY_COMPONENT = 0x40;

/** PMT の部品の並び (`ComponentPMT`) から、入口の部品に自動起動の指定があるかを返す。入口の部品が無ければ false */
export function autoStarts(components: Iterable<ComponentPMT>): boolean {
  for (const component of components)
    if (component.componentId === ENTRY_COMPONENT)
      return component.bxmlInfo?.entryPointInfo?.autoStartFlag === true;
  return false;
}
