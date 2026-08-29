/**
 * C4 —— 单一可复现 check 命令（deliverable 3/4）。
 *
 * 对每一个本应用消费的协议 kind 跑双源 diff，全绿才 exit 0；任一 kind 漂移
 * ⇒ exit 1 并点名 kind + 漂移。注册表（live 模式）不可达 ⇒ 非零并点名错误。
 *
 * 默认（离线、可复现）：校验提交的快照完整性 + 本地 checked-generated 产物。
 *   npm run verify:protocol
 *
 * --live：额外打 live agent-bus `GET /v1/protocols` 逐 kind 比对，注册表不可达
 *   ⇒ 响亮失败（绝不静默绿）。URL/token 用 PROTOCOL_REGISTRY_URL /
 *   PROTOCOL_REGISTRY_TOKEN_FILE 覆盖（默认 127.0.0.1:7490 / line-deep-research）。
 */
import * as generated from "../src/protocol.generated";
import {
  CONSUMED_PROTOCOL_KINDS,
  formatDrifts,
  loadRegistrySnapshot,
  resolveProtocol,
  verifyConsumerContract,
} from "../src/protocol-contract";

const live = process.argv.includes("--live");

const snapshot = loadRegistrySnapshot();

const result = verifyConsumerContract({
  snapshot,
  consumer: {
    clueStatuses: generated.CLUE_STATUSES,
    docKinds: generated.DOC_KINDS,
    clueFields: generated.CLUE_FIELDS,
    evidenceFields: generated.EVIDENCE_FIELDS,
    docFields: generated.DOC_FIELDS,
    clueRequired: generated.CLUE_REQUIRED,
    evidenceRequired: generated.EVIDENCE_REQUIRED,
    docRequired: generated.DOC_REQUIRED,
    clueTransitions: generated.CLUE_TRANSITIONS as Record<string, readonly string[]>,
  },
});

if (!result.ok) {
  console.error(`verify:protocol: DRIFT detected — ${formatDrifts(result.drifts)}`);
  process.exit(1);
}

if (live) {
  const baseUrl = process.env.PROTOCOL_REGISTRY_URL ?? "http://127.0.0.1:7490";
  const tokenPath =
    process.env.PROTOCOL_REGISTRY_TOKEN_FILE ??
    "/data/agent-bus/tokens/line-deep-research.token";
  for (const kind of CONSUMED_PROTOCOL_KINDS) {
    try {
      const liveProto = await resolveProtocol(baseUrl, tokenPath, kind);
      const committed = snapshot.protocols[kind];
      const liveContractDigest =
        liveProto.contract_digest !== committed.contract_digest;
      const liveSchemaDigest =
        liveProto.schema_digest !== committed.schema_digest;
      const liveSchemaStr = JSON.stringify(liveProto.payload_schema);
      const committedSchemaStr = JSON.stringify(committed.payload_schema);
      if (liveContractDigest || liveSchemaDigest || liveSchemaStr !== committedSchemaStr) {
        console.error(
          `verify:protocol: live registry DRIFT for ${kind} — ` +
            `${liveContractDigest ? `contract_digest live=${liveProto.contract_digest} committed=${committed.contract_digest} ` : ""}` +
            `${liveSchemaDigest ? `schema_digest live=${liveProto.schema_digest} committed=${committed.schema_digest} ` : ""}` +
            `${liveSchemaStr !== committedSchemaStr ? "payload_schema differs" : ""}`,
        );
        process.exit(1);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`verify:protocol: registry unreachable or inconsistent — ${detail}`);
      process.exit(1);
    }
  }
}

console.log(
  `verify:protocol: OK — ${CONSUMED_PROTOCOL_KINDS.length} protocol kinds match the registry` +
    (live ? " (live)" : " (committed snapshot)"),
);
process.exit(0);