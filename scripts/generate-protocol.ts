/**
 * C4 —— checked-generated 产物生成器（单一路径，非运行期依赖）。
 *
 * 从提交的注册表快照 `src/protocol-registry.json`（先做完整性校验）机械导出
 * `src/protocol.generated.ts`。源改 → 产物改；产物被手改 → `verify:protocol` /
 * 测试变红。运行：`npm run generate:protocol`。
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  formatDrifts,
  loadRegistrySnapshot,
  renderGeneratedProtocol,
  verifyRegistrySnapshot,
} from "../src/protocol-contract";

const snapshot = loadRegistrySnapshot();

const drifts = verifyRegistrySnapshot(snapshot);
if (drifts.length > 0) {
  console.error(
    `generate:protocol: registry snapshot failed integrity check — ${formatDrifts(drifts)}`,
  );
  process.exit(1);
}

const content = renderGeneratedProtocol(snapshot);
const outPath = fileURLToPath(new URL("../src/protocol.generated.ts", import.meta.url));
writeFileSync(outPath, content, "utf8");
console.log(`generate:protocol: wrote ${outPath}`);