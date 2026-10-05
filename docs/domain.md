# 领域模型：赛事城市联动通行证

城市把周末职业联赛延展为三天文体商旅活动。球票持有人持一张**城市联动通行证**预约主题线路、酒店权益、场外第二现场和赛后展览。本文件定义后端管理的聚合、事件与不变量。业务流程的可执行样例见 [cancellation-drill.md](./cancellation-drill.md)。

## 聚合

| 聚合 | 说明 | 版本演进 |
| --- | --- | --- |
| `event_schedule` | 赛历。排赛、改期、取消、补赛各自产生新版本，旧版本保留 | `schedule_version` 只增 |
| `city_pass` | 实名通行证。持票人、同行人、资格转赠与责任链 | 每次变更 +1 |
| `benefit_reservation` | 单项权益预约：线路/酒店/第二现场/展览等，绑定商户、街区、时段 | 预约→冻结/替代→核销 |
| `restriction` | 公安/交管等外部限制，作用于明确时段 | 发布→解除 |
| `reroute_plan` | 在途观众改道方案：可执行选项、有效期、选择结果 | 下发→选定 |
| `compensation_ledger` | 补偿台账：每笔补偿有处置方式与资金来源 | POSTED→PAID |
| `merchant_claim` | 商户侧事项，如临时退出（零核销也必须留痕） | — |
| `settlement_batch` | 商户清算批次，每行回链真实核销证据与补偿 | — |
| `attribution_report` | 匿名核销证据、普通客流基线与归因复算结果 | 追加证据行 |

容量与冻结的最小粒度是 `slot_id`（日期+时段+资源），不是通行证，更不是赛事。

## 事件目录

- 赛历：`MATCH_SCHEDULED` / `MATCH_POSTPONED` / `MATCH_CANCELLED` / `MATCH_RESCHEDULED`
- 资格：`PASS_ISSUED`、`COMPANION_LINKED`、`ENTITLEMENT_TRANSFERRED`
- 预约与扰动：`BENEFIT_RESERVED`、`CAPACITY_RESTRICTED`、`RESTRICTION_LIFTED`、`MERCHANT_WITHDREW`
- 替代与改道：`BENEFIT_SUBSTITUTE_OFFERED` / `ACCEPTED`、`REROUTE_OPTION_OFFERED` / `SELECTED`
- 核销：`BENEFIT_REDEEMED`、`REDEMPTION_REPLAY_REJECTED`
- 补偿与清算：`COMPENSATION_POSTED` / `PAID`、`MERCHANT_SETTLEMENT_POSTED`
- 归因：`REDEMPTION_EVIDENCE_ANONYMIZED`、`DISTRICT_BASELINE_IMPORTED`、`ATTRIBUTION_RECONCILED`

## 核心不变量

1. **事件不可变。** 事件一经接收，`event_id`、`occurred_at`、`version` 不得原地改写；业务更正只能追加后继事件（如重放拒绝、补赛版本）。
2. **信封去重。** 跨系统消息以 `event_id` 全局去重；断网重传同一消息只生效一次。
3. **扫码幂等。** 同一 `reservation_id` + `client_request_id` 只允许一次 `BENEFIT_REDEEMED`。换了 `event_id` 的补扫命中同一幂等键也要拒绝，并以首次结果应答；拒绝可记 `REDEMPTION_REPLAY_REJECTED`。
4. **赛历版本只增。** v1 排赛 → v2 取消 → v3 补赛；通行证与预约引用其确认时的版本，取消不抹掉历史。
5. **限制只冻结受影响时段。** `CAPACITY_RESTRICTED` 必须带 `slot_id` 与受影响预约清单（`scope: TIME_WINDOW_ONLY`），解除按同一时段关闭，其他日期、其他权益照常可用。
6. **补偿不做整单回滚。** 票与组合权益分开处置：已使用权益、已使用但需延展的权益、未使用权益、在途改道分别建账；每笔标注处置方式（退款/替代/券/保险改签/非现金）与资金来源（票款托管/商户托管/城市补贴/取消险/主办方）。
7. **补偿先 POSTED 后 PAID。** 支付金额与资金来源必须与入账一致；同一 `compensation_id` 全生命周期只能支付一次；非现金权益入账即发放。
8. **商户只结算真实核销。** 清算正数行必须逐笔回链 `BENEFIT_REDEEMED` 证据且金额一致；未核销、临时退出的商户结算为 0。先发生替代、尚未核销的，不入清算。
9. **资格转赠守规则、留链路。** 受让人须为已核验同行人、在规则窗口内、原则上单次单步；`responsibility_chain` 记录每一任持有人，核销时扫码人必须匹配链路末端。
10. **归因只用匿名证据。** 证据行只允许加盐人群集合、哈希、人数与金额分档，禁止 `holder_ref`、`pass_id` 等身份字段；净新增消费 = 关联消费 − 同人群反事实基线，任何汇总数都由证据行与基线批次复算得出。

## 隐私

`holder_ref` 是不透明身份引用；明文姓名、证件号永不进入事件。归因环节进一步匿名化：只保留加盐集合匹配结果与证据哈希。各系统只读取完成职责所必需的字段。

## 本地校验

```bash
node --test
```

测试会复算演练流中的补偿台账、商户清算、时段冻结、转赠责任链、扫码幂等与归因数字。
