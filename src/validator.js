const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

export const eventTypes = [
  "SCHEDULE_PUBLISHED",
  "SCHEDULE_REVISED",
  "SCHEDULE_CANCELLED",
  "PASS_ISSUED",
  "PASS_COMPANIONS_UPDATED",
  "PASS_QUALIFICATION_TRANSFERRED",
  "BENEFIT_RESERVED",
  "CAPACITY_RESTRICTED",
  "INVENTORY_SLOT_FROZEN",
  "MERCHANT_WITHDRAWN",
  "RESERVATION_DISPLACED",
  "BENEFIT_REDEEMED",
  "DIVERSION_OFFERED",
  "DIVERSION_SELECTED",
  "COMPENSATION_POSTED",
  "COMPENSATION_VOIDED",
  "MERCHANT_CLAIM_SETTLED",
  "LEDGER_RECONCILED",
  "REDEMPTION_EVIDENCE_RECORDED",
  "EVIDENCE_BATCH_SEALED",
  "ATTRIBUTION_REPORT_PUBLISHED",
];

export const aggregateTypes = [
  "event_schedule",
  "city_pass",
  "benefit_reservation",
  "benefit_inventory",
  "merchant_claim",
  "diversion_route",
  "settlement_ledger",
  "redemption_evidence",
  "attribution_report",
];

const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function validateEvent(record) {
  const errors = required
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);

  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("event_type" in record && !eventTypes.includes(record.event_type)) {
    errors.push(`未知事件类型：${record.event_type}`);
  }
  if ("aggregate_type" in record && !aggregateTypes.includes(record.aggregate_type)) {
    errors.push(`未知聚合类型：${record.aggregate_type}`);
  }
  if ("occurred_at" in record && !isoDateTime.test(record.occurred_at)) {
    errors.push("occurred_at 必须是带时区的 ISO 8601 日期时间");
  }
  if ("event_id" in record && (typeof record.event_id !== "string" || record.event_id.length === 0)) {
    errors.push("event_id 必须是非空字符串");
  }
  return errors;
}

/**
 * 跨系统消息按仓库事件信封去重：
 * 同一 event_id（或扫码等客户端动作的 idempotency_key）只接受一次，断网重传返回首次结果。
 * seen 由调用方持久化持有；返回 { accepted, duplicate }。
 */
export function dedupeEnvelope(seen, record) {
  const key = record.idempotency_key
    ? `idem:${record.idempotency_key}`
    : `event:${record.event_id}`;
  if (seen.has(key)) return { accepted: false, duplicate: true, key };
  seen.add(key);
  return { accepted: true, duplicate: false, key };
}
