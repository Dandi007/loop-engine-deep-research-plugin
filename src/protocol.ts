/**
 * deep-research v2 协议类型定义 —— 全部派生自单一真相源。
 *
 * 单一真相源（C4）：agent-bus 协议注册表（按 `contract_digest`）的权威 schema，
 * 以提交快照 `src/protocol-registry.json` 落地、由 `src/protocol-contract.ts` 做
 * 完整性校验，并由 `scripts/generate-protocol.ts` 机械导出
 * `src/protocol.generated.ts`（checked-generated 产物）。
 *
 * 本文件不再手抄任何字段名 / kind / 状态值 / 迁移 allowlist —— 它们一律来自
 * `./protocol.generated`，且用编译期断言钉死：接口键集合必须与注册表导出的
 * 字段集合完全一致（漂移 ⇒ `npm run typecheck` 变红）。
 */
import {
  CLUE_STATUSES,
  DOC_KINDS,
  CLUE_FIELDS,
  EVIDENCE_FIELDS,
  DOC_FIELDS,
  CLUE_TRANSITIONS as CLUE_TRANSITIONS_GENERATED,
} from "./protocol.generated";

export { CLUE_STATUSES, DOC_KINDS };

export type ClueStatus = (typeof CLUE_STATUSES)[number];
export type DocKind = (typeof DOC_KINDS)[number];

/** 线索——唯一有状态机的东西。root entity，版本链。 */
export interface ClueV2 {
  text: string;
  status: ClueStatus;
  depth: number;
  sources: string[];
  parent?: string | null;
  assignee?: string | null;
  run_id?: string | null;
  rationale?: string | null;
}

/** 证据——锚定原文+一句话结论的原子单位。leaf，不可变。 */
export interface EvidenceV2 {
  clue_id: string;
  anchor: string; // 带版本 URI: code://repo@commit:path#Lline
  quote: string; // 逐字原文
  claim: string; // 一句话结论
}

/** 长文本——转写件/报告/论辩稿。leaf，不可变。 */
export interface DocV2 {
  doc_kind: DocKind;
  digest: string; // 内容摘要，transcript 用此做全局去重键
  body: string; // 正文，≤ 4MB
  origin: string; // transcript=源 URI；report/argument=研究 id
}

// ── 编译期钉死：接口键集合 ⊆= 注册表导出的字段集合 ──
// 任一字段名漂移（接口手改 / 快照手改 / 生成物手改）都会在这里触发 tsc 错误。

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

type Assert<T extends true> = T;

type ClueField = (typeof CLUE_FIELDS)[number];
type EvidenceField = (typeof EVIDENCE_FIELDS)[number];
type DocField = (typeof DOC_FIELDS)[number];

// 编译期断言：接口键集合必须与注册表导出的字段集合完全一致。
// 任一字段名漂移 ⇒ 下面三行触发 `tsc --noEmit` 报错（false 不满足 true）。
type _AssertClueKeys = Assert<Equal<keyof ClueV2, ClueField>>;
type _AssertEvidenceKeys = Assert<Equal<keyof EvidenceV2, EvidenceField>>;
type _AssertDocKeys = Assert<Equal<keyof DocV2, DocField>>;

/** Clue 状态机合法迁移（值来自注册表导出的 status 枚举，图来自单一状态机源）。 */
export const CLUE_TRANSITIONS: Record<ClueStatus, readonly ClueStatus[]> =
  CLUE_TRANSITIONS_GENERATED;

/** 验证 clue 状态迁移合法性。 */
export function isValidTransition(
  from: ClueStatus,
  to: ClueStatus,
): boolean {
  return (CLUE_TRANSITIONS[from] as readonly ClueStatus[]).includes(to);
}