/**
 * E0 —— head_seq / sum 取值的判别性单测（§1.1 / §1.2 / 判据 2）。
 *
 * ⛔ 真机实测：真实 agent-bus 的单 channel GET 不返回 head_seq；head_seq 只在列表端点
 *    GET /v1/channels。本模块一律解析列表端点。凡是从 JSON 取值都真解析（JSON.parse），
 *    ⛔ 不用贪婪正则从 JSON 抽多值。
 *
 * 判别性：
 *  - T-SUM-ALL：多 channel 的列表里，sum(head_seq) 必须**对所有 channel**求和。
 *    若把求和换回 E0a 的「贪婪 sed 只抓行内最后一个 head_seq」，该测试必须变红
 *    （两 channel 10/20 → 9999/8888 时贪婪实现前后恒等、测不出增长）。
 *  - T-SUM-EMPTY：空 / 无 head_seq 字段的项不破坏全量和。
 *  - T-NAME：按 channel_id 在列表里取某 channel 的 head_seq；找不到 ⇒ found:false。
 */
import { describe, it, expect } from "vitest";
import { parseChannelList, headSeqFor, sumHeadSeqs } from "../scripts/e0-metrics.mjs";

describe("T-SUM-ALL: sum(head_seq) is a true full sum over all channels", () => {
  it("sums every channel's head_seq (greedy single-value regex would see 5==5 here)", () => {
    const json = JSON.stringify([
      { channel_id: "a", head_seq: 9999 },
      { channel_id: "b", head_seq: 8888 },
    ]);
    const channels = parseChannelList(json);
    // 若被换成 E0a 贪婪实现：只抓到"行内最后一个"，恒得 5 → 断言 18887 必红。
    expect(sumHeadSeqs(channels)).toBe(18887);
  });

  it("returns the true full sum even when the response is a single-line JSON array", () => {
    const json =
      '[{"channel_id":"x","head_seq":10},{"channel_id":"y","head_seq":20},{"channel_id":"z","head_seq":30}]';
    expect(sumHeadSeqs(parseChannelList(json))).toBe(60);
  });
});

describe("T-SUM-EMPTY: missing head_seq field does not corrupt the full sum", () => {
  it("skips channels without a numeric head_seq", () => {
    const json = JSON.stringify([
      { channel_id: "a", head_seq: 7 },
      { channel_id: "b", delivery_mode: "fanout" },
      { channel_id: "c", head_seq: 3 },
    ]);
    expect(sumHeadSeqs(parseChannelList(json))).toBe(10);
  });

  it("empty list sums to 0", () => {
    expect(sumHeadSeqs(parseChannelList("[]"))).toBe(0);
  });
});

describe("T-NAME: head_seq is looked up by channel_id in the list endpoint", () => {
  it("finds the channel and returns its head_seq", () => {
    const json = JSON.stringify([
      { channel_id: "research:e0-regression.index", head_seq: 12 },
      { channel_id: "other", head_seq: 3 },
    ]);
    const r = headSeqFor(parseChannelList(json), "research:e0-regression.index");
    expect(r.found).toBe(true);
    expect(r.headSeq).toBe(12);
  });

  it("reports found:false and the actual field set when the channel is missing", () => {
    const json = JSON.stringify([{ channel_id: "only", head_seq: 1 }]);
    const r = headSeqFor(parseChannelList(json), "research:missing.index");
    expect(r.found).toBe(false);
    expect(r.headSeq).toBe(null);
    expect(r.fieldSet).toContain("only");
  });

  it("reports headSeq:null when the channel exists but has no head_seq field", () => {
    const json = JSON.stringify([
      { channel_id: "nohead", delivery_mode: "fanout" },
    ]);
    const r = headSeqFor(parseChannelList(json), "nohead");
    expect(r.found).toBe(true);
    expect(r.headSeq).toBe(null);
  });
});
