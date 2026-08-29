/**
 * C1 —— preflight 可执行入口（CLI）。
 *
 * 载入命名声明并输出单个机器可解析 JSON（stdout）。失败即关断：任一校验不通过
 * 即 non-zero 退出 + 稳定 error_code。⛔ 本入口只实现预检路径，不存在任何部署分支
 * （不部署、不重启、不安装、不发网络、不做 git 变更）。
 *
 * usage:
 *   ... --app <application> [--preflight-only]   载入声明并预检，输出单个 JSON，exit 0=PASS / 1=FAIL
 *   ... --help                                    打印用法并 exit 0
 */
import { runPreflight } from "./preflight";

const USAGE = `deep-research preflight (declarative deployment contract)

preflight 载入 deploy/ 下的应用声明并做确定性预检（失败即关断，零部署副作用）。
输出为单个机器可解析 JSON；成功 exit 0（status=PASS），失败 exit 1（status=FAIL + error_code）。

usage:
  ... --app <application> [--preflight-only]
      --app <application>   要预检的已声明应用名（见 deploy/applications.json）
      --preflight-only      显式仅预检：只做检查，绝不执行任何部署动作
                            （本 runner 只实现预检路径，无部署分支）
`;

interface ParsedArgs {
  app?: string;
  preflightOnly: boolean;
  error?: string;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let app: string | undefined;
  let preflightOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { app, preflightOnly, help: true };
    if (a === "--preflight-only") {
      preflightOnly = true;
      continue;
    }
    if (a === "--app") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { app, preflightOnly, help: false, error: "--app requires an <application> operand" };
      }
      app = next;
      i += 1;
      continue;
    }
    return { app, preflightOnly, help: false, error: `unknown argument: ${a}` };
  }
  return { app, preflightOnly, help: false };
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.app === undefined) {
    process.stderr.write(`--app <application> is required\n\n${USAGE}`);
    return 2;
  }
  const { code, result } = runPreflight({
    app: parsed.app,
    preflightOnly: parsed.preflightOnly,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return code;
}

process.exitCode = await main(process.argv.slice(2));