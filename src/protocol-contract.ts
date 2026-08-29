/**
 * C4 —— 可复用的协议契约 derive/verify 组件。
 *
 * 单一真相源：agent-bus 协议注册表（按 `contract_digest` 解析权威 schema）。
 * 本组件不手抄任何字段名 / kind / 状态 / 迁移 allowlist —— 它只做两类事：
 *
 *   1. derive：从注册表记录的 `payload_schema`（JSON Schema）机械导出本地消费端
 *      allowlist（字段集合、必填集合、status/doc_kind 值枚举）。
 *   2. verify：把本地消费端契约（checked-generated 产物）与注册表摘要做双源 diff，
 *      任一 kind 漂移即非零并点名 kind + 漂移细节；注册表不可达则响亮失败。
 *
 * canonicalization 必须逐字节复刻 agent-bus 的
 * `config.canonical_json`（json.dumps sort_keys=True, ensure_ascii=False,
 * separators=(",", ":")) 与 `compute_digest`（sha256:hex）。若这里与 agent-bus
 * 不一致，`schema_digest`/`contract_digest` 将无法复算，verify 直接变红。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── canonical JSON（复刻 agent-bus config.canonical_json / compute_digest）──

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as { [key: string]: unknown };
    const out: { [key: string]: unknown } = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortDeep(obj[key]);
    }
    return out;
  }
  return value;
}

/** 与 agent-bus `canonical_json` 逐字节一致的确定性 JSON 序列化。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

/** 与 agent-bus `compute_digest` 逐字节一致：`sha256:<hex>`。 */
export function computeDigest(canonical: string): string {
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** `payload_schema` 的 `schema_digest`。 */
export function schemaDigestOf(payloadSchema: unknown): string {
  return computeDigest(canonicalJson(payloadSchema));
}

// ── 注册表契约形状 ──

export interface ProtocolContract {
  kind: string;
  payload_schema: JsonValue;
  entity_role: string;
  refs_required: boolean;
  description: string;
}

export interface RegistryProtocolRecord extends ProtocolContract {
  schema_digest: string;
  contract_digest: string;
}

export interface RegistrySnapshot {
  contract_version: string;
  source: string;
  protocols: Record<string, RegistryProtocolRecord>;
  clue_state_machine?: {
    source: string;
    transitions: Record<string, string[]>;
  };
}

/** 本应用消费（需要 derive/verify）的协议 kind。 */
export const CONSUMED_PROTOCOL_KINDS = [
  "research.clue.v2",
  "research.evidence.v2",
  "research.doc.v2",
] as const;

export type ConsumedProtocolKind = (typeof CONSUMED_PROTOCOL_KINDS)[number];

const isConsumedKind = (k: string): k is ConsumedProtocolKind =>
  (CONSUMED_PROTOCOL_KINDS as readonly string[]).includes(k);

/**
 * 从一条注册表记录重建其 `contract`（`PROTOCOL_ALLOWED_FIELDS` 五字段：
 * kind / payload_schema / entity_role / refs_required / description）。
 */
export function contractOf(record: RegistryProtocolRecord): ProtocolContract {
  return {
    kind: record.kind,
    payload_schema: record.payload_schema,
    entity_role: record.entity_role,
    refs_required: record.refs_required,
    description: record.description,
  };
}

/** `contract_digest = sha256(canonical_json(contract))`。 */
export function contractDigestOf(record: RegistryProtocolRecord): string {
  return computeDigest(canonicalJson(contractOf(record)));
}

// ── verify：注册表记录完整性（防止快照被手改后仍被当作权威）──

export interface Drift {
  kind: string;
  field: string;
  expected: string;
  actual: string;
}

/**
 * 复算单条注册表记录的 `schema_digest` 与 `contract_digest`，与记录里携带的
 * 摘要比对。任一不匹配 ⇒ 该快照与真正的 agent-bus 注册表漂移，返回漂移列表。
 */
export function verifyRegistryRecord(
  record: RegistryProtocolRecord,
): Drift[] {
  const drifts: Drift[] = [];
  const schemaDigest = schemaDigestOf(record.payload_schema);
  if (schemaDigest !== record.schema_digest) {
    drifts.push({
      kind: record.kind,
      field: "schema_digest",
      expected: record.schema_digest,
      actual: schemaDigest,
    });
  }
  const contractDigest = contractDigestOf(record);
  if (contractDigest !== record.contract_digest) {
    drifts.push({
      kind: record.kind,
      field: "contract_digest",
      expected: record.contract_digest,
      actual: contractDigest,
    });
  }
  return drifts;
}

/** 对整份快照做登记表完整性校验（只消费 kind 全部校验）。 */
export function verifyRegistrySnapshot(snapshot: RegistrySnapshot): Drift[] {
  const drifts: Drift[] = [];
  for (const kind of CONSUMED_PROTOCOL_KINDS) {
    const record = snapshot.protocols[kind];
    if (!record) {
      drifts.push({
        kind,
        field: "record",
        expected: "present in snapshot.protocols",
        actual: "missing",
      });
      continue;
    }
    drifts.push(...verifyRegistryRecord(record));
  }
  return drifts;
}

// ── derive：从 payload_schema 机械导出本地 allowlist ──

function toSortedKeys(obj: JsonValue | undefined): string[] {
  if (obj === undefined || obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(
      `derive: expected a JSON-Schema object for properties/required, got ${JSON.stringify(obj)}`,
    );
  }
  return Object.keys(obj).sort();
}

/** 导出某一 schema 的字段名集合（`properties` 的键，排序）。 */
export function deriveFieldAllowlist(
  payloadSchema: JsonValue,
  kind: string,
): string[] {
  const schema = payloadSchema as { properties?: JsonValue };
  const props = schema.properties;
  if (props === undefined || props === null || typeof props !== "object" || Array.isArray(props)) {
    throw new Error(`derive: ${kind} payload_schema has no object properties`);
  }
  return Object.keys(props).sort();
}

/** 导出某一 schema 的 required 键（排序）。 */
export function deriveRequiredAllowlist(
  payloadSchema: JsonValue,
  kind: string,
): string[] {
  const schema = payloadSchema as { required?: JsonValue };
  const required = schema.required;
  if (!Array.isArray(required)) {
    throw new Error(`derive: ${kind} payload_schema has no array required`);
  }
  return required
    .filter((r): r is string => typeof r === "string")
    .slice()
    .sort();
}

/**
 * 从某字段的 `description`（形如 `a|b|c`）导出值枚举，顺序即描述里的顺序。
 * description 不是 `|` 分隔 ⇒ 响亮抛错（这个字段本就不承载枚举）。
 */
export function deriveEnumFromDescription(
  payloadSchema: JsonValue,
  kind: string,
  propertyName: string,
): string[] {
  const schema = payloadSchema as { properties?: JsonValue };
  const props = schema.properties;
  if (props === undefined || props === null || typeof props !== "object" || Array.isArray(props)) {
    throw new Error(`derive: ${kind} payload_schema has no object properties`);
  }
  const prop = (props as Record<string, JsonValue>)[propertyName];
  const description =
    prop !== null && typeof prop === "object"
      ? (prop as { description?: JsonValue }).description
      : undefined;
  if (typeof description !== "string") {
    throw new Error(
      `derive: ${kind}.properties.${propertyName} has no string description to derive the value enum from`,
    );
  }
  const values = description.split("|");
  if (values.length === 0 || values.some((v) => v.trim() === "")) {
    throw new Error(
      `derive: ${kind}.properties.${propertyName} description is not a valid "|"-separated enum: ${JSON.stringify(description)}`,
    );
  }
  return values;
}

/**
 * 从已通过完整性校验的快照机械渲染 `src/protocol.generated.ts` 的内容（纯函数）。
 * 生成器脚本与「产物未漂移」测试共用此实现，保证产物永远与源一致。
 */
export function renderGeneratedProtocol(snapshot: RegistrySnapshot): string {
  const clue = snapshot.protocols["research.clue.v2"];
  const evidence = snapshot.protocols["research.evidence.v2"];
  const doc = snapshot.protocols["research.doc.v2"];
  if (!clue || !evidence || !doc) {
    throw new Error("renderGeneratedProtocol: snapshot is missing a consumed protocol kind");
  }
  const clueStatuses = deriveEnumFromDescription(clue.payload_schema, clue.kind, "status");
  const docKinds = deriveEnumFromDescription(doc.payload_schema, doc.kind, "doc_kind");
  const clueFields = deriveFieldAllowlist(clue.payload_schema, clue.kind);
  const evidenceFields = deriveFieldAllowlist(evidence.payload_schema, evidence.kind);
  const docFields = deriveFieldAllowlist(doc.payload_schema, doc.kind);
  const clueRequired = deriveRequiredAllowlist(clue.payload_schema, clue.kind);
  const evidenceRequired = deriveRequiredAllowlist(evidence.payload_schema, evidence.kind);
  const docRequired = deriveRequiredAllowlist(doc.payload_schema, doc.kind);
  const transitions = snapshot.clue_state_machine?.transitions;
  if (!transitions) {
    throw new Error("renderGeneratedProtocol: snapshot is missing clue_state_machine.transitions");
  }
  const asConst = (arr: readonly string[]) =>
    `[${arr.map((v) => JSON.stringify(v)).join(", ")}] as const`;
  const transitionsBody = clueStatuses
    .map(
      (from) =>
        `  ${JSON.stringify(from)}: [${(transitions[from] ?? [])
          .map((t) => JSON.stringify(t))
          .join(", ")}],`,
    )
    .join("\n");
  return `// AUTO-GENERATED by scripts/generate-protocol.ts from src/protocol-registry.json.
// DO NOT EDIT BY HAND — 手改会被 verify:protocol / 测试判漂移。重新生成: npm run generate:protocol

export const CLUE_STATUSES = ${asConst(clueStatuses)};
export const DOC_KINDS = ${asConst(docKinds)};

export const CLUE_FIELDS = ${asConst(clueFields)};
export const EVIDENCE_FIELDS = ${asConst(evidenceFields)};
export const DOC_FIELDS = ${asConst(docFields)};

export const CLUE_REQUIRED = ${asConst(clueRequired)};
export const EVIDENCE_REQUIRED = ${asConst(evidenceRequired)};
export const DOC_REQUIRED = ${asConst(docRequired)};

export const CLUE_TRANSITIONS = {
${transitionsBody}
} as const;
`;
}

/** 本地消费端契约（来自 checked-generated 产物）的运行时画像。 */
export interface ConsumerAllowlist {
  clueStatuses: readonly string[];
  docKinds: readonly string[];
  clueFields: readonly string[];
  evidenceFields: readonly string[];
  docFields: readonly string[];
  clueRequired: readonly string[];
  evidenceRequired: readonly string[];
  docRequired: readonly string[];
  clueTransitions: Record<string, readonly string[]>;
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * 双源 diff：把本地 checked-generated 消费端契约与（已做注册表完整性校验的）
 * 快照做机械比对。任一 kind 漂移 ⇒ 返回逐条漂移；全绿 ⇒ ok=true 且 drifts 为空。
 *
 * 这里就是 deliverable 3 的「machine-runnable 双源 diff」核心；`verify:protocol`
 * 命令与 discriminative 测试都调用它。
 */
export function verifyConsumerContract(opts: {
  snapshot: RegistrySnapshot;
  consumer: ConsumerAllowlist;
}): { ok: boolean; drifts: Drift[] } {
  const { snapshot, consumer } = opts;
  const drifts: Drift[] = [];

  // 消费端产出物若省略了注册表完整性校验，仍要强制先校验，否则一张被手改的
  // 快照会被当作权威（review bar：不得静默绿）。
  drifts.push(...verifyRegistrySnapshot(snapshot));

  const clue = snapshot.protocols["research.clue.v2"];
  const evidence = snapshot.protocols["research.evidence.v2"];
  const doc = snapshot.protocols["research.doc.v2"];

  for (const kind of CONSUMED_PROTOCOL_KINDS) {
    if (!snapshot.protocols[kind]) {
      drifts.push({ kind, field: "record", expected: "present", actual: "missing" });
    }
  }

  if (clue) {
    const statuses = deriveEnumFromDescription(clue.payload_schema, clue.kind, "status");
    const fields = deriveFieldAllowlist(clue.payload_schema, clue.kind);
    const required = deriveRequiredAllowlist(clue.payload_schema, clue.kind);
    if (!sameArray(consumer.clueStatuses, statuses)) {
      drifts.push({
        kind: clue.kind,
        field: "status-values",
        expected: JSON.stringify(statuses),
        actual: JSON.stringify([...consumer.clueStatuses]),
      });
    }
    if (!sameArray(consumer.clueFields, fields)) {
      drifts.push({
        kind: clue.kind,
        field: "properties",
        expected: JSON.stringify(fields),
        actual: JSON.stringify([...consumer.clueFields]),
      });
    }
    if (!sameArray(consumer.clueRequired, required)) {
      drifts.push({
        kind: clue.kind,
        field: "required",
        expected: JSON.stringify(required),
        actual: JSON.stringify([...consumer.clueRequired]),
      });
    }
  }

  if (evidence) {
    const fields = deriveFieldAllowlist(evidence.payload_schema, evidence.kind);
    const required = deriveRequiredAllowlist(evidence.payload_schema, evidence.kind);
    if (!sameArray(consumer.evidenceFields, fields)) {
      drifts.push({
        kind: evidence.kind,
        field: "properties",
        expected: JSON.stringify(fields),
        actual: JSON.stringify([...consumer.evidenceFields]),
      });
    }
    if (!sameArray(consumer.evidenceRequired, required)) {
      drifts.push({
        kind: evidence.kind,
        field: "required",
        expected: JSON.stringify(required),
        actual: JSON.stringify([...consumer.evidenceRequired]),
      });
    }
  }

  if (doc) {
    const kinds = deriveEnumFromDescription(doc.payload_schema, doc.kind, "doc_kind");
    const fields = deriveFieldAllowlist(doc.payload_schema, doc.kind);
    const required = deriveRequiredAllowlist(doc.payload_schema, doc.kind);
    if (!sameArray(consumer.docKinds, kinds)) {
      drifts.push({
        kind: doc.kind,
        field: "doc_kind-values",
        expected: JSON.stringify(kinds),
        actual: JSON.stringify([...consumer.docKinds]),
      });
    }
    if (!sameArray(consumer.docFields, fields)) {
      drifts.push({
        kind: doc.kind,
        field: "properties",
        expected: JSON.stringify(fields),
        actual: JSON.stringify([...consumer.docFields]),
      });
    }
    if (!sameArray(consumer.docRequired, required)) {
      drifts.push({
        kind: doc.kind,
        field: "required",
        expected: JSON.stringify(required),
        actual: JSON.stringify([...consumer.docRequired]),
      });
    }
  }

  // 状态机：key 集合必须 === 注册表导出的 status 集合；每条迁移的源/目标都必须
  // 落在该集合内（迁移图是插件自有语义，但其状态值必须来自注册表）。
  if (clue) {
    const statuses = deriveEnumFromDescription(clue.payload_schema, clue.kind, "status");
    const transitionKeys = Object.keys(consumer.clueTransitions).sort();
    const statusSet = new Set(statuses);
    const statusSorted = [...statuses].sort();
    if (!sameArray(transitionKeys, statusSorted)) {
      drifts.push({
        kind: clue.kind,
        field: "transitions.keys",
        expected: JSON.stringify(statusSorted),
        actual: JSON.stringify(transitionKeys),
      });
    }
    for (const [from, targets] of Object.entries(consumer.clueTransitions)) {
      if (!statusSet.has(from)) {
        drifts.push({
          kind: clue.kind,
          field: `transitions.from[${from}]`,
          expected: "one of " + JSON.stringify(statuses),
          actual: from,
        });
      }
      for (const to of targets) {
        if (!statusSet.has(to)) {
          drifts.push({
            kind: clue.kind,
            field: `transitions[${from} -> ${to}]`,
            expected: "target within " + JSON.stringify(statuses),
            actual: to,
          });
        }
      }
    }
    const committed = snapshot.clue_state_machine?.transitions;
    if (committed) {
      const committedKeys = Object.keys(committed).sort();
      if (!sameArray(transitionKeys, committedKeys)) {
        drifts.push({
          kind: clue.kind,
          field: "transitions.source-keys",
          expected: JSON.stringify(committedKeys),
          actual: JSON.stringify(transitionKeys),
        });
      }
      for (const key of committedKeys) {
        if (!sameArray(consumer.clueTransitions[key] ?? [], committed[key])) {
          drifts.push({
            kind: clue.kind,
            field: `transitions.source[${key}]`,
            expected: JSON.stringify(committed[key]),
            actual: JSON.stringify(consumer.clueTransitions[key] ? [...consumer.clueTransitions[key]] : []),
          });
        }
      }
    }
  }

  return { ok: drifts.length === 0, drifts };
}

// ── 快照加载 / live 解析 ──

const SNAPSHOT_URL = new URL("./protocol-registry.json", import.meta.url);

/** 读取已提交的注册表快照（`src/protocol-registry.json`）。 */
export function loadRegistrySnapshot(): RegistrySnapshot {
  return JSON.parse(
    readFileSync(fileURLToPath(SNAPSHOT_URL), "utf8"),
  ) as RegistrySnapshot;
}

/** live registry 里一条协议的公开视图（与 http_server._protocol_public_fields 对齐）。 */
export interface LiveProtocol {
  kind: string;
  payload_schema: JsonValue;
  entity_role: string;
  refs_required: boolean;
  description: string;
  schema_digest: string;
  contract_digest: string;
}

/**
 * 从 live agent-bus 解析权威 schema。`GET /v1/protocols/<kind>`。
 *
 * ⛔ 注册表不可达（网络错误 / 非 2xx / 非 JSON）⇒ 响亮抛错并点名 kind，绝不停用、
 *    跳过、或静默降级为绿（deliverable 4）。
 */
export async function resolveProtocol(
  baseUrl: string,
  tokenPath: string,
  kind: string,
): Promise<LiveProtocol> {
  let bearer: string;
  try {
    bearer = readFileSync(tokenPath, "utf8").trim();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `registry: failed to read bus token at '${tokenPath}' (${detail}); cannot resolve protocol "${kind}". The registry lookup is mandatory; refusing to skip it.`,
    );
  }
  if (!bearer) {
    throw new Error(
      `registry: bus token at '${tokenPath}' is empty; cannot resolve protocol "${kind}". Refusing to skip the registry lookup.`,
    );
  }
  const path = `/v1/protocols/${encodeURIComponent(kind)}`;
  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `registry: unreachable at ${baseUrl} while resolving protocol "${kind}" (${detail}). Refusing to silently pass.`,
    );
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `registry: ${baseUrl}${path} -> HTTP ${resp.status} while resolving protocol "${kind}" (${body.slice(0, 200)}). Refusing to silently pass.`,
    );
  }
  const data = (await resp.json()) as { protocol?: LiveProtocol };
  const proto = data.protocol;
  if (!proto || typeof proto.kind !== "string") {
    throw new Error(
      `registry: ${baseUrl}${path} returned no "protocol" object for "${kind}". Refusing to silently pass.`,
    );
  }
  // 复算 live 记录自身摘要，确保读到的是与注册表一致的权威 schema。
  const drifts = verifyRegistryRecord({
    ...proto,
    entity_role: proto.entity_role,
    refs_required: proto.refs_required,
  });
  if (drifts.length > 0) {
    throw new Error(
      `registry: live record for "${kind}" failed its own digest check: ${formatDrifts(drifts)}`,
    );
  }
  return proto;
}

/** 把漂移列表格式化为人类可读字符串（check 命令 / 测试同款）。 */
export function formatDrifts(drifts: Drift[]): string {
  return drifts
    .map((d) => `${d.kind}:${d.field} expected ${d.expected} got ${d.actual}`)
    .join("; ");
}

/** 合规检查：消费端 only 的 kind 判定。 */
export function isConsumedKindValue(kind: string): boolean {
  return isConsumedKind(kind);
}