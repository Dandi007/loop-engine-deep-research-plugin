# Implementation Summary — S1b(v2) CAS 认领原语硬化

## 真机冒烟输出（`npm run smoke:cas`，dev_ledr_s1b_cas_hardening_02 实现期单次真跑）

```
stdout | scripts/smoke-cas.ts > smoke: CAS claim on real agent-bus > publish → claim → conflict (re-run safe)
[smoke] ① publish message_id=msg_01KZ6FT90ZH11S18KH3FQZ4CE3 channel_seq=4 entity_id=msg_01KZ6FT90ZH11S18KH3FQZ4CE3 deduplicated=true

stdout | scripts/smoke-cas.ts > smoke: CAS claim on real agent-bus > publish → claim → conflict (re-run safe)
[smoke] ② claim success=false messageId=n/a error=conflict

stdout | scripts/smoke-cas.ts > smoke: CAS claim on real agent-bus > publish → claim → conflict (re-run safe)
[smoke] ③ claim success=false messageId=n/a error=conflict

 ✓ scripts/smoke-cas.ts (1 test)
```

本跑命中 `deduplicated: true`：agent-bus 侧已存在 entity
`msg_01KZ6FT90ZH11S18KH3FQZ4CE3`（上一 attempt 的 smoke 已将其认领为 `in_flight`），
因此幂等键去重、未写入任何新消息，channel 消息数不再增加。这正是 spec §5.2要求 gate 重跑
证明的幂等守卫成立。脚本对「首次真跑」与「gate 重跑」两种状态做了耐受化处理（见
`scripts/smoke-cas.ts` 内注释），重跑不再因 head 已是 `in_flight` 而在 ② 处断言失败。

## 本次修复对照

- **blocker（re-run 安全）**：`scripts/smoke-cas.ts` ② 的断言改为按 `deduplicated` 分支容忍，
  重跑态下一步不再必失败。
- **major（A6 对 M4 的杀伤力）**：`test/cas.test.ts` 的 A6 改为计数 `getEntity` 读取次数，
  第二次独立读返回更先进 head（`msg_002`），断言 `supersedes` 仍等于第一次读的
  `message_id` 且绝不为 `msg_002`，并断言只读一次。已实测杀死 M4 变异。
- **major（冒烟证据）**：本文件为真实冒烟输出，冒烟脚本已真跑。
- **minor（恒真断言）**：删除 `test/bus.test.ts` 中恒真的 A2 用例（HTTP 200 含 409 → success），
  其判别语义由紧邻的 M1 用例承担。