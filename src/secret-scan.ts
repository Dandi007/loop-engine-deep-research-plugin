/**
 * E1k D1 ⭐ —— 证据发布前的**密钥形态扫描器**（canonical spec §13.1，本线补交付）。
 *
 * 背景（spec §0 GT-1）：canonical spec §13.1 把这道闸门写在「E1 增补」里，但 E1 的 spec 把
 * 范围收窄到 ingest，**漏了它**。⇒ 证据正文此前可以带着任何形态的密钥被发到**没有 DELETE
 * 的 append-only 证据 channel** 上，且不可撤回。本模块把 §13.1 的规则集机械化。
 *
 * ⛔ 纪律（spec §1 D1 / §3）：
 *   - **纯函数、无 IO**：只吃字符串、吐 pattern 名；调用方负责取字段与记录。
 *   - ⛔ **不用模型判断**（宪法第二条）：判据全是确定性 regex + 确定性熵计算。
 *   - ⛔ **不回抄命中内容**：本模块只返回 **pattern 名**，任何返回值都不含被扫描的正文
 *     （D3：把密钥再抄进日志本身就是泄漏）。
 *
 * 规则集至少覆盖 spec §13.1 逐字列出的五类（D1）：
 *   `AKIA[0-9A-Z]{16}` / `ghp_[A-Za-z0-9]{36}` / `xoxb-` /
 *   `-----BEGIN .* PRIVATE KEY-----` / ≥40 字符连续 base64/hex 高熵串。
 */

/** 被扫描的 evidence 字段名（spec §1 D2：只扫这三个字段）。 */
export type SecretScanField = "quote" | "claim" | "anchor";

/** spec §13.1 的五类 pattern 名（⛔ 记录里只出现这些名字，绝不出现命中内容）。 */
export const SECRET_PATTERN_AWS_ACCESS_KEY_ID = "aws-access-key-id";
export const SECRET_PATTERN_GITHUB_TOKEN = "github-token";
export const SECRET_PATTERN_SLACK_BOT_TOKEN = "slack-bot-token";
export const SECRET_PATTERN_PRIVATE_KEY_BLOCK = "private-key-block";
export const SECRET_PATTERN_HIGH_ENTROPY = "high-entropy-string";

/** 全部 pattern 名（稳定次序；扫描结果按此次序去重排列，便于逐字断言）。 */
export const SECRET_PATTERN_NAMES = [
  SECRET_PATTERN_AWS_ACCESS_KEY_ID,
  SECRET_PATTERN_GITHUB_TOKEN,
  SECRET_PATTERN_SLACK_BOT_TOKEN,
  SECRET_PATTERN_PRIVATE_KEY_BLOCK,
  SECRET_PATTERN_HIGH_ENTROPY,
] as const;

/**
 * 字面形态规则（spec §13.1 前四类）。逐条对应 spec 的正则，**只放宽不收紧**：
 *   - `private-key-block`：spec 写 `-----BEGIN .* PRIVATE KEY-----`；这里用 `[^\n]*`
 *     以便同时覆盖不带算法名的 `-----BEGIN PRIVATE KEY-----`（PKCS#8 形态）。
 *   - `slack-bot-token`：spec 只要求前缀 `xoxb-`（Slack 的 bot token 前缀），逐字照搬。
 */
const LITERAL_SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: SECRET_PATTERN_AWS_ACCESS_KEY_ID, re: /AKIA[0-9A-Z]{16}/ },
  { name: SECRET_PATTERN_GITHUB_TOKEN, re: /ghp_[A-Za-z0-9]{36}/ },
  { name: SECRET_PATTERN_SLACK_BOT_TOKEN, re: /xoxb-/ },
  { name: SECRET_PATTERN_PRIVATE_KEY_BLOCK, re: /-----BEGIN [^\n]*PRIVATE KEY-----/ },
];

/** 高熵候选串的最小长度（spec §13.1 逐字：「≥40 字符连续 base64/hex」）。 */
export const HIGH_ENTROPY_MIN_LENGTH = 40;

/** ≥40 字符连续十六进制。 */
const HEX_RUN = /[0-9a-fA-F]{40,}/g;
/** ≥40 字符连续 base64（含 base64url 的 `-_`）。 */
const BASE64_RUN = /[A-Za-z0-9+/=_-]{40,}/g;

/**
 * 香农熵阈值（比特/字符）。⛔ 确定性算术，不是模型判断。
 *
 * - 十六进制字母表只有 16 个符号，理论上限 4.0 bit/char；随机摘要实测落在 3.7–3.9，
 *   而 `ffff…`、`0000…` 这类退化串接近 0 ⇒ 3.0 能把真随机摘要与退化串分开。
 * - base64 字母表 64 个符号，理论上限 6.0；随机 44 字符 base64 实测落在 4.9–5.3，
 *   而英文单词拼出的长路径/标识符（重复字母多）通常 < 4.5。
 */
export const HEX_ENTROPY_MIN_BITS = 3.0;
export const BASE64_ENTROPY_MIN_BITS = 4.5;

/** 香农熵（比特/字符）。纯函数、无 IO。空串 ⇒ 0。 */
export function shannonEntropyBits(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * E1k D4 ⭐⭐ —— anchor 里**结构位上的 digest / commit sha** 的字符区间。
 *
 * spec §0 GT-4（派发方实测的现实陷阱）：本线**合法**的 anchor 天然含 64 位 sha256 / 40 位
 * commit sha，逐字实例：
 *   `web://http://127.0.0.1:50287/e1-material5.png@fc246f0a…1cb9b#L1`
 *   `code://src/dispatch.ts@efebe270bf1e1fe88af4b9d47fc155ed068645ab#L1287`
 * 「≥40 字符连续 hex」这条规则会命中**每一条合法证据**，把整条发布链路判死。
 *
 * ⇒ 排除的是「**作为 anchor 的 digest / commit sha 出现在其结构位置上**」这一情形：
 * anchor 的形态是 `<scheme>://<locator>@<revision>[#<range>]`（`composeAnchor` /
 * `contentAnchor`），`<revision>` 段 = 最后一个 `@` 之后、其后第一个 `#` 之前。仅当该段
 * **整段恰好是纯十六进制摘要**（sha256=64 / sha1=40 / md5=32，含其它偶数长度 32..64 的
 * 兼容区间，与 E2b `isContentFingerprint` 同一套长度语义）时，它才被认定为结构位 digest。
 *
 * ⛔ 这**不是**对 `anchor` 字段整体豁免（spec §1 D4 / §2 判据 4 反向）：
 *   - 豁免只覆盖 `<revision>` 这**一段**，locator / scheme / range 段照扫；
 *   - 豁免只对**高熵**这一条规则生效，字面形态四类规则在该段照扫
 *     （`ghp_`/`xoxb-`/`AKIA`/PRIVATE KEY 都含非十六进制字符，本就进不了豁免区间）。
 *
 * @returns `[start, end)` 字符区间；不是该形态 ⇒ null。
 */
export function structuralAnchorDigestSpan(anchor: string): [number, number] | null {
  const at = anchor.lastIndexOf("@");
  if (at < 0) return null;
  const start = at + 1;
  const rest = anchor.slice(start);
  const hash = rest.indexOf("#");
  const revision = hash >= 0 ? rest.slice(0, hash) : rest;
  if (!isHexDigestShape(revision)) return null;
  return [start, start + revision.length];
}

/**
 * 「纯十六进制摘要形态」：md5(32) / sha1(40) / sha256(64)，以及偶数长度 32..64 的
 * 纯十六进制串（向后兼容，与 E2b `isContentFingerprint` 同一套长度语义）。
 * ⛔ 空串、含非十六进制字符的串一律不是。
 */
function isHexDigestShape(s: string): boolean {
  if (!/^[0-9a-fA-F]+$/.test(s)) return false;
  const len = s.length;
  if (len === 32 || len === 40 || len === 64) return true;
  return len >= 32 && len <= 64 && len % 2 === 0;
}

/** 命中区间是否**整段落在**豁免区间内（要求逐字重合，⛔ 不是「相交即豁免」）。 */
function isExemptSpan(
  start: number,
  end: number,
  exempt: [number, number] | null,
): boolean {
  return exempt !== null && start >= exempt[0] && end <= exempt[1];
}

/** 高熵规则：扫一类候选串（hex 或 base64），返回是否有非豁免命中。 */
function hasHighEntropyRun(
  text: string,
  re: RegExp,
  minBits: number,
  exempt: [number, number] | null,
): boolean {
  // ⛔ 每次调用重置 lastIndex：`re` 是模块级 /g 常量，跨调用共享状态会漏扫。
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    // D4：结构位上的 digest / commit sha ⇒ 该命中不算（⛔ 仅豁免高熵这一条规则）。
    if (isExemptSpan(start, end, exempt)) continue;
    if (shannonEntropyBits(m[0]) >= minBits) return true;
  }
  return false;
}

/**
 * E1k D1 ⭐ —— **纯函数扫描器**：对给定字段文本返回命中的 pattern 名列表（无命中 ⇒ 空数组）。
 *
 * `field` 只决定 D4 的结构位豁免是否适用（只有 `anchor` 有 `<revision>` 结构位）；
 * ⛔ 它不会让任何字段被整体跳过——三个字段都要走完整规则集。
 *
 * @returns 命中的 pattern 名（按 `SECRET_PATTERN_NAMES` 次序去重）。⛔ 不含任何命中内容。
 */
export function scanFieldForSecretPatterns(
  text: string,
  field: SecretScanField,
): string[] {
  if (!text) return [];
  // D4：只有 anchor 有「digest / commit sha 的结构位」；quote / claim 无结构可言 ⇒ 无豁免。
  const exempt = field === "anchor" ? structuralAnchorDigestSpan(text) : null;
  const hits: string[] = [];
  for (const { name, re } of LITERAL_SECRET_PATTERNS) {
    // ⛔ 字面形态规则在 anchor 的每一段（含 revision 段）都照扫：D4 禁止对 anchor 整体豁免。
    if (re.test(text)) hits.push(name);
  }
  if (
    hasHighEntropyRun(text, HEX_RUN, HEX_ENTROPY_MIN_BITS, exempt) ||
    hasHighEntropyRun(text, BASE64_RUN, BASE64_ENTROPY_MIN_BITS, exempt)
  ) {
    hits.push(SECRET_PATTERN_HIGH_ENTROPY);
  }
  return hits;
}

/** 一个字段上的命中记录：字段名 + 命中的 pattern 名。⛔ 不含字段内容（D3）。 */
export interface SecretFieldHit {
  field: SecretScanField;
  patterns: string[];
}

/** 被扫描的 evidence 最小视图（`EvidenceV2` 的三个正文字段，spec §1 D2）。 */
export interface ScannableEvidence {
  quote: string;
  claim: string;
  anchor: string;
}

/** D2 扫描的字段次序（稳定，便于逐字断言）。 */
const SCANNED_FIELDS: readonly SecretScanField[] = ["quote", "claim", "anchor"];

/**
 * E1k D2 ⭐ —— 对一条 evidence 的 `quote` / `claim` / `anchor` 三个字段跑规则集。
 *
 * @returns 逐字段的命中记录（无命中的字段不出现）；⛔ 返回值不含任何字段内容（D3）。
 */
export function scanEvidenceForSecretPatterns(
  evidence: ScannableEvidence,
): SecretFieldHit[] {
  const hits: SecretFieldHit[] = [];
  for (const field of SCANNED_FIELDS) {
    const patterns = scanFieldForSecretPatterns(evidence[field] ?? "", field);
    if (patterns.length > 0) hits.push({ field, patterns });
  }
  return hits;
}
