# IMPLEMENTATION_SUMMARY — dev_ledr_s4_generate_01 (attempt 1)

S4 生成阶段编排 + synthesizer 单例 lock + 终态标记。本文件记录 spec §7（D1–D19）
与 §8（Q1–Q6 变异自检的逐断言归因）的机械证据。所有变异均在 `src/generate.ts` 上临时改写、
跑相关断言、确认被杀后再还原；还原后 `git diff` 仅含产品改动。

## 一、产品改动

- **新增 `src/generate.ts`**（不 import `./bus`，纯决策 + 执行壳分离，沿用 S2/S3 结构）：
  - `decideGenerate(term)` —— 纯函数，`term.state !== null` 才启动生成阶段（spec §2）。
  - `buildReportMarker(term, blocked)` / `renderReportBody(marker)` / `parseReportMarker(body)`
    —— 终态标记的两个正交事实：停止原因（converged/capped）+ `blocked` 计数 + `capHit`
    （spec §5.1/§5.2），机器可解析，可确定性回读（D15）。
  - `runGenerate(deps, cfg)` —— 执行壳：读终态 → 纯决策 → 严格按序执行副作用。
    串行边 debater×3（并行）→ synthesizer（单例 lock）→ anchor-check（跑但不阻断）→ 导出。
  - `GenerateConfig` / `DEFAULT_GENERATE_CONFIG` —— debater 三 route 来自配置且互不相同
    （spec §6），不硬编码。
- **新增 `test/generate.test.ts`**：18 条用例覆盖 D1–D17。
- 不改任何既有导出；`src/tick.ts` / `src/protocol.ts` / `src/bus.ts` 零改动。

## 二、spec §7 硬验收 —— 用例映射

| # | 断言 | 用例 |
|---|---|---|
| D1 | state===null 不启动 | `D1` |
| D2 | capHit=true 且 state===null 不启动 | `D2` |
| D3 | state 非空启动（三终态各一） | `D3` |
| D4 | debater 恰好 3 | `D4` |
| D5 | 三 debater route 互不相同（去重 size 3） | `D5` |
| D6 | synthesizer 并发=1（异步挂起桩） | `D6` |
| D7 | 三 debater 索引全 < synthesizer（共享序列） | `D7` |
| D8 | synthesizer→anchor-check→导出 严格递增（共享序列） | `D8` |
| D9 | anchor-check 抛错不阻断导出 | `D9` |
| D10 | anchor-check 报缺陷不阻断导出 | `D10` |
| D11 | 报告头含停止原因 | `D11` |
| D12 | 报告头含 blocked=12 | `D12` |
| D13 | 报告头含 capHit | `D13` |
| D14 | 触顶+卡住 与 收敛 头部可区分 | `D14` |
| D15 | 头部可确定性解析 | `D15` |
| D16 | route 组合不硬编码（自定义三 route 即用） | `D16` |
| D17 | 编排决策为纯函数（不 import ./bus；无 Date/fetch/Math.random） | `D17` |
| D18 | typecheck 与 test exit 0 | 见「四」 |
| D19 | 既有 61 条用例一行未删 | 见「四」 |

D6/D7/D8 用**共享调用序列**记录各阶段发生次序并断言相对索引（spec §8.1 打桩纪律）：
D7 断言 3 个 `debater:` 条目索引全部小于 `synthesizer`；D8 断言 synthesizer < anchor-check < export。
D6 让 `spawnSynthesizer` 桩返回未 resolve 的 Promise，在挂起期间驱动第二次编排并断言
`spawnSynthesizer` 只被调用一次（`vi.waitFor` 等到第一次真正 spawn、lock 已持有后再驱动第二次）。

## 三、spec §8 变异自检 —— 逐断言归因

每次变异：改 `src/generate.ts` 单点 → 跑相关断言 → 确认被杀 → 还原。被改行如下回显。

| 变异 | 模拟缺陷 | 被杀断言 | 结果 |
|---|---|---|---|
| **Q1** | 去掉 `state===null` 启动闸门（改为一律启动） | **D1 与 D2** | ✅ 杀 |
| **Q2** | 三个 debater 用同一个 route | **D5**（并 D16） | ✅ 杀 |
| **Q3** | 去掉 synthesizer 单例 lock | **D6** | ✅ 杀 |
| **Q4** | 把 synthesizer 提到 debater 之前 | **D7** | ✅ 杀 |
| **Q5** | anchor-check 失败时 `return`（阻断导出） | **D9** | ✅ 杀 |
| **Q6** | 报告头只写单个布尔 converged（去掉 blocked 与 capHit，触顶==收敛） | **D12 与 D14** | ✅ 杀 |

被改行回显（逐条，变异时实际写入的代码）：

- Q1: `return true;`（原 `return term.state !== null;`）→ D1、D2 失败
- Q2: `cfg.debaterRoutes.map(() => deps.spawnDebater(cfg.debaterRoutes[0]))` → D5、D16 失败
- Q3: 删除 `tryLockSynthesizer` 守卫，无条件 `await deps.spawnSynthesizer(...)` → D6 失败
- Q4: synthesizer 块移到 debater 之前 → D7 失败
- Q5: anchor-check `catch { return; }`（原 catch 后继续导出）→ D9 失败
- Q6: `return \`<!-- dr-terminal converged=true -->\n\`;`（原完整带 stop/blocked/capHit）
  → D12、D14（并 D11/D13/D15）失败

Q6 采用 spec §5.1 描述的「旧设计 converged 是布尔，触顶和收敛长得一样」形态：
头部坍缩成单个布尔，不带 blocked 与 capHit，capped 与 converged 输出完全相同——
因此 D12（读不出 blocked=12）与 D14（两份头部相等）双双击杀，符合 spec §8 要求。

## 四、验收

- `npm run typecheck` → exit 0
- `npm test` → 6 files / 79 tests 全部通过（既有 61 条 + S4 净增 18 条，`it(` 无净减少）
- `.dev-dispatch/**` 全程字节未变
