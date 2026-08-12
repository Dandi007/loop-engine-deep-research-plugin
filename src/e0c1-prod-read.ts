/**
 * E0c1 §1.2 —— 生产总线 sum(head_seq) 读数入口（供 bin/e0-regression.sh 经 vite-node 调起）。
 *
 * 读 `http://127.0.0.1:7490`（生产总线，只读 GET）的 `GET /v1/channels`，真解析 + 真求和
 * （GT-3：⛔ 禁止贪婪正则抽多值），把 `{ sum, byChannel }` 以 JSON 写到 stdout。
 *
 * URL/token 与测试总线独立（不受 AGENT_BUS_URL 覆盖影响）：
 *   - E0C1_PROD_BUS_URL（缺省 http://127.0.0.1:7490）
 *   - E0C1_PROD_BUS_TOKEN_FILE（缺省 /data/agent-bus/tokens/uther-tui.token）
 *
 * 读失败 ⇒ stderr 报错并 exit 1（入口据此判「读失败即失败」，⛔ 不得跳过检查）。
 *
 * 这个入口是 §1.2「生产总线零写入」判据的**真解析**实现：复用 src/bus.ts 的
 * `readProdBusHeadSeqSum`，避免在 bash 里另写一份求和（GT-3 的根因就是 bash 侧另写了一份
 * 贪婪正则求和）。
 */
import { readProdBusHeadSeqSum } from "./bus";

async function main(): Promise<number> {
  try {
    const result = await readProdBusHeadSeqSum();
    process.stdout.write(JSON.stringify(result));
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`E0c1: production bus sum(head_seq) read failed: ${msg}\n`);
    return 1;
  }
}

process.exitCode = await main();
