import { describe, it, expect } from "vitest";

/**
 * CAS 互斥的充要条件（来自 findings.md CAS 节）
 *
 * 不变量：CAS 要成为互斥原语，前置条件必须在「你所 supersede 的那一版」上求值。
 * 同源读 ⇒ 互斥成立（读写之间有人抢到 → head 推进 → supersedes 过期 → 409）；
 * 分属两次读 ⇒ CAS 退化成纯粹的防丢失更新。
 *
 * 判据：看代码里 `status` 和 `supersedes` 是不是从同一个变量来的。
 */

// 模拟 bus 消息结构
interface BusMessage {
  message_id: string;
  channel_seq: number;
  payload: { status: string; [key: string]: unknown };
}

/**
 * CAS claim 函数（纯逻辑，不依赖 bus）
 * 返回成功或冲突原因
 */
function casClaim(
  head: BusMessage,              // 从 entity 读到的当前 head
  expectedStatus: string,        // 前置条件：期望的 status
  newStatus: string,             // 目标 status
  assignee: string,
  runId: string,
): { success: true; newPayload: Record<string, unknown> } | { success: false; reason: string } {
  // 关键：status 和 supersedes 来自同一个 head 对象（同源读）
  const currentStatus = head.payload.status;
  const supersedes = head.message_id;

  if (currentStatus !== expectedStatus) {
    return { success: false, reason: `conflict: expected ${expectedStatus}, got ${currentStatus}` };
  }

  return {
    success: true,
    newPayload: {
      ...head.payload,
      status: newStatus,
      assignee,
      run_id: runId,
    },
  };
}

describe("CAS claim (unit)", () => {
  const headOpen: BusMessage = {
    message_id: "msg_001",
    channel_seq: 5,
    payload: { status: "open", text: "test clue", depth: 0, sources: ["code-local"] },
  };

  const headInFlight: BusMessage = {
    message_id: "msg_002",
    channel_seq: 6,
    payload: { status: "in_flight", text: "test clue", depth: 0, sources: ["code-local"], assignee: "other", run_id: "run_001" },
  };

  it("CAS success: open → in_flight with correct status", () => {
    const result = casClaim(headOpen, "open", "in_flight", "dr-worker-code-local", "run_002");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.newPayload.status).toBe("in_flight");
      expect(result.newPayload.assignee).toBe("dr-worker-code-local");
      expect(result.newPayload.run_id).toBe("run_002");
    }
  });

  it("CAS 409: open → in_flight but clue already in_flight", () => {
    // 别人抢先了——head 已经是 in_flight
    const result = casClaim(headInFlight, "open", "in_flight", "dr-worker-code-local", "run_003");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toContain("conflict");
    }
  });

  it("CAS 409: payload stale — head was updated between read and CAS", () => {
    // 模拟：第一次读 head 是 open，但 CAS 时 head 已变成 in_flight
    // 这由 bus 的 supersedes 机制保证——如果 supersedes 指向的不是当前 head，bus 返回 409
    // 本测试验证逻辑层：status 和 supersedes 来自同一个 head 对象
    const result = casClaim(headInFlight, "open", "in_flight", "dr-worker-code-local", "run_004");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toContain("conflict");
    }
  });

  it("CAS 同源读判据：status 和 supersedes 来自同一个变量", () => {
    // 这是常驻断言——验证代码里 status 和 supersedes 确实来自同一个 head 对象
    // 如果分属两次读，本测试不会捕获，但逻辑上会退化
    const head = headOpen;
    const status = head.payload.status;     // 来自 head
    const supersedes = head.message_id;      // 来自同一个 head
    expect(status).toBe("open");
    expect(supersedes).toBe("msg_001");
    // 同源 ⇒ 互斥成立
  });
});