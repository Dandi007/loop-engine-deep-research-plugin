/**
 * deep-research v2 协议类型定义
 * spec.md §2.2 (wf-dc0c15)
 */

/** 线索——唯一有状态机的东西。root entity，版本链。 */
export interface ClueV2 {
  text: string;
  status: "proposed" | "open" | "in_flight" | "explored" | "dropped" | "blocked";
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
  anchor: string;   // 带版本 URI: code://repo@commit:path#Lline
  quote: string;     // 逐字原文
  claim: string;     // 一句话结论
}

/** 长文本——转写件/报告/论辩稿。leaf，不可变。 */
export interface DocV2 {
  doc_kind: "transcript" | "report" | "argument";
  digest: string;    // 内容摘要，transcript 用此做全局去重键
  body: string;      // 正文，≤ 4MB
  origin: string;    // transcript=源 URI；report/argument=研究 id
}

/** Clue 状态机合法迁移 */
export const CLUE_TRANSITIONS: Record<ClueV2["status"], ClueV2["status"][]> = {
  proposed: ["open", "dropped"],
  open: ["in_flight", "blocked"],
  in_flight: ["explored", "open", "blocked"],
  explored: [],
  dropped: [],
  blocked: [],
};

/** 验证 clue 状态迁移合法性 */
export function isValidTransition(
  from: ClueV2["status"],
  to: ClueV2["status"],
): boolean {
  return CLUE_TRANSITIONS[from]?.includes(to) ?? false;
}