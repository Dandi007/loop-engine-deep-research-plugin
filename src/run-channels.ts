/**
 * E0c1 §1.3 —— run 维度的 channel 命名 + `board:agent-runs` 单一真相源。
 *
 * 两条规则（spec §1.3）：
 *   1. 三条 research channel 名由 profile 基名 + 本次 `run_id` 派生
 *      （如 `research:e0-<run_id>.{index,evidence,docs}`）——每次运行用一块属于该 run
 *      的干净研究板，⛔ 不得用「清空/删除旧 channel」实现（bus 是 append-only 无 DELETE）。
 *   2. `board:agent-runs` 是全局的、不随 run 变，但**必须在预备清单里**
 *      （harvest/triage 都读它）；该名字在仓内**只留一处真相源**（⛔ 不要再写一份字面量）。
 */
import { createHash } from "node:crypto";

/**
 * E0c1 §1.3 —— `board:agent-runs` 的唯一字面量真相源。
 *
 * harvest / triage / runs 归集都读这条全局 channel；它不随 run 变。
 * ⛔ 仓内其他位置一律 `import { RUNS_CHANNEL_ID }` 引用，不得再写 `"board:agent-runs"` 字面量
 *    （spec §1.3 / 验收判据 6：该名字在仓内只有一处真相源）。
 */
export const RUNS_CHANNEL_ID = "board:agent-runs";

/**
 * E0c1 §1.3 —— 把任意 run_id 规范成 channel 名安全的形式（去掉 channel_id 不允许的字符）。
 *
 * bus channel_id 允许的字符集较宽，但为确定性 + 跨 run 不碰撞，这里把 run_id 取 sha256 前 16 hex
 * 作为派生段（不同 run_id 必得不同段；同一 run_id 必得同段——幂等创建的前提）。
 * 返回值只含 `[0-9a-f]`，是 channel_id 的合法子集。
 */
export function runSegment(runId: string): string {
  return createHash("sha256").update(runId).digest("hex").slice(0, 16);
}

/**
 * E0c1 §1.3 —— 由 profile 基名 + run_id 派生本次 run 的三条 research channel 名。
 *
 * 形如 `research:<profileBase>-<runSegment>.{index,evidence,docs}`
 * （spec 示例：`research:e0-<run_id>.{index,evidence,docs}`）。
 *
 * `profileBase` 是 profile 声明的研究基名（如 `e0`、`agent-harness`）；
 * `runId` 是本次运行的 run_id（每次运行不同 ⇒ channel 名不同 ⇒ 各用一块干净板）。
 *
 * ⛔ 不删除/清空旧 channel（bus append-only 无 DELETE）；每次运行建新 channel（不存在则建）。
 * ⛔ `board:agent-runs` 不在此列——它是全局的（见 `RUNS_CHANNEL_ID`）。
 *
 * 纯函数：不碰 IO，只做命名派生。供入口（bin/e0-regression.sh 经 tick-entry）与测试断言复用。
 */
export function perRunResearchChannels(
  profileBase: string,
  runId: string,
): { index: string; evidence: string; docs: string } {
  if (!profileBase) {
    throw new Error(
      "E0c1: perRunResearchChannels requires a non-empty profileBase (the profile's research base name). Refusing to derive channels from an empty base.",
    );
  }
  if (!runId) {
    throw new Error(
      "E0c1: perRunResearchChannels requires a non-empty runId. Each run must use its own clean board derived from its run_id.",
    );
  }
  const seg = runSegment(runId);
  const prefix = `research:${profileBase}-${seg}`;
  return {
    index: `${prefix}.index`,
    evidence: `${prefix}.evidence`,
    docs: `${prefix}.docs`,
  };
}
