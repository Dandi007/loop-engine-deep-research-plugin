import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // E0c2b §1.3 的跨 drain 循环测试真正执行 bin/e0-regression.sh（多次 vite-node 子进程），
    // 单测需要更长超时（缺省 5s 不够）。
    testTimeout: 90000,
    environment: "node",
  },
});
