/**
 * E1k2 —— 证据发布前的凭证形态扫描（D1/D2/D3）
 *
 * 本模块是**纯函数**：给一段字段文本，返回命中的 pattern 名列表。
 * ⛔ 无 IO、⛔ 不读环境、⛔ 不用模型判断（宪法第二条：闸门必须确定性）。
 * 发布链路的接线（扫哪三个字段、命中后怎么办）在 `src/harvest.ts`（D4/D5/D6）。
 *
 * ## ⭐⭐⭐ 本模块存在的唯一难点：高熵规则**不得误伤合法内容摘要**（D3 / GT-2）
 *
 * 上一版把「≥40 字符连续 hex/base64」当成无条件命中。本线研究的对象**本身就是代码仓**，
 * 引用带摘要的行极其常见，于是真机上：
 *
 *   - 代码里的 git sha 常量行            ⇒ 被拦
 *   - 含 evidence_bundle_digest 的摘要行 ⇒ 被拦
 *   - lockfile 的 integrity 哈希行       ⇒ 被拦
 *
 * 结果是板面在长（index/docs 都在产）而**证据 channel head_seq 停在 0**——整轮研究零证据。
 * 同一份代码另一次跑发了 134 条证据（那次轨迹碰巧没引到长 hex），所以这个缺陷是
 * **间歇性的、看运气的**，比稳定失败更危险。
 *
 * ⇒ 高熵规则保留（⛔ 不得整条删除），但对**内容摘要形态**豁免（`isExemptDigestShape`）：
 *   (a) 标准摘要长度的纯十六进制串（md5/sha1/sha224/sha256/sha384/sha512，含 git 的 7–40 位短/全 sha）；
 *   (b) 带算法名前缀的摘要值（形如 `<算法名><分隔符><编码值>`），**且**编码值长度恰好等于
 *       该算法摘要字节数的 hex/base64 编码长度——⛔ 不是「见到算法名前缀就放行」，
 *       否则豁免就成了后门（判据 3）：把任意长串挂在一个算法名后面即可绕过。
 *   (c) 判定落在**每一个候选串**上，与它出现在哪个字段、字段的哪个位置无关
 *       （GT-3：上一版只豁免「锚点结构位」，真机上 quote 正文里的合法摘要照样被拦）。
 *
 * ⛔ 豁免只对高熵规则生效。①②③④ 四类凭证形态在**任何**位置都照拦不误——
 *    包括紧挨着一个合法摘要的位置（判据 3）。
 */

/** 五类规则的 pattern 名（拦截记录里点名区分用，D2）。 */
export type SecretPatternName =
  | "aws-access-key-id"
  | "github-personal-access-token"
  | "slack-bot-token"
  | "pem-private-key-block"
  | "high-entropy-string";

/** 稳定的 pattern 名次序（扫描结果按此排序，便于逐字断言）。 */
export const SECRET_PATTERN_NAMES: readonly SecretPatternName[] = [
  "aws-access-key-id",
  "github-personal-access-token",
  "slack-bot-token",
  "pem-private-key-block",
  "high-entropy-string",
] as const;

/** D4——发布前被扫描的 evidence 字段（三字段，spec §1 D4）。 */
export type SecretScanField = "quote" | "claim" | "anchor";

/** D4——扫描字段的稳定次序。 */
export const SECRET_SCAN_FIELDS: readonly SecretScanField[] = ["quote", "claim", "anchor"] as const;

/**
 * D2 ①②③④——四类**字面形态**规则。
 *
 * ⛔ 全部非 global（无 `lastIndex` 状态，`test()` 可重复调用）。
 * ⛔ 前后用 `(?<![A-Za-z0-9])` / `(?![A-Za-z0-9])` 卡边界而不是 `\b`：`\b` 把 `_` 当词内字符，
 *    会让形如 `FOO_<20 位大写串>` 的普通常量名躲开①，也会让贴着下划线的凭证躲开边界判定。
 */
const LITERAL_RULES: ReadonlyArray<{ name: SecretPatternName; pattern: RegExp }> = [
  {
    // ① 四字母大写前缀 + 16 位大写字母数字（共 20 字符）。
    name: "aws-access-key-id",
    pattern: /(?<![A-Za-z0-9])[A-Z]{4}[A-Z0-9]{16}(?![A-Za-z0-9])/,
  },
  {
    // ② 三字母小写前缀 + 下划线 + 36 位字母数字。
    name: "github-personal-access-token",
    pattern: /(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{36}(?![A-Za-z0-9])/,
  },
  {
    // ③ 四字符小写前缀 + 短横 + 令牌体（短横分段的字母数字）。
    name: "slack-bot-token",
    pattern: /(?<![A-Za-z0-9])xoxb-[A-Za-z0-9][A-Za-z0-9-]{7,}/,
  },
  {
    // ④ PEM 私钥块起始行（含 RSA / EC / OPENSSH / ENCRYPTED 等中缀，也含无中缀形态）。
    name: "pem-private-key-block",
    pattern: /-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----/,
  },
];

/** D2 ⑤——高熵串的最短长度（≥40 字符连续 base64/hex）。 */
export const HIGH_ENTROPY_MIN_LENGTH = 40;

/**
 * D2 ⑤——候选高熵串的字符集：base64 标准字母表（含填充）与 hex 的并集。
 *
 * ⛔ 刻意**不含** `-` 与 `_`：这两个字符是「算法名前缀 / 令牌前缀」与「值」之间的分隔符
 *    （`<算法名>-<base64>` 的 lockfile integrity 形态、②③ 的前缀形态）。把它们排除在外，
 *    候选串才恰好是**待判定的那个值本身**，前缀留在 `precedingText` 里供 D3(b) 检查。
 */
const HIGH_ENTROPY_RUN_SOURCE = `[A-Za-z0-9+/=]{${HIGH_ENTROPY_MIN_LENGTH},}`;

/** 纯十六进制（大小写不限）。 */
const HEX_ONLY = /^[0-9a-fA-F]+$/;

/** 标准 base64（末尾至多两个 `=` 填充）。 */
const BASE64_ONLY = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * D3(a)/(b)——常见摘要算法的**摘要字节数**。
 * hex 编码长度 = bytes*2；base64 编码长度 = 4*ceil(bytes/3)（含填充）。
 */
const DIGEST_ALGORITHM_BYTES: Readonly<Record<string, number>> = {
  md5: 16,
  sha1: 20,
  sha224: 28,
  sha256: 32,
  sha384: 48,
  sha512: 64,
};

/** D3(a)——标准摘要的 hex 编码长度集合（32 / 40 / 56 / 64 / 96 / 128）。 */
const DIGEST_HEX_LENGTHS: ReadonlySet<number> = new Set(
  Object.values(DIGEST_ALGORITHM_BYTES).map((bytes) => bytes * 2),
);

/** D3(a)——git 短 sha 的最短长度（`git rev-parse --short` 的常见下界）。 */
export const GIT_SHA_MIN_LENGTH = 7;
/** D3(a)——git 全 sha 长度（= sha1 的 hex 长度）。 */
export const GIT_SHA_MAX_LENGTH = 40;

/**
 * D3(a) ⭐⭐——「裸摘要」形态：纯十六进制，且长度落在**标准摘要长度**或 **git 短/全 sha** 区间。
 *
 * 判据 2 的第一条真实语料（一行源码把 40 位十六进制 git sha 赋给常量）走的就是这条：
 * 40 既是 git 全 sha 长度、也是 sha1 的 hex 长度。
 *
 * ⛔ 非标准长度的纯 hex（例如 44 位、50 位）**不豁免**——那不是任何常见摘要的编码长度，
 *    正是判据 4 ⑤ 要拦下的形态。
 */
export function isBareDigestHex(token: string): boolean {
  if (!HEX_ONLY.test(token)) return false;
  const length = token.length;
  if (DIGEST_HEX_LENGTHS.has(length)) return true;
  return length >= GIT_SHA_MIN_LENGTH && length <= GIT_SHA_MAX_LENGTH;
}

/**
 * D3(b)——候选串**紧邻左侧**是否是一个「算法名 + 分隔符」前缀（形如 `<算法名>:` / `<算法名>-`）。
 *
 * @returns 归一成小写的算法名；不是已知算法（或压根没有前缀）⇒ null。
 */
export function digestAlgorithmPrefixBefore(precedingText: string): string | null {
  const matched = /(?:^|[^A-Za-z0-9])([A-Za-z0-9]+)[-:]$/.exec(precedingText);
  if (!matched) return null;
  const algorithm = matched[1].toLowerCase();
  return Object.prototype.hasOwnProperty.call(DIGEST_ALGORITHM_BYTES, algorithm)
    ? algorithm
    : null;
}

/**
 * D3(b) ⭐⭐——候选串是否**恰好**是该算法摘要的一个合法编码（hex 或 base64，长度精确匹配）。
 *
 * ⛔ 这一步是「豁免不得开成后门」（判据 3）的关键：只认算法名前缀而不校验编码长度，
 *    等于宣布「任何长串只要挂在一个算法名后面就放行」——那就是一条可被直接利用的绕过路径。
 */
export function isEncodedDigestOf(algorithm: string, token: string): boolean {
  const bytes = DIGEST_ALGORITHM_BYTES[algorithm];
  if (bytes === undefined) return false;
  if (token.length === bytes * 2 && HEX_ONLY.test(token)) return true;
  return token.length === 4 * Math.ceil(bytes / 3) && BASE64_ONLY.test(token);
}

/**
 * D3 ⭐⭐⭐——一个高熵候选串是否属于**合法内容摘要形态**（⇒ 高熵规则对它豁免）。
 *
 * @param token 候选串本身（由 `highEntropyRuns` 切出）。
 * @param precedingText 该候选串在原文中**左侧的全部文本**（用于 (b) 的算法名前缀判定）。
 *
 * ⛔ (c)——本函数只看候选串与它的左邻，**不看字段名、不看字段内位置**：
 *    上一版只豁免「锚点结构位」上的 digest，真机上 `quote` 正文里的合法摘要照样被拦，
 *    整轮零证据（GT-3）。
 */
export function isExemptDigestShape(token: string, precedingText: string): boolean {
  if (isBareDigestHex(token)) return true;
  const algorithm = digestAlgorithmPrefixBefore(precedingText);
  return algorithm !== null && isEncodedDigestOf(algorithm, token);
}

/** 一个高熵候选串及其在原文中的起始下标。 */
export interface HighEntropyRun {
  value: string;
  index: number;
}

/**
 * D2 ⑤——切出全部 ≥40 字符的连续 base64/hex 候选串（**不做 D3 豁免判定**）。
 *
 * ⛔ 判别性用途（判据 2）：这就是「把 D3 豁免逻辑去掉」之后的高熵规则。测试拿它证明
 *    三条真实语料**确实**会被无豁免的规则拦下，而生产扫描器放行了它们——即豁免真在起作用，
 *    而不是「那三条本来就命不中」。
 */
export function highEntropyRuns(text: string): HighEntropyRun[] {
  const runs: HighEntropyRun[] = [];
  const re = new RegExp(HIGH_ENTROPY_RUN_SOURCE, "g");
  for (const m of text.matchAll(re)) {
    runs.push({ value: m[0], index: m.index ?? 0 });
  }
  return runs;
}

/**
 * D1 ⭐——**纯函数扫描器**：对给定字段文本返回命中的 pattern 名列表（去重、稳定次序）。
 *
 * ⛔ 无 IO、⛔ 不用模型判断。⛔ 返回值只含 **pattern 名**，绝不含命中的内容本身（D5）。
 *
 * @returns 命中的 pattern 名；空数组 ⇒ 该字段干净。
 */
export function scanSecretPatterns(text: string): SecretPatternName[] {
  const value = text ?? "";
  const hit = new Set<SecretPatternName>();

  // ①②③④ 字面形态：⛔ 与 D3 豁免无关，任何位置命中即命中（判据 3）。
  for (const rule of LITERAL_RULES) {
    if (rule.pattern.test(value)) hit.add(rule.name);
  }

  // ⑤ 高熵串：逐个候选串判定，命中一个即可（D3 豁免逐串生效，⛔ 不整字段豁免）。
  for (const run of highEntropyRuns(value)) {
    if (!isExemptDigestShape(run.value, value.slice(0, run.index))) {
      hit.add("high-entropy-string");
      break;
    }
  }

  return SECRET_PATTERN_NAMES.filter((name) => hit.has(name));
}

/** D5——一个字段上的命中记录：字段名 + 命中的 pattern 名。⛔ 不含命中内容。 */
export interface SecretFieldHit {
  field: SecretScanField;
  patterns: SecretPatternName[];
}

/**
 * D4——扫一条 evidence 的 `quote` / `claim` / `anchor` 三字段。
 *
 * ⛔ 返回值只有字段名与 pattern 名：调用方据此**拒发**并记录，
 *    绝不把命中的串或 quote 全文再落一遍（D5，与既有 `EvidenceRejection` 同纪律）。
 */
export function scanSecretFields(
  fields: Partial<Record<SecretScanField, string>>,
): SecretFieldHit[] {
  const hits: SecretFieldHit[] = [];
  for (const field of SECRET_SCAN_FIELDS) {
    const patterns = scanSecretPatterns(fields[field] ?? "");
    if (patterns.length > 0) hits.push({ field, patterns });
  }
  return hits;
}
