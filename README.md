# loop-engine-deep-research-plugin

deep-research 确定性调度引擎插件。loop-engine plugin，负责 clue 板面读写、CAS 认领、调度 tick、覆盖度计算、终止判定、生成阶段编排。

## 协议

- `research.clue.v2` — 线索 (root entity, 有版本链)
- `research.evidence.v2` — 证据 (leaf, 不可变)
- `research.doc.v2` — 长文本 (leaf, 不可变)

## 依赖

- agent-bus (HTTP API): 板面读写、协议校验
- agent-runtime / subagent-mcp: worker 派发
- loop-engine: 调度基础设施 (superviseDrain, lock, node)

## 开发

开发一律走 dev dispatch。spec 在 wf-dc0c15。

