# dev_ledr_n1_ingest_01 — ingest 节点（取材 + MinerU 转写 + 按 digest 全局去重）

本文件是本包运行的证据记录（spec §8）。路径携带 `development_id`，结构上不可能变成无主债；
本包及今后各包一律写 `docs/dev-notes/<development_id>.md`，不再使用仓根 `IMPLEMENTATION_SUMMARY.md`。

## 一、产品改动

- **新增 `src/ingest.ts`**（不 import `./bus`，不含 fetch/时钟/随机，E14）：
  - 纯决策：`extractExtension` / `stripExtension` / `routeToEndpoint`（图片→CPU、其余→GPU，E6/E7）
    / `assertSupportedExt`（epub/mobi/chm/azw 响亮失败，E10）/ `assertUnder4MB`（超 4MB 报错，E9）
    / `extractMd`（按去扩展名文件名取 md_content，E8）。
  - 执行壳 `runIngest(deps, input)`：查 digest 去重 → 取材 → 4MB 护栏 → 硬路由端点 → 转写 → 发布 doc(transcript)。
    MinerU 不可达 / failed ⇒ 响亮失败并把该 clue 置 blocked（E11/E12）。
  - `withSerializedTranscribe`：MinerU 并发实际为 1，转写调用串行化（任一时刻在飞 ≤ 1，E13）。
- **新增 `src/mineru.ts`**（唯一允许 fetch 的 IO 层）：同步 `POST /file_parse`，
  显式 `files`（复数数组）/ `backend=pipeline` / `return_md=true`；不走任务提交 + 轮询（E4/E5）。
- **新增 `test/ingest.test.ts`**：29 条用例覆盖 E1–E14。
- **删除仓根 `IMPLEMENTATION_SUMMARY.md`**（spec §8）。
- 不改 `src/protocol.ts`，不改 S1b/S2/S3/S4 既有导出签名。

## 二、spec §6 硬验收映射

| # | 断言 | 用例 |
|---|---|---|
| E1 | digest 已存在 ⇒ 不调 MinerU 且返回已有 doc | `E1` |
| E2 | digest 不存在 ⇒ 调 MinerU 恰好 1 次 + 发布 1 次 | `E2` |
| E3 | 同一材料连跑两次，第二次命中去重，MinerU 总调用 === 1 | `E3` |
| E4 | `backend=pipeline` 显式传出；源码无 `hybrid-auto-engine` | `E4` |
| E5 | 走 `/file_parse`；源码 `/tasks` 零命中 | `E5` |
| E6 | 图片(png/jpg) 路由 CPU 端点 127.0.0.1:8090 | `E6` |
| E7 | 非图片(pdf/docx) 路由 GPU 端点 172.22.62.133:8090 | `E7` |
| E8 | 结果按去扩展名文件名取（probe.pdf→probe→"X"） | `E8` |
| E9 | 4MB−1 通过；4MB+1 报错拒绝（正反两例） | `E9` |
| E10 | epub/mobi/chm/azw 响亮失败，不返回空/成功 | `E10` |
| E11 | MinerU 不可达 ⇒ 响亮失败 + clue 标 blocked | `E11` |
| E12 | MinerU 返回 failed ⇒ 同 E11（独立用例） | `E12` |
| E13 | 不并发打 MinerU（共享计数器 + 真异步挂起桩，在飞 ≤ 1） | `E13` |
| E14 | 决策逻辑纯函数（不 import ./bus；无 Date/fetch/Math.random） | `E14` |
| E15 | typecheck 与 test 均 exit 0 | 见「四」 |
| E16 | 既有 81 条用例一行未删 | 见「四」 |

## 三、变异自检（R1–R7 逐断言归因）

| 变异 | 模拟缺陷 | 被杀断言 | 结果 |
|---|---|---|---|
| R1 | 去掉 digest 去重（每次都调 MinerU） | E1、E3 | ✅ 杀 |
| R2 | `backend` 改回 `hybrid-auto-engine` | E4 | ✅ 杀 |
| R3 | 图片路由改成 GPU | E6 | ✅ 杀 |
| R4 | 结果按原 filename（带扩展名）取 | E8 | ✅ 杀 |
| R5 | 去掉 4MB 上限判断 | E9 负例（4MB+1 被拒） | ✅ 杀 |
| R6 | MinerU 失败返回空字符串而非报错 | E11、E12 | ✅ 杀 |
| R7 | 去掉并发限制（放开并行） | E13 | ✅ 杀 |

## 四、验收

- `npm run typecheck` → exit 0
- `npm test` → 7 files / 110 tests 全部通过（既有 81 条 + 本包净增 29 条，`it(` 无净减少）
- `.dev-dispatch/**` 全程字节未变
