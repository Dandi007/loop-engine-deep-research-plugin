# 002 — 单一真相源协议契约（no hand-copied allowlist）

**Status:** Active
**Scope:** deep-research 消费侧协议 schema 的单一真相源

## 目标

`research.clue.v2` / `research.evidence.v2` / `research.doc.v2` 三份消费侧
schema（字段形状、`status`/`doc_kind` 值枚举、clue 状态机）不再由
`src/protocol.ts` 手抄，而是从 agent-bus 协议注册表（按 `contract_digest`）
机械推导 / 机械校验。

## 单一真相源

- **注册表快照** `src/protocol-registry.json`：agent-bus `GET /v1/protocols/<kind>`
  返回的三条记录的提交快照（含 `payload_schema`、`schema_digest`、
  `contract_digest`）。可由 `npm run verify:protocol -- --live` 重新拉取比对。
- **derive/verify 组件** `src/protocol-contract.ts`：可复用。`canonicalJson` /
  `computeDigest` 逐字节复刻 agent-bus 的 `config.canonical_json` /
  `compute_digest`；`verifyRegistryRecord` 复算摘要做快照完整性校验；
  `derive*` 从 schema 机械导出 allowlist；`verifyConsumerContract` 跑双源 diff；
  `resolveProtocol` 打 live registry（不可达 ⇒ 响亮失败）。
- **checked-generated 产物** `src/protocol.generated.ts`：由
  `scripts/generate-protocol.ts`（`npm run generate:protocol`）从快照机械导出，
  提交并在测试里断言「渲染结果 === 提交产物」（手改即红）。

`src/protocol.ts` 只从生成产物派生 TS 类型（`typeof` 字面量联合），并以编译期
断言钉死接口键集合 === 注册表字段集合（漂移 ⇒ `npm run typecheck` 变红）。

## 状态机归属

agent-bus 契约（kind / payload_schema / entity_role / refs_required / description）
承载**形状**与 **status/doc_kind 值枚举**；迁移**图**是插件自有语义，落在快照的
`clue_state_machine.transitions`，并双重校验：(a) 其状态值 === 注册表导出的
status 集合；(b) 生成产物与它逐条相等。

## 验收

- `npm run verify:protocol` —— 单一可复现 check 命令；全绿才 exit 0，漂移非零并
  点名 kind + 漂移；`--live` 下注册表不可达 ⇒ 非零并点名错误（绝不静默绿）。
- `test/protocol-contract.test.ts` —— discriminative：改本地 allowlist / 快照 /
  迁移图 / 伪造 live 摘要 / 拔掉 registry ⇒ 全部变红；对 live 校验走真实 HTTP
  源，不 mock 摘要查询。

详见本仓开发纪律（`docs/constitution/001-development-discipline.md`）。