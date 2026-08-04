# dev_ledr_n1_ingest_02 —— N1 ingest 节点

## 产品改动

- **新增 `src/ingest.ts`**（不 import `./bus`，纯决策 + 执行壳分离，沿用 S2/S3/S4 结构）：
  - `buildDigestIndex(messages)` —— 纯函数，按 digest 建全量索引，同一 digest 只留一条
    doc(transcript)（spec §3 / E17）。入参是纯数据数组，不碰网络。
  - `scanAllMessages(scanFn)` —— 分页扫描，必须带 `after_seq` 翻页直到取空（E18）。
  - `readExistingTranscript(scanFn, digest)` —— 由「分页扫描 + 全量 digest 索引」**组合实现**，
    非抽象（E19）。同 digest 已有 doc ⇒ 返回已有 doc，绝不调 MinerU。
  - `classifyExtension` / `stripExtension` / `assertWithinSizeLimit` —— 硬路由（图片→CPU）、
    去扩展名取 key、4MB 护栏（E6/E7/E8/E9/E10）。
  - `createMutex` / `transcribeMaterial` / `transcribeBatch` —— 串行化执行壳：
    取材 → 4MB 护栏 → 路由 → MinerU 转写 → 发布 doc；失败响亮抛错并标 clue `blocked`（E11/E12/E13）。
- **新增 `src/mineru.ts`**（真实 MinerU 客户端，spec §2）：
  - 只走同步 `.../file_parse`，不做任务管理路由。
  - 按扩展名硬路由：图片 → `127.0.0.1:8090`（CPU），pdf/office → `172.22.62.133:8090`（GPU）。
  - 显式传 `backend=pipeline`、`return_md=true`；按「去扩展名文件名」从 `results` 取值。
  - `status=failed` / HTTP 非 2xx / 缺 `md_content` ⇒ 响亮抛错，绝不静默降级。
- **新增 `test/ingest.test.ts`（24 条）、`test/mineru.test.ts`（9 条）**，覆盖 E1–E19。
- **删除仓根 `IMPLEMENTATION_SUMMARY.md`**，运行证据改写到本文件（spec §8）。

## 硬验收映射

| # | 断言 | 覆盖 |
|---|---|---|
| E1 | digest 已存在 ⇒ 不调 MinerU 且返回已有 doc | `N1 digest dedup` |
| E2 | digest 不存在 ⇒ MinerU 恰好 1 次 + publish 1 次 | `N1 digest dedup` |
| E3 | 同一材料连跑两次，第二次命中去重，MinerU 总调用 1 | `N1 digest dedup` |
| E4 | `backend=pipeline` 显式传出；源码无 `hybrid-auto-engine` | `N1 MinerU backend=pipeline` |
| E5 | 走 `/file_parse`；源码无任务管理路由 | `N1 MinerU sync /file_parse contract` |
| E6 | 图片路由到 CPU 端点 | `N1 extension hard routing` |
| E7 | 非图片路由到 GPU 端点 | `N1 extension hard routing` |
| E8 | 结果按「去扩展名文件名」取 | `N1 result key is filename without extension` |
| E9 | 4MB 正反两例 | `N1 4MB guard` |
| E10 | 不支持扩展名响亮失败 | `N1 unsupported extensions fail loudly` |
| E11 | MinerU 不可达 ⇒ 响亮失败 + clue blocked | `N1 MinerU failure marks the clue blocked` |
| E12 | MinerU `status=failed` ⇒ 同 E11 | `N1 MinerU failure shapes are distinct` |
| E13 | 不并发打 MinerU（在飞 ≤ 1） | `N1 no concurrent MinerU` + `createMutex` |
| E14 | 决策逻辑纯函数（不 import ./bus；无 Date/fetch/Math.random） | `N1 pure decision module` |
| E17 | `buildDigestIndex` 不依赖桩的真实函数 | `N1 buildDigestIndex` |
| E18 | 分页：>100 条多次带 `after_seq` 读取 | `N1 paginated scan` |
| E19 | `readExistingTranscript` 组合实现、非抽象 | `N1 readExistingTranscript composition` |
| E20 | 未改 `.dd-evidence/` | git diff 校验为空 |

## 变异自检归因

| 变异 | 被杀断言 |
|---|---|
| R1 去掉 digest 去重 | E1 与 E3 |
| R2 `backend` 改回 `hybrid-auto-engine` | E4 |
| R3 图片路由改成 GPU | E6 |
| R4 结果按原 filename 取 | E8 |
| R5 去掉 4MB 上限判断 | E9 正例（4MB+1 应被拒） |
| R6 MinerU 失败返回空串而非报错 | E11 与 E12 |
| R7 去掉并发限制（放开并行） | E13（对 `createMutex` 本体：`return prev.then(fn).finally(release)`） |
| R8 `buildDigestIndex` 只取最后一条 | E17 |
| R9 去掉分页（只读第一页） | E18 |

## 验收

- `npm run typecheck` → exit 0
- `npm test` → 8 files / 114 tests 全部通过（既有 81 条 + 本包净增 33 条，`it(` 无净减少）
- `.dev-dispatch/**` 全程字节未变；`.dd-evidence/` 未动（E20）
