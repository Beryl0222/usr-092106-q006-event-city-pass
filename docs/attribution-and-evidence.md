# 匿名化核销证据与消费归因

目标：用**匿名化核销证据**区分"赛事新增消费"与"普通客流"，让每一个汇总数都能从原始记录重算并核对。

## 1. 证据生成（`REDEMPTION_EVIDENCE_RECORDED`）

每次真实核销（含离线扫码恢复后补记）生成一条证据，写入 analytics 侧。禁止明文个人信息与主键回溯：

| 字段 | 内容 | 匿名化做法 |
| --- | --- | --- |
| `evidence_id` | 证据编号 | 随机编号，不用 pass_id / 订单号 |
| `holder_key` | 持证人归属判定键 | pass_id + 批次盐做 HMAC，盐按批次轮换 |
| `ticket_no_hash` | 球票归属 | SHA-256 双盐哈希，仅用于匹配基线，不可逆推球票号 |
| `merchant_id` / `venue_id` / `area_id` | 商户、场馆、街区 | 可保留（机构信息非个人信息） |
| `benefit_type` / `amount` / `face_amount` | 权益类型与金额 | 可保留，是归因核心字段 |
| `redeemed_slot_start` | 核销时段 | 可保留；用于与限制窗口判定 |
| `device_time` | 扫码设备时间 | 可保留（争议裁定用） |
| `online` | 是否在线 | 可保留 |
| `recorded_at` | 证据记档时间 | 可保留 |
| （无） | 姓名、手机号、证件号、订单原文 | **一律不得出现在证据中**；如需校验由票务侧按职责最小化读取 |
| `prev_hash` / `evidence_hash` | 哈希链 | 见下 |

每条证据的 `evidence_hash = sha256(prev_hash + canonical(除哈希外字段))`，同批次内逐条链接，使证据事后不可悄悄改动。

## 2. 批次封档（`EVIDENCE_BATCH_SEALED`）

一个活动窗口（如取消演练处置窗口）结束后封档：

- `batch_hash = sha256(sorted(evidence_hash))`；
- `prev_hash` 指向上一批次的 `batch_hash`，形成跨批次链；
- 任何人都能以同样输入重算哈希，核对批次内证据未被增删改。

## 3. 归因方法（区分新增消费 vs 普通客流）

`ATTRIBUTION_REPORT_PUBLISHED` 的 `formula` 写明计算口径；本仓库用**前后/有无对照**：

1. **处理组**：本批次中 `holder_key` 有赛事资格匹配（`ticket_no_hash` 在赛历版本内有效）的核销，按商户/街区/权益类型分桶；
- **新增消费判定**：处理组在活动期内的核销金额/笔数，减去普通客流**基线**（见下），即为"赛事新增"；
- 控制组/基线数据同样哈希匹配后统计，不含任何可识别信息。
2. **基线（普通客流）**：取商户同时段上 n 个非赛事周末（如近 8 周、近 4 个同类非赛事周末）的历史客流与客单，以及当日无通行证普通到店客流（POS 端按比例上报，同样不含身份字段）；
- 基线数据集以 `baseline_dataset_hash` 钉版，报告发布后不换底；
- small-cell 处理：单商户单元格少于阈值（默认 5 笔）的桶并入相邻街区桶，合并后仍不足则抑制（`suppressed_buckets[]`），不输出可能反推个人或商户敏感经营数据的数字。
3. **补偿/结算闭环校验**：商户结算金额必须等于该批次对应该商户真实核销的面值之和（再按协议扣让扣保证金）；报告里的新增消费总和必须能由证据逐笔重算得到。

## 4. 每个汇总数都可复核

报告 `buckets[]` 每一项带重算线索：

- `dimensions`（merchant_id/area_id/benefit_type）、`control_base`、`redemption_count`、`redemption_amount`、`incremental_amount`、`incremental_pct`；
- 审核者路径：`ATTRIBUTION_REPORT_PUBLISHED.evidence_batches` → `EVIDENCE_BATCH_SEALED` → 逐条 `REDEMPTION_EVIDENCE_RECORDED`（哈希链校验通过）→ 按 `formula` 自行汇总，必与报告一致；
- 同一批证据同时支撑两件事：① 商户只对真实核销申请结算；② 新增消费归因报告。证据与结算、报告双向对得上（`LEDGER_RECONCILED.unmatched_count = 0`）。
