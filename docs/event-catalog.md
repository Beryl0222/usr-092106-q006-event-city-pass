# 领域事件目录

跨系统消息统一使用 `contracts/domain.schema.json` 的事件信封，只追加、不原地改写；业务更正产生后继版本或更正事件。

## 信封约定

| 字段 | 说明 |
| --- | --- |
| `event_id` | 全局唯一事件标识。消费端按它去重，重复投递只生效一次。 |
| `event_type` / `aggregate_type` | 见下方枚举。 |
| `aggregate_id` / `version` | 同一聚合内 `version` 严格递增；更正不回写旧事件。 |
| `occurred_at` | 事实发生时间（非入帐时间）。离线扫码以设备记录时间为准。 |
| `schedule_version` | 事实发生时对应的赛历版本。改期/取消产生新版本，旧版本保留。 |
| `correlation_id` | 串联同一通行证或同一处置链路（如一次取消演练）。 |
| `causation_id` | 直接触发本事件的上游 `event_id`，形成责任与因果链。 |
| `source_system` | TICKETING / CITY_PASS / TRAFFIC_AUTHORITY / MERCHANT_POS / NOTIFICATION / LEDGER / ANALYTICS。 |
| `idempotency_key` | 业务动作幂等键（扫码流水号、退款单号等）。断网重传同键只生效一次。 |
| `payload` | 各事件业务字段，约定见下。 |

去重由 `src/validator.js` 的 `dedupeEnvelope(seen, record)` 实现：优先按 `idempotency_key`，否则按 `event_id`；`seen` 由消费端持久化。

## 赛历与通行证

| 事件 | 聚合 | payload 关键字段 |
| --- | --- | --- |
| `SCHEDULE_PUBLISHED` | event_schedule | `match_id`、`session_windows[]`、`capacity_version` |
| `SCHEDULE_REVISED` | event_schedule | `changes[]`、`reason`（改期/微调，新版本） |
| `SCHEDULE_CANCELLED` | event_schedule | `reason`、`authority_ref`、`affected_window`、`reschedule_policy` |
| `PASS_ISSUED` | city_pass | `ticket_no_hash`、`holder_pseudonym`、`companions[]`、`schedule_version` |
| `PASS_COMPANIONS_UPDATED` | city_pass | `companions_added[]`、`companions_removed[]`、`deadline_policy` |
| `PASS_QUALIFICATION_TRANSFERRED` | city_pass | `from_pseudonym`、`to_pseudonym`、`rule_basis`、`eligibility_check`、`accepted_at`、`prior_chain[]` |

转赠不得绕过赛事规则（时限、次数、受让人实名资格）。`prior_chain` 保留全部前手持有人；转让完成前的行为责任归前人，完成后的核销与退款领受归受让人，责任分界以 `accepted_at` 为准。

## 库存、预约与处置

| 事件 | 聚合 | payload 关键字段 |
| --- | --- | --- |
| `BENEFIT_RESERVED` | benefit_reservation | `pass_id`、`benefit_type`（THEME_ROUTE/HOTEL/SECOND_VENUE/EXHIBITION/F&B/CULTURE_VENUE）、`merchant_id`、`slot_start/end`、`face_amount`、`schedule_version` |
| `CAPACITY_RESTRICTED` | benefit_inventory | `authority`（公安/交通）、`area_id`、`effective_from/to`、`source_ref` |
| `INVENTORY_SLOT_FROZEN` | benefit_inventory | `frozen_slots[]`（库存、时段）、`reservation_ids_affected`；payload `status=FROZEN/THAWED` |
| `MERCHANT_WITHDRAWN` | benefit_reservation* | `merchant_id`、`effective_at`、`outstanding_reservation_ids[]`、`deposit_held` |
| `RESERVATION_DISPLACED` | benefit_reservation | `cause`（RESTRICTION/MERCHANT_WITHDRAWAL/SCHEDULE_CANCELLED）、`cause_event_id`、`options[]` |
| `BENEFIT_REDEEMED` | benefit_reservation | `scan_code`（=幂等键）、`device_time`、`online`、`merchant_id`、`amount` |
| `DIVERSION_OFFERED` | diversion_route | `pass_id`、`spectator_state=IN_TRANSIT`、`location_ref`、`options[]`、`valid_until` |
| `DIVERSION_SELECTED` | diversion_route | `option_id`、`selected_at`、`new_reservation_id` |

冻结只作用于与限制窗口、区域相交的库存时段；其他时段保持可约，禁止整表停摆。冻结不是取消，限制解除后以 `status=THAWED` 同聚合新版本恢复。

`DIVERSION_OFFERED.options[]` 中每个选项必须可执行：带实时余量 `slots_left`、`action_endpoint`、`valid_until`；不得只发通知不给选项。

## 补偿、结算与证据

| 事件 | 聚合 | payload 关键字段 |
| --- | --- | --- |
| `COMPENSATION_POSTED` | settlement_ledger | `reservation_id`、`usage_state=USED/UNUSED`、`kind=REFUND/ALTERNATIVE`、`amount`、`funding_source`、`alternative_detail`、`idempotency_key`（退款单号） |
| `COMPENSATION_VOIDED` | settlement_ledger | `voided_compensation_id`、`reason`、`replaced_by` |
| `MERCHANT_CLAIM_SETTLED` | merchant_claim | `merchant_id`、`evidence_ids[]`、`redeemed_units`、`gross_face`、`merchant_discount`、`net_payable`、`deposit_forfeited`、`funding_source` |
| `LEDGER_RECONCILED` | settlement_ledger | `refunds_total`、`alternatives_total`、`voided_total`、`merchant_settlement_total`、`unmatched_count=0`、`evidence_count` |
| `REDEMPTION_EVIDENCE_RECORDED` | redemption_evidence | 见 `docs/attribution-and-evidence.md`，全部字段匿名化 |
| `EVIDENCE_BATCH_SEALED` | redemption_evidence | `batch_id`、`evidence_ids[]`、`prev_hash`、`batch_hash` |
| `ATTRIBUTION_REPORT_PUBLISHED` | attribution_report | `evidence_batches[]`、`baseline_dataset_hash`、`formula`、`buckets[]`、`suppressed_buckets[]` |

资金来源枚举：`ORGANIZER_CANCELLATION_FUND`（主办方取消保证金）、`CITY_CULTURE_TOURISM_SUBSIDY`（城市文旅补贴）、`MERCHANT_SELF_BORNE`（商户违约自担）、`MERCHANT_DEPOSIT_OFFSET`（违约商户保证金抵扣给替补商户）、`PASS_PREPAID_FUNDS`（通行证预售池，正常已核销权益的对商户付款来源）、`ORIGINAL_PAYMENT_CHANNEL`（原路退款通道，仅描述通道、不是资金来源，资金仍须标注上述来源之一）。

一笔补偿只能记一个资金来源；混合责任拆成多笔。
