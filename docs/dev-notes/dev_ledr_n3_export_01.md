# dev_ledr_n3_export_01 —— N3 导出节点

## 产品改动

- **新增 `src/export.ts`**（不 import `./bus`，纯函数 + 执行壳分离，沿用 S2/S3/S4/N1 结构）：
  - `deriveExportPath(input, vaultRoot)` —— **纯函数**路径派生，落点
    `<vaultRoot>/研究报告/<YYYY-MM-DD>-<topic-slug>.md`（spec §2）。日期取自调用方传入的
    `createdAt`，`topic-slug` 由 topic 确定性派生；不含时钟/随机（§4 幂等）。
  - `renderExportContent(input)` —— **纯函数**内容派生：头部携带 `source_message_id`、
    复用 S4 `parseReportMarker` 原样带出的终态标记、只读声明「本文件是渲染产物，可删可重生，
    请勿直接编辑」，随后跟 report body（spec §3/§5）。
  - `runExport(deps, input, vaultRoot)` —— 执行壳：纯路径 + 纯内容 → 经注入的
    `writeFile` 写入；写入失败**响亮抛错**，绝不静默（F13）。
- **新增 `test/export.test.ts`（13 条）**，逐条覆盖 F1–F13。

## 硬验收映射

| # | 断言 | 覆盖 |
|---|---|---|
| F1 | 路径派生是纯函数、不依赖桩 | `N3 path derivation is pure` |
| F2 | 内容派生是纯函数、不依赖桩 | `N3 content derivation is pure` |
| F3 | 幂等：同一输入两次 ⇒ 路径与内容逐字相同 | `N3 export is idempotent` |
| F4 | 源码无 `Date`/`Math.random`/`Date.now`；不 import `./bus` | `N3 no clock/random in source` |
| F5 | 头部含 `source_message_id` | `N3 header carries source_message_id` |
| F6 | 头部含终态标记且逐字取自 report body | `N3 header carries terminal marker verbatim` |
| F7 | 复用 S4 `parseReportMarker`，无新 `dr-terminal` 正则 | `N3 reuses parseReportMarker` |
| F8 | 头部含只读声明 | `N3 header carries read-only declaration` |
| F9 | 落点在 `<vaultRoot>/研究报告/` 下 | `N3 location under vaultRoot/研究报告` |
| F10 | `vaultRoot` 不硬编码 | `N3 vaultRoot not hardcoded` |
| F11 | 不写 `docs/` 与 `Zettelkasten/` | `N3 not under docs/ or Zettelkasten/` |
| F12 | 执行壳真写文件（安全性+活性配对） | `N3 execution shell writes the file` |
| F13 | 写入失败 ⇒ 响亮失败 | `N3 write failure is loud` |
| F14 | 未改 `.dd-evidence/` | git diff 校验为空 |
| F15 | 运行证据写 `docs/dev-notes/<development_id>.md` | 本文件；仓根无 `IMPLEMENTATION_SUMMARY.md` |
| F16 | 类型检查与全量测试通过 | `npm run typecheck` 与 `npm test` exit 0 |
| F17 | 既有 114 条用例一行未删 | `it(` 无净减少 |

## 变异自检归因

| 变异 | 被杀断言 |
|---|---|
| T1 路径里掺入 `Date.now()` | F3 与 F4 |
| T2 内容里掺入变化量 | F3 |
| T3 终态标记只带 `stop=`、丢 `blocked`/`capHit` | F6 |
| T4 头部去掉 `source_message_id` | F5 |
| T5 落点改成 `docs/` | F9 与 F11 |
| T6 `vaultRoot` 硬编码 | F10 |
| T7 写入失败 `catch` 静默吞掉 | F13 |
| T8 自写解析器、不复用 `parseReportMarker` | F7 |

## 验收

- `npm run typecheck` → exit 0
- `npm test` → 全部通过（既有 111 条 `it(` 一行未删 + 本包净增 13 条）
- `.dev-dispatch/**` 全程字节未变；`.dd-evidence/` 未动（F14）
