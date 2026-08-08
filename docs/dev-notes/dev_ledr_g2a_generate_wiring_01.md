# G2a —— 生成段接线：把 S4 的占位 spawn 接到真实 R2 role

development_id: `dev_ledr_g2a_generate_wiring_01`
attempt: `implement`（initial）
input_commit: `df0e4596837a5c81d696f55a4f41f4b60be515c5`

## 结论先行

本包把 `src/generate.ts` 的 `spawnDebater(route)` / `spawnSynthesizer(route)` 占位形状
替换为**按 role 派发 + 引擎侧组装语料 + 位置参数注入 + 产物回写 `research.doc.v2`** 的完整接线。
`GenerateConfig` 占位符换成真实 role/route（`dr-debater-*` / `dr-synthesizer`）。
全量 315 tests / 17 files 全绿（基线 305 / 17，新增 10 条）。

## 实现（src/generate.ts）

- **deps 形状**：`spawnDebater(route)`/`spawnSynthesizer(route)` → `spawnRole(role, route, corpus): Promise<{ body }>`。
  三件事齐全：role、语料、返回 body。
- **config 真实值**（spec §2.1 表格）：

  | 角色 | role | route |
  |---|---|---|
  | debater 立论 | `dr-debater-advocate` | `opus-4-8/ccs` |
  | debater 反方 | `dr-debater-opponent` | `gpt-5.6-sol/ccs` |
  | debater 裁判 | `dr-debater-judge` | `ds-v4-pro/ccs` |
  | synthesizer | `dr-synthesizer` | `opus-5/ccs` |

  `assertDistinctDebaterRoutes()` 保留（对 `debaters[].route` 判重，互不相同）。
- **语料组装**（§2.2）：debater 语料 `{question, evidences[]}`（`anchor/quote/claim/clue_id` 从
  evidence channel 经 `readEvidences()` 回读）；judge 额外带 `prior_arguments`（advocate/opponent body）；
  synthesizer 语料 `{question, evidences[], arguments[], terminal_marker}`，`terminal_marker` 复用既有
  `renderReportBody()`（⛔ 不重造）。
- **位置参数**（§1.1）：`serializeCorpusToPositional()` 把语料序列化，`buildGenerateRoleArgv()` 把序列化
  文本放到 `--` 之后的位置参数；`--input` 只作 schema 守卫。
- **doc_kind 由 role 推出**（§1.2 / §2.3）：`deriveDocKind(role)` —— `dr-synthesizer`→`report`，
  `dr-debater-*`→`argument`；`buildDoc(role, result, origin)` ⛔ 绝不读 `result.doc_kind`。
- **产物回写**（§2.3）：`writeDoc` 发 `research.doc.v2`，`origin` 为研究 id，`digest` 缺省按 body 计算
  （`computeDocDigest`，sha256），body ≤ 4MB 护栏（`assertDocBodyWithinLimit`，超限报错拒绝）。
- **报告头部**（§2.3 / D6）：`renderReportHead(marker, anchorRate)` = 终态标记行 + `dr-anchor-rate` 行；
  核验率来自 `spawnAnchorCheck` 返回；软闸门：<90% 不阻断导出，但必须标在头部。
- **串行边**（§2.4 / D4）：debater（advocate/opponent 并行，judge 带 prior_arguments）→ synthesizer
  （单例 lock，并发 = 1，绝不跳过）→ anchor-check（失败不阻断）→ 导出。

## 硬验收（spec §3 逐条）

| # | 判据 | 证据 |
|---|---|---|
| D1 | 存在用例：断言序列化后的证据文本出现在**位置参数**中（不只断言 `--input` 存在） | `test/generate.test.ts` `G2a D1` describe（2 条：直接测 `buildGenerateRoleArgv` 位置槽 + 从 `readEvidences` 组装语料序列化）；M1 能杀 |
| D2 | `doc_kind` 由 role 推出的判别性用例：debater 载荷带 `doc_kind:"report"`，引擎仍发 `argument` | `G2a D2` describe（`buildDoc` 集成 + `deriveDocKind` 纯映射）；M2 能杀 |
| D3 | 三条 debater route 互不相同断言保留且有效；四角色 role/route 与真实值一致 | `assertDistinctDebaterRoutes` + `D5/Q2` 拒绝重复 + `G2a D3` 逐字段等于真实值 |
| D4 | synthesizer 并发 = 1 断言保留；绝不跳过 synthesizer 断言保留 | `S4 singleton synthesizer lock (D6/serial)`（串行化）+ `D4: never skipped` |
| D5 | 4MB 护栏正反两例（4MB-1 通过 / 4MB+1 拒绝） | `G2a D5`：`oneLess`/`atLimit` 通过、`oneMore` 拒绝；M3 拒绝侧被杀、通过侧不受影响 |
| D6 | 报告头部同时含终态标记与 anchor-check 核验率；<90% 仍导出且头部标注 | `G2a D6`：rate ∈ {50, 95} 两例，头部均含 `dr-terminal` + `dr-anchor-rate`，且 export 均调用 |
| D7 | 全量 `npx vitest run` 全绿，文件数与用例数 ≥ 基线 17 / 305 | `17 files / 315 tests` 全绿 |
| D8 | 变异矩阵逐断言归因，回显被改行，全部还原后 `git status --porcelain` 为空 | 见下 §4 |
| D9 | 交付只加/改本仓代码与测试，不碰 `agent-runtime`、不注册协议 | `git diff --stat` 仅 `src/generate.ts` + `test/generate.test.ts` |

## 变异矩阵（spec §4，逐断言归因）

### M1 —— 把语料从位置参数挪回只传 `--input`（`serializeCorpusToPositional` 改返回 `""`）
改后回显：`return "";`（在 `serializeCorpusToPositional` 内）。
被杀的断言（`test/generate.test.ts`）：
- `G2a D1 ... > D1: serialized evidence text appears in the positional args (not just --input)` ✗
  （`expect(positional).toContain("code://repo@abc123:src/foo.ts#L42")`）
- `G2a D1 ... > D1: the assembled debater corpus flows from readEvidences ...` ✗
  （`expect(serialized).toContain("code://repo@abc123:src/foo.ts#L42")`）

结果：`2 failed / 18 passed`。还原后行恢复。

### M2 —— `doc_kind` 改从 payload 读（`result.doc_kind ?? deriveDocKind(role)`）
改后回显：`doc_kind: (result.doc_kind as ...) ?? deriveDocKind(role),`
被杀的断言（`test/generate.test.ts`）：
- `G2a D2 ... > D2: a DEBATER payload carrying doc_kind:'report' ...` ✗
  （`expect(argumentDocs).toHaveLength(3)` —— advocate 被误判为 report，只剩 2 条 argument）

结果：`1 failed / 4 passed`。还原后行恢复。

### M3 —— 去掉 4MB 上限判断（`if (bytes > limitBytes)` → `if (false && ...)`）
改后回显：`if (false && bytes > limitBytes) {`
被杀的断言（`test/generate.test.ts`）：
- `G2a D5 ... > D5: 4MB-1 and 4MB pass; 4MB+1 is rejected` ✗
  （`expect(() => assertDocBodyWithinLimit(oneMore)).toThrow(/exceeds/)` —— 拒绝侧挂；通过侧 `oneLess`/`atLimit` 不受影响）

结果：`1 failed / 4 passed`。还原后行恢复。

### D8 —— 还原干净
M1/M2/M3 每次改后已回显被改行；全部还原后 `git status --porcelain` 仅剩本包应提交的
`src/generate.ts` / `test/generate.test.ts`（无残留、无 `.dev-dispatch/**` 改动）。

## 验证命令
- `npm run typecheck`：exit 0。
- `npm test`：`Test Files 17 passed (17)` / `Tests 315 passed (315)`。

## 非目标（未触碰，越界即超出 scope）
- 未做 triage 的 spawn 接线（归 G2b）；未注册任何 bus 协议（留给派发方公示流程）；
  未改 `agent-runtime`（不同仓）；未做端到端真跑真 bus（协议未注册，留 Phase 6）；
  未改 `bin/deep-research-loop.sh`；未动 `tsconfig` 的 `include`。
