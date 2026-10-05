# 关键演练：比赛取消

场景：周末职业联赛被城市做成三天文体商旅活动，球票持有人凭实名通行证预约主题线路、酒店权益、场外第二现场、赛后展览等组合权益。比赛日上午主办方确认**比赛取消**（叠加公安/交通限流与个别商户临时退出）。本演练定义系统如何处置，且**不允许把整张通行证简单回滚**。

完整事件流见 `data/cancellation-drill.json`，规则由 `tests/cancellation-drill.test.js` 钉住。

## 处置时间线

1. **赛历版本化**：票务系统发 `SCHEDULE_CANCELLED`（新 `schedule_version`，旧版本保留不改写），附 `authority_ref` 与 `reschedule_policy`。
2. **只冻结受影响时段**：依据已发布的 `CAPACITY_RESTRICTED`，城市通行证对与限制窗口/区域相交的库存时段发 `INVENTORY_SLOT_FROZEN`（`reservation_ids_affected` 精确到预约）。不相交的时段（如第二天展览、非管控区商户）保持可约可用。
3. **商户临时退出**：退出商户发 `MERCHANT_WITHDRAWN`，其未核销预约转入处置；其保证金被持有，用于抵扣替补成本。
4. **在途观众立即改道**：对 `spectator_state=IN_TRANSIT` 的通行证**先发** `DIVERSION_OFFERED`（推送 + 短信双通道），每个选项带实时余量与操作入口，观众 `DIVERSION_SELECTED` 后生成替代预约。改道是"可执行的选择"，不是一纸通知。
5. **逐笔权益处置**：对每条预约发 `RESERVATION_DISPLACED`，按下方补偿矩阵过账 `COMPENSATION_POSTED`。
6. **商户只结算真实核销**：`MERCHANT_CLAIM_SETTLED` 只统计已 `BENEFIT_REDEEMED` 且有匿名证据的核销；退出商户未履约部分不计费，违约保证金按规则抵扣。
7. **清算对账**：`LEDGER_RECONCILED` 要求补偿笔笔有预约、结算笔笔有证据，`unmatched_count = 0`。
8. **归因报告**：封档证据批次，发布 `ATTRIBUTION_REPORT_PUBLISHED`，区分赛事新增消费与普通客流（见 `docs/attribution-and-evidence.md`）。

## 补偿矩阵（已使用 / 未使用 × 替代方案 / 资金来源）

处置粒度是**单条预约**，不是通行证。同一通行证上不同权益可走不同路径。

| 预约状态 | 情形 | 补偿 `kind` | 处理 | 资金来源 |
| --- | --- | --- | --- | --- |
| **UNUSED 未使用** | 因取消直接落空 | `REFUND` | 按面值原路退回（`ORIGINAL_PAYMENT_CHANNEL` 仅描述通道，资金来源仍须标注） | 取消主因方：主办方取消保证金 `ORGANIZER_CANCELLATION_FUND` |
| **UNUSED 未使用** | 观众选择替代权益（改道/换日） | `ALTERNATIVE` | 不退现金；生成新预约，差价补贴记一笔 | 城市文旅补贴 `CITY_CULTURE_TOURISM_SUBSIDY`；限流导致的增量成本由管控责任口径承担 |
| **UNUSED 未使用** | 商户临时退出且无替代 | `REFUND` | 面值退还观众 | `MERCHANT_SELF_BORNE`（商户违约自担，从保证金划付，不占用取消基金） |
| **UNUSED 未使用** | 退出商户有替补商户承接 | `ALTERNATIVE` | 原预约转到替补商户 | 替补与原面值差额由 `MERCHANT_DEPOSIT_OFFSET` 承担（违约商户保证金抵扣） |
| **USED 已使用** | 取消前已核销（赛前三日活动、已入住酒店首晚、已观赛第二现场等） | 不退现金 | 不产生 `REFUND`；如主办方给出善意安排（如展览延期券），记 `amount=0` 的 `ALTERNATIVE` | 善意安排由文旅补贴或取消基金承担，须逐笔标注 |
| **USED 已使用** | 核销发生在冻结/取消生效之后（争议） | 挂起 | 进入对账人工裁定：证据时间晚于生效时间的，先不结算不补偿，以 `LEDGER_RECONCILED` 挂账列出 | 裁定后再定来源；禁止默认赔付 |

规则：

- **一笔补偿只能有一个资金来源**；多方责任（如取消叠限流）拆成多笔 `COMPENSATION_POSTED`，每笔金额加总等于应付。
- 补偿以 `idempotency_key`（退款单号）幂等；重复过账用 `COMPENSATION_VOIDED` 冲正，不删除原事件。
- 已使用权益不退现金是硬约束；任何 `USED + REFUND(amount>0)` 组合都应被拒绝。
- 不冻结未受影响权益、不滚动回滚通行证；通行证状态随赛历新版本迁移，历史预约与核销全部保留。

## 在途改道的"可执行"标准

`DIVERSION_OFFERED` 必须满足：

1. 触达：位置/行程标记为 `IN_TRANSIT` 的观众在取消确认后规定时限内收到（事件流以分钟级 `occurred_at` 体现）；
2. 选项不空话：每个 `option` 含 `option_id`、`benefit_type`、`venue_id`、`slots_left > 0` 的实时余量、`action_endpoint`、`valid_until`；
3. 余量真实：选项库存由第 2 步冻结后的可售库存计算，已被选走的名额实时递减；
4. 选择即落单：`DIVERSION_SELECTED` 产生新的 `BENEFIT_RESERVED`，`causation_id` 指回改道事件；
5. 超时兜底：`valid_until` 内未选择的，按未使用权益默认 `REFUND`，但观众事后仍可在规则期内改选替代方案（再发补偿更正，不回滚）。

## 断网重传：一次扫码只核销一次

- 核销事件 `BENEFIT_REDEEMED` 以扫码流水号 `scan_code` 作为 `idempotency_key`。
- 闸机/POS 离线时本地排队，恢复后重传；消费端 `dedupeEnvelope` 命中同键时返回**首次处理结果**，库存只扣一次、商户计一次、证据只存一条。
- 离线期间以 `device_time` 作为 `occurred_at`，并在 payload 标 `online:false`；证据时间用于争议裁定（见上表）。

## 资格转赠的责任链

- `PASS_QUALIFICATION_TRANSFERRED` 必须带 `rule_basis`（赛事转赠规则条款）与 `eligibility_check`（受让人实名/资格校验通过记录）。
- `prior_chain[]` 累积全部前手持有人；每次转让形成 `causation_id` 链。
- 以 `accepted_at` 为责任分界：此前预约/核销的补偿归属前人，此后归受让人；已发生的核销不因转让而改变证据与结算。

## 限流冻结的最小作用域

`CAPACITY_RESTRICTED` 由公安或交通部门发布，含区域 `area_id` 与 `effective_from/to`、官方 `source_ref`。冻结条件是**时段相交且区域相交**：

- 管控窗口外的主题线路、酒店夜次、赛后展览（比赛后一日）正常可约；
- 解除后以同一库存聚合的新版本 `status=THAWED` 恢复，不补发新库存编号；
- 商户退出与限流同时命中时，补偿按主因拆笔，禁止重复赔付。
