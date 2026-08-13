/**
 * E0c10 D4（GT-D）—— 「run 已 exited 无 result」的诊断类型与错误。
 *
 * 独立成模块（不放在 tick-run.ts）以避免 generate.ts ↔ tick-run.ts 的循环 import：
 * generate.ts 需识别本错误并在 onRunExitedWithoutResult 回调里记录诊断、跳过该角色 doc 发布；
 * tick-run.ts 的轮询路径（pollForResultOrExit）抛出本错误。
 *
 * 真机（GT-D 逐字）：`E0c5 §1.2: run … (generate) exited without producing a dr-doc.result.v1
 * after 3159ms — refusing to wait the full timeout` ⇒ 当时的实现让**整个 tick 非零退出**，
 * 一个失败的 generate worker 就毙掉整条基线（背靠背两跑：exit 0 / exit 5）。
 *
 * 修复（D4）：轮询路径观察到 `agent.run.exited` 但 result 仍未到达 ⇒ 抛本错误（带 run_id/role/已等时长）；
 * 上层（runWrite 的 triage 分支、runGenerate 的 spawnRole 包裹）**捕获本错误**：记录诊断、把该 doc/clue
 * 标成失败、继续本轮 tick（tick 仍以 0 退出）。
 *   ⛔ tick 不得非零退出（GT-D）；
 *   ⛔ 该 doc/clue 不得静默当成功（empty decisions / 空 body 折叠成正常路径）；
 *   ⛔ bus 不可达（run 未 exited、纯超时）仍走旧 timeout 错误 ⇒ tick 非零退出（判据 4 反向）。
 */

/**
 * run 已 exited 但在等待预算内未产出 result。由轮询路径（triage readResult / generate readBody）
 * 在观察到 `agent.run.exited` 事件但 result 仍未到达时抛出。
 */
export class RunExitedWithoutResultError extends Error {
  /** run_id（诊断必含，GT-D）。 */
  readonly runId: string;
  /** 角色（dr-triage / dr-debater-* / dr-synthesizer）。诊断必含。 */
  readonly role: string;
  /** 已等待时长（ms），从开始轮询到观察到 exit。诊断必含（GT-D）。 */
  readonly elapsedMs: number;
  constructor(runId: string, role: string, elapsedMs: number) {
    super(
      `E0c10 D4: run "${runId}" (role "${role}") exited without producing a result after ${elapsedMs}ms — recording diagnostic and continuing this tick (tick must not non-zero exit; the doc/clue is marked failed, not silently succeeded).`,
    );
    this.name = "RunExitedWithoutResultError";
    this.runId = runId;
    this.role = role;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * E0c10 D4（GT-D）—— 一次「run exited 无 result」的诊断记录（进入 tick 输出的 diagnostics）。
 * 字段逐字对齐 GT-D：run_id / role / 已等时长。
 */
export interface RunExitWithoutResultDiagnostic {
  runId: string;
  role: string;
  elapsedMs: number;
  /**
   * 哪条装配路径观察到的：triage（dr-triage 派发）或 generate（dr-debater / dr-synthesizer）。
   * 诊断与判别性测试据此区分两条路径都覆盖（判据 4）。
   */
  phase: "triage" | "generate";
}

/** 类型守卫：判定一个未知值是否为 RunExitedWithoutResultError（避免循环 import 时的 instanceof）。 */
export function isRunExitedWithoutResultError(e: unknown): e is RunExitedWithoutResultError {
  return e instanceof RunExitedWithoutResultError;
}
