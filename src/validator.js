const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

export const EVENT_TYPES = [
  "MATCH_SCHEDULED",
  "MATCH_POSTPONED",
  "MATCH_CANCELLED",
  "MATCH_RESCHEDULED",
  "PASS_ISSUED",
  "COMPANION_LINKED",
  "ENTITLEMENT_TRANSFERRED",
  "BENEFIT_REDEEMED",
  "REDEMPTION_REPLAY_REJECTED",
  "BENEFIT_RESERVED",
  "CAPACITY_RESTRICTED",
  "RESTRICTION_LIFTED",
  "MERCHANT_WITHDREW",
  "BENEFIT_SUBSTITUTE_OFFERED",
  "BENEFIT_SUBSTITUTE_ACCEPTED",
  "REROUTE_OPTION_OFFERED",
  "REROUTE_SELECTED",
  "COMPENSATION_POSTED",
  "COMPENSATION_PAID",
  "MERCHANT_SETTLEMENT_POSTED",
  "REDEMPTION_EVIDENCE_ANONYMIZED",
  "DISTRICT_BASELINE_IMPORTED",
  "ATTRIBUTION_RECONCILED",
];

export const AGGREGATE_TYPES = [
  "event_schedule",
  "city_pass",
  "benefit_reservation",
  "restriction",
  "reroute_plan",
  "compensation_ledger",
  "merchant_claim",
  "settlement_batch",
  "attribution_report",
];

export function validateEvent(record) {
  const errors = required
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if (record.event_type && !EVENT_TYPES.includes(record.event_type)) {
    errors.push(`未知事件类型：${record.event_type}`);
  }
  if (record.aggregate_type && !AGGREGATE_TYPES.includes(record.aggregate_type)) {
    errors.push(`未知聚合类型：${record.aggregate_type}`);
  }
  if (record.occurred_at && Number.isNaN(Date.parse(record.occurred_at))) {
    errors.push("occurred_at 必须是合法时间");
  }
  if ("amount_cents" in record && (!Number.isInteger(record.amount_cents) || record.amount_cents < 0)) {
    errors.push("amount_cents 必须是非负整数（分）");
  }
  return errors;
}

/**
 * 跨系统消息沿用事件信封去重：同一 event_id 重复投递只保留首条。
 * 返回被接收的事件（按到达顺序），重复 event_id 被丢弃。
 */
export function dedupeEnvelope(events) {
  const seen = new Set();
  const accepted = [];
  const duplicates = [];
  for (const event of events) {
    if (seen.has(event.event_id)) {
      duplicates.push(event);
    } else {
      seen.add(event.event_id);
      accepted.push(event);
    }
  }
  return { accepted, duplicates };
}

/**
 * 一次扫码在断网重传时只核销一次：
 * 同一 reservation_id 下，相同 client_request_id 的 BENEFIT_REDEEMED 只生效一次，
 * 后续重传由系统记 REDEMPTION_REPLAY_REJECTED（或直接拒收），核销结果幂等返回首次状态。
 */
export function applyRedemptions(events) {
  const accepted = [];
  const rejected = [];
  const firstKey = new Map();
  for (const event of events) {
    if (event.event_type !== "BENEFIT_REDEEMED") continue;
    const key = `${event.reservation_id}|${event.client_request_id}`;
    if (firstKey.has(key)) {
      rejected.push({ event, first_event_id: firstKey.get(key) });
    } else {
      firstKey.set(key, event.event_id);
      accepted.push(event);
    }
  }
  return { accepted, rejected };
}
