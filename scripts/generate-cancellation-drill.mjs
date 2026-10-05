// 生成 data/cancellation-drill.json：取消比赛端到端演练事件流。
// 证据哈希链、批次哈希、汇总数由本脚本计算，保证样例天然自洽、可被测试重算。
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { batchHash, evidenceHash, hmacHex, sha256 } from "../src/hashing.js";

const TZ = "+08:00";
const ts = (s) => `${s}${TZ}`;

const events = [];
const seq = {};
const aggVersion = new Map();

function nextId(prefix) {
  seq[prefix] = (seq[prefix] ?? 0) + 1;
  return `${prefix}-${String(seq[prefix]).padStart(4, "0")}`;
}

function emit({
  eventId,
  type,
  aggregateType,
  aggregateId,
  at,
  summary,
  source,
  payload = {},
  scheduleVersion,
  correlation = "CORR-G1-WEEKEND",
  causation,
  idempotencyKey,
  version,
}) {
  const key = `${aggregateType}:${aggregateId}`;
  const ver = version ?? ((aggVersion.get(key) ?? 0) + 1);
  aggVersion.set(key, ver);
  events.push({
    event_id: eventId ?? `EVT-${String(events.length + 1).padStart(4, "0")}`,
    event_type: type,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: ts(at),
    version: ver,
    summary,
    ...(scheduleVersion ? { schedule_version: scheduleVersion } : {}),
    correlation_id: correlation,
    ...(causation ? { causation_id: causation } : {}),
    source_system: source,
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    payload,
  });
}

const MATCH = "MATCH-2026-G1";
const SALT = "drill-batch-salt-B1";
const ticketHash = (ticketNo) => sha256(`drill:${ticketNo}`);
const holderKey = (passId) => hmacHex(SALT, passId);

// ---------- 1. 赛历 v1 ----------
emit({
  type: "SCHEDULE_PUBLISHED",
  aggregateType: "event_schedule",
  aggregateId: MATCH,
  at: "2026-09-20T15:00:00",
  source: "TICKETING",
  summary: "发布 G1 联赛周末三天赛历（10/16–10/18）",
  scheduleVersion: 1,
  version: 1,
  payload: {
    match_id: MATCH,
    session_windows: [
      { date: "2026-10-16", programs: ["城市暖场", "文体商旅活动"] },
      { date: "2026-10-17", programs: ["主题线路", "比赛日 19:35 开赛", "第二现场"] },
      { date: "2026-10-18", programs: ["赛后展览", "城市文化日"] },
    ],
    capacity_version: "CAP-V1",
  },
});

// ---------- 2. 通行证发放（P-1001 经历一次合规转赠） ----------
emit({
  type: "PASS_ISSUED",
  aggregateType: "city_pass",
  aggregateId: "P-1001",
  at: "2026-09-22T09:10:00",
  source: "CITY_PASS",
  scheduleVersion: 1,
  summary: "向原始持证人发放实名通行证 P-1001",
  payload: {
    ticket_no_hash: ticketHash("T-A0-0001"),
    holder_pseudonym: "H-A0",
    companions: [],
  },
});

emit({
  type: "PASS_QUALIFICATION_TRANSFERRED",
  aggregateType: "city_pass",
  aggregateId: "P-1001",
  at: "2026-10-05T10:30:00",
  source: "CITY_PASS",
  scheduleVersion: 1,
  summary: "P-1001 按赛事转赠规则完成实名资格转赠 H-A0 → H-A1",
  payload: {
    from_pseudonym: "H-A0",
    to_pseudonym: "H-A1",
    rule_basis: "《联赛门票转赠规则》第 8 条：开赛前 72 小时、限一次、受让人实名",
    eligibility_check: { realname: "PASSED", blacklist: "PASSED", transfer_quota_used: 1, checked_at: ts("2026-10-05T10:29:50") },
    accepted_at: ts("2026-10-05T10:30:00"),
    prior_chain: ["H-A0"],
    ticket_no_hash: ticketHash("T-A0-0001"),
  },
});

emit({
  type: "PASS_COMPANIONS_UPDATED",
  aggregateType: "city_pass",
  aggregateId: "P-1001",
  at: "2026-10-10T20:15:00",
  source: "CITY_PASS",
  scheduleVersion: 1,
  summary: "P-1001 添加一名同行人",
  payload: { companions_added: ["H-A1-G1"], companions_removed: [], deadline_policy: "开赛前 24 小时截止" },
});

emit({
  type: "PASS_ISSUED",
  aggregateType: "city_pass",
  aggregateId: "P-1002",
  at: "2026-09-25T14:00:00",
  source: "CITY_PASS",
  scheduleVersion: 1,
  summary: "向在途观众 H-B1 发放实名通行证 P-1002",
  payload: { ticket_no_hash: ticketHash("T-B1-0002"), holder_pseudonym: "H-B1", companions: [] },
});

emit({
  type: "PASS_ISSUED",
  aggregateType: "city_pass",
  aggregateId: "P-1003",
  at: "2026-09-26T11:00:00",
  source: "CITY_PASS",
  scheduleVersion: 1,
  summary: "发放实名通行证 P-1003（用于争议核销样例）",
  payload: { ticket_no_hash: ticketHash("T-C1-0003"), holder_pseudonym: "H-C1", companions: [] },
});

// ---------- 3. 组合权益预约 ----------
const reserve = (id, passId, p) =>
  emit({
    type: "BENEFIT_RESERVED",
    aggregateType: "benefit_reservation",
    aggregateId: id,
    at: "2026-10-11T09:00:00",
    source: "CITY_PASS",
    scheduleVersion: 1,
    summary: `预约 ${p.benefit_type}（${id}）`,
    payload: { pass_id: passId, status: "RESERVED", ...p },
  });

reserve("R-2001", "P-1001", {
  benefit_type: "THEME_ROUTE", merchant_id: "M-301", venue_id: "V-RIVERSIDE", area_id: "A-STADIUM-CORE",
  slot_start: "2026-10-17T13:30:00", slot_end: "2026-10-17T16:30:00", face_amount: 120,
});
reserve("R-2002", "P-1001", {
  benefit_type: "HOTEL", merchant_id: "M-302", venue_id: "V-HOTEL-RIVERSIDE", area_id: "A-WATERFRONT",
  slot_start: "2026-10-16T20:00:00", slot_end: "2026-10-17T12:00:00", face_amount: 600,
});
reserve("R-2003", "P-1001", {
  benefit_type: "HOTEL", merchant_id: "M-302", venue_id: "V-HOTEL-RIVERSIDE", area_id: "A-WATERFRONT",
  slot_start: "2026-10-17T20:00:00", slot_end: "2026-10-18T12:00:00", face_amount: 600,
});
reserve("R-2004", "P-1001", {
  benefit_type: "SECOND_VENUE", merchant_id: "M-303", venue_id: "V-BAR-CENTRAL", area_id: "A-STADIUM-CORE",
  slot_start: "2026-10-17T19:00:00", slot_end: "2026-10-17T22:00:00", face_amount: 88,
});
reserve("R-2005", "P-1001", {
  benefit_type: "F&B", merchant_id: "M-304", venue_id: "V-BISTRO-304", area_id: "A-STADIUM-CORE",
  slot_start: "2026-10-17T12:30:00", slot_end: "2026-10-17T13:30:00", face_amount: 60,
});
reserve("R-2006", "P-1001", {
  benefit_type: "EXHIBITION", merchant_id: "M-306", venue_id: "V-EXPO-HALL", area_id: "A-NEWTOWN",
  slot_start: "2026-10-18T10:00:00", slot_end: "2026-10-18T12:00:00", face_amount: 50,
});
reserve("R-2007", "P-1001", {
  benefit_type: "CULTURE_VENUE", merchant_id: "M-307", venue_id: "V-MUSEUM", area_id: "A-OLDSTREET",
  slot_start: "2026-10-16T14:00:00", slot_end: "2026-10-16T16:00:00", face_amount: 30,
});
reserve("R-2008", "P-1002", {
  benefit_type: "SECOND_VENUE", merchant_id: "M-309", venue_id: "V-FANZONE-CORE", area_id: "A-STADIUM-CORE",
  slot_start: "2026-10-17T19:00:00", slot_end: "2026-10-17T22:00:00", face_amount: 88,
});
reserve("R-2010", "P-1002", {
  benefit_type: "F&B", merchant_id: "M-304", venue_id: "V-BISTRO-304", area_id: "A-STADIUM-CORE",
  slot_start: "2026-10-17T11:30:00", slot_end: "2026-10-17T12:30:00", face_amount: 60,
});
reserve("R-2011", "P-1003", {
  benefit_type: "SECOND_VENUE", merchant_id: "M-303", venue_id: "V-BAR-CENTRAL", area_id: "A-STADIUM-CORE",
  slot_start: "2026-10-17T19:00:00", slot_end: "2026-10-17T22:00:00", face_amount: 88,
});

// ---------- 4. 活动首日真实核销（取消前，已使用权益） ----------
const redeem = (id, reservationId, at, amount, scan, { online = true, recordedAt, merchantId } = {}) =>
  emit({
    type: "BENEFIT_REDEEMED",
    aggregateType: "benefit_reservation",
    aggregateId: reservationId,
    at,
    source: "MERCHANT_POS",
    summary: `商户扫码核销 ${reservationId}（流水 ${scan}）`,
    scheduleVersion: 1,
    idempotencyKey: scan,
    payload: {
      scan_code: scan, device_time: ts(at), online, amount,
      recorded_at: ts(recordedAt ?? at),
      merchant_id: merchantId,
    },
  });

redeem("E-1-REDEEM", "R-2007", "2026-10-16T14:05:00", 30, "SCN-6001", { merchantId: "M-307" });
redeem("E-2-REDEEM", "R-2002", "2026-10-16T16:20:00", 600, "SCN-5001", { merchantId: "M-302" });

// ---------- 5. 比赛日上午：限流 → 只冻结相交时段 → 商户退出 → 取消 ----------
emit({
  type: "CAPACITY_RESTRICTED",
  aggregateType: "benefit_inventory",
  aggregateId: "AREA-A-STADIUM-CORE",
  at: "2026-10-17T10:00:00",
  source: "TRAFFIC_AUTHORITY",
  summary: "公安交管发布核心区限流：10/17 12:00–23:00",
  scheduleVersion: 1,
  payload: {
    authority: "市公安局交通管理局",
    area_id: "A-STADIUM-CORE",
    effective_from: "2026-10-17T12:00:00",
    effective_to: "2026-10-17T23:00:00",
    source_ref: "GAJT-20261017-07",
  },
});

emit({
  type: "INVENTORY_SLOT_FROZEN",
  aggregateType: "benefit_inventory",
  aggregateId: "INV-M301-1017-AFT",
  at: "2026-10-17T10:15:00",
  source: "CITY_PASS",
  summary: "冻结 M-301 主题线路 10/17 下午时段（与限流窗口、核心区相交）",
  scheduleVersion: 1,
  payload: {
    status: "FROZEN", area_id: "A-STADIUM-CORE",
    frozen_slots: [{ slot_start: "2026-10-17T13:30:00", slot_end: "2026-10-17T16:30:00", inventory: 12 }],
    reservation_ids_affected: ["R-2001"],
  },
});

emit({
  type: "INVENTORY_SLOT_FROZEN",
  aggregateType: "benefit_inventory",
  aggregateId: "INV-M309-1017-EVE",
  at: "2026-10-17T10:16:00",
  source: "CITY_PASS",
  summary: "冻结 M-309 核心区第二现场晚间时段",
  scheduleVersion: 1,
  payload: {
    status: "FROZEN", area_id: "A-STADIUM-CORE",
    frozen_slots: [{ slot_start: "2026-10-17T19:00:00", slot_end: "2026-10-17T22:00:00", inventory: 200 }],
    reservation_ids_affected: ["R-2008"],
  },
});

emit({
  type: "MERCHANT_WITHDRAWN",
  aggregateType: "merchant_claim",
  aggregateId: "MC-M-303",
  at: "2026-10-17T11:05:00",
  source: "CITY_PASS",
  summary: "M-303 第二现场酒吧临时退出，15:00 起停止承接",
  scheduleVersion: 1,
  payload: {
    merchant_id: "M-303", effective_at: "2026-10-17T15:00:00",
    outstanding_reservation_ids: ["R-2004", "R-2011"], deposit_held: 200,
  },
});

emit({
  type: "MERCHANT_WITHDRAWN",
  aggregateType: "merchant_claim",
  aggregateId: "MC-M-304",
  at: "2026-10-17T11:10:00",
  source: "CITY_PASS",
  summary: "M-304 小馆临时退出，12:00 起停止承接",
  scheduleVersion: 1,
  payload: {
    merchant_id: "M-304", effective_at: "2026-10-17T12:00:00",
    outstanding_reservation_ids: ["R-2005"], deposit_held: 200,
  },
});

emit({
  type: "SCHEDULE_CANCELLED",
  aggregateType: "event_schedule",
  aggregateId: MATCH,
  at: "2026-10-17T11:20:00",
  source: "TICKETING",
  summary: "G1 比赛因极端天气取消，赛历升级到 v2（旧版本保留）",
  scheduleVersion: 2,
  version: 2,
  payload: {
    reason: "气象部门发布暴雨橙色预警，赛事经主办方与公安会商取消",
    authority_refs: ["QX-ORANGE-20261017", "GAJT-20261017-07"],
    affected_window: { slot_start: "2026-10-17T12:00:00", slot_end: "2026-10-18T02:00:00" },
    reschedule_policy: "未使用权益可原路退或改约替代；已使用权益不退现金",
  },
});

// ---------- 6. 在途观众：立即给出可执行改道 ----------
emit({
  type: "DIVERSION_OFFERED",
  aggregateType: "diversion_route",
  aggregateId: "DVR-P-1002-1017",
  at: "2026-10-17T11:24:00",
  source: "NOTIFICATION",
  scheduleVersion: 2,
  summary: "向在途观众 H-B1 推送第二现场改道选项（App 推送 + 短信）",
  payload: {
    pass_id: "P-1002", spectator_state: "IN_TRANSIT", location_ref: "地铁 2 号线 体育中心站",
    channels: ["APP_PUSH", "SMS"],
    options: [
      { option_id: "OPT-WESTGATE", benefit_type: "SECOND_VENUE", venue_id: "V-FANZONE-WEST", area_id: "A-WESTGATE", merchant_id: "M-308", slots_left: 40, action_endpoint: "citypass://diversion/OPT-WESTGATE", valid_until: "2026-10-17T12:00:00" },
      { option_id: "OPT-EXPO", benefit_type: "EXHIBITION", venue_id: "V-EXPO-HALL", area_id: "A-NEWTOWN", merchant_id: "M-306", slots_left: 120, action_endpoint: "citypass://diversion/OPT-EXPO", valid_until: "2026-10-17T12:00:00" },
    ],
  },
});

emit({
  type: "DIVERSION_SELECTED",
  aggregateType: "diversion_route",
  aggregateId: "DVR-P-1002-1017",
  at: "2026-10-17T11:31:00",
  source: "CITY_PASS",
  scheduleVersion: 2,
  summary: "H-B1 选定城西第二现场改道",
  payload: { pass_id: "P-1002", option_id: "OPT-WESTGATE", selected_at: "2026-10-17T11:31:00", new_reservation_id: "R-2052" },
});

emit({
  type: "BENEFIT_RESERVED",
  aggregateType: "benefit_reservation",
  aggregateId: "R-2052",
  at: "2026-10-17T11:31:30",
  source: "CITY_PASS",
  scheduleVersion: 2,
  summary: "改道落地：M-308 城西第二现场新预约",
  causation: events.find((e) => e.event_type === "DIVERSION_SELECTED").event_id,
  payload: {
    pass_id: "P-1002", status: "RESERVED", benefit_type: "SECOND_VENUE", merchant_id: "M-308",
    venue_id: "V-FANZONE-WEST", area_id: "A-WESTGATE",
    slot_start: "2026-10-17T19:00:00", slot_end: "2026-10-17T22:00:00", face_amount: 88,
    replaces_reservation_id: "R-2008", selected_option_id: "OPT-WESTGATE",
  },
});

// ---------- 7. 逐笔权益处置与补偿 ----------
const LEDGER = "LEDGER-G1-1018";

const compensate = (reservationId, at, usageState, kind, amount, fundingSource, extra = {}, scan) =>
  emit({
    type: "COMPENSATION_POSTED",
    aggregateType: "settlement_ledger",
    aggregateId: LEDGER,
    at,
    source: "LEDGER",
    scheduleVersion: 2,
    summary: extra.summary ?? `补偿过账 ${reservationId} ${kind} ${amount} 元（${fundingSource}）`,
    idempotencyKey: scan,
    payload: {
      reservation_id: reservationId, usage_state: usageState, kind, amount,
      funding_source: fundingSource, ...(extra.payload ?? {}),
    },
  });

// R-2008 在途改道：未使用 → 替代，不退现金，无差价
compensate("R-2008", "2026-10-17T11:32:00", "UNUSED", "ALTERNATIVE", 0, "CITY_CULTURE_TOURISM_SUBSIDY",
  { summary: "R-2008 改道替代至 M-308，不退现金", payload: { alternative_detail: { new_reservation_id: "R-2052", pass_id: "P-1002" } } }, "RF-ALT-2008");

// R-2001 限流：未使用 → 改约次日，差价补贴 30
emit({
  type: "RESERVATION_DISPLACED",
  aggregateType: "benefit_reservation",
  aggregateId: "R-2001",
  at: "2026-10-17T11:40:00",
  source: "CITY_PASS",
  scheduleVersion: 2,
  summary: "R-2001 因限流与赛历取消被迫处置，提供改约/退款选项",
  payload: {
    cause: "RESTRICTION", cause_event_id: "GAJT-20261017-07",
    options: [
      { option_id: "REROUTE-1018", benefit_type: "THEME_ROUTE", venue_id: "V-RIVERSIDE", slot_start: "2026-10-18T13:30:00", slots_left: 8, face_amount: 150, action_endpoint: "citypass://displace/R-2001/REROUTE-1018" },
      { option_id: "REFUND-FACE", kind: "REFUND", amount: 120, action_endpoint: "citypass://displace/R-2001/REFUND-FACE" },
    ],
  },
});

emit({
  type: "BENEFIT_RESERVED",
  aggregateType: "benefit_reservation",
  aggregateId: "R-2050",
  at: "2026-10-17T11:46:00",
  source: "CITY_PASS",
  scheduleVersion: 2,
  summary: "R-2001 改约 10/18 主题线路（面值 150，差价 30 由文旅补贴）",
  payload: {
    pass_id: "P-1001", status: "RESERVED", benefit_type: "THEME_ROUTE", merchant_id: "M-301",
    venue_id: "V-RIVERSIDE", area_id: "A-STADIUM-CORE",
    slot_start: "2026-10-18T13:30:00", slot_end: "2026-10-18T16:30:00", face_amount: 150,
    replaces_reservation_id: "R-2001", selected_option_id: "REROUTE-1018",
  },
});

compensate("R-2001", "2026-10-17T11:47:00", "UNUSED", "ALTERNATIVE", 30, "CITY_CULTURE_TOURISM_SUBSIDY",
  { summary: "R-2001 改约差价补贴 30 元（文旅补贴）", payload: { alternative_detail: { new_reservation_id: "R-2050", price_difference: 30 } } }, "RF-ALT-2001");

// R-2003 酒店次晚：未使用 → 主办方取消保证金原路退 600
emit({
  type: "RESERVATION_DISPLACED",
  aggregateType: "benefit_reservation",
  aggregateId: "R-2003",
  at: "2026-10-17T11:50:00",
  source: "CITY_PASS",
  scheduleVersion: 2,
  summary: "R-2003 酒店次晚因取消落空",
  payload: { cause: "SCHEDULE_CANCELLED", options: [{ option_id: "REFUND-FACE", kind: "REFUND", amount: 600 }] },
});

compensate("R-2003", "2026-10-17T11:52:00", "UNUSED", "REFUND", 600, "ORGANIZER_CANCELLATION_FUND",
  { summary: "R-2003 酒店次晚原路退 600 元（主办方取消保证金）", payload: { refund_channel: "ORIGINAL_PAYMENT_CHANNEL" } }, "RF-2026-0003");

// R-2004 M-303 退出、无替代：未使用 → 商户违约自担（保证金划付）
emit({
  type: "RESERVATION_DISPLACED",
  aggregateType: "benefit_reservation",
  aggregateId: "R-2004",
  at: "2026-10-17T11:55:00",
  source: "CITY_PASS",
  scheduleVersion: 2,
  summary: "R-2004 因商户 M-303 退出落空，周边同时段无替代席位",
  payload: {
    cause: "MERCHANT_WITHDRAWAL", cause_event_id: events.find((e) => e.aggregate_id === "MC-M-303" && e.event_type === "MERCHANT_WITHDRAWN").event_id,
    options: [{ option_id: "REFUND-DEPOSIT", kind: "REFUND", amount: 88 }],
  },
});

compensate("R-2004", "2026-10-17T11:57:00", "UNUSED", "REFUND", 88, "MERCHANT_SELF_BORNE",
  { summary: "R-2004 退款 88 元由违约商户 M-303 自担（保证金划付）", payload: { liable_merchant_id: "M-303", refund_channel: "ORIGINAL_PAYMENT_CHANNEL" } }, "RF-2026-0004");

// R-2005 M-304 退出：未使用 → 替补商户 M-305 承接，差价 10 由保证金抵扣
emit({
  type: "RESERVATION_DISPLACED",
  aggregateType: "benefit_reservation",
  aggregateId: "R-2005",
  at: "2026-10-17T11:58:00",
  source: "CITY_PASS",
  scheduleVersion: 2,
  summary: "R-2005 因商户 M-304 退出，调度替补商户 M-305",
  payload: {
    cause: "MERCHANT_WITHDRAWAL",
    options: [{ option_id: "REPLACE-M305", benefit_type: "F&B", venue_id: "V-BISTRO-305", merchant_id: "M-305", slot_start: "2026-10-17T12:30:00", slots_left: 16, face_amount: 70 }],
  },
});

emit({
  type: "BENEFIT_RESERVED",
  aggregateType: "benefit_reservation",
  aggregateId: "R-2051",
  at: "2026-10-17T12:01:00",
  source: "CITY_PASS",
  scheduleVersion: 2,
  summary: "R-2005 转替补商户 M-305（面值 70）",
  payload: {
    pass_id: "P-1001", status: "RESERVED", benefit_type: "F&B", merchant_id: "M-305",
    venue_id: "V-BISTRO-305", area_id: "A-STADIUM-CORE",
    slot_start: "2026-10-17T12:30:00", slot_end: "2026-10-17T13:30:00", face_amount: 70,
    replaces_reservation_id: "R-2005", selected_option_id: "REPLACE-M305",
  },
});

compensate("R-2005", "2026-10-17T12:02:00", "UNUSED", "ALTERNATIVE", 10, "MERCHANT_DEPOSIT_OFFSET",
  { summary: "替补差额 10 元由 M-304 保证金抵扣给 M-305", payload: { liable_merchant_id: "M-304", alternative_detail: { new_reservation_id: "R-2051", price_difference: 10 } } }, "RF-ALT-2005");

// R-2011：退出商户名下、设备时间晚于退出生效 → 挂起待裁定
emit({
  type: "RESERVATION_DISPLACED",
  aggregateType: "benefit_reservation",
  aggregateId: "R-2011",
  at: "2026-10-17T12:05:00",
  source: "CITY_PASS",
  scheduleVersion: 2,
  summary: "R-2011 因 M-303 退出进入处置，晚间出现争议扫码，暂挂起",
  payload: { cause: "MERCHANT_WITHDRAWAL", resolution: "PENDING_REVIEW", options: [] },
});

// ---------- 8. 取消当天后续核销：离线重传、替补履约、改道履约、争议扫码 ----------
// 离线扫码：设备时间 11:40（M-304 生效前，真实核销），恢复网络后补传
redeem("E-3-REDEEM", "R-2010", "2026-10-17T11:40:00", 60, "SCN-7777", { online: false, recordedAt: "2026-10-17T13:10:00", merchantId: "M-304" });
// 替补商户履约
redeem("E-6-REDEEM", "R-2051", "2026-10-17T12:35:00", 70, "SCN-7200", { merchantId: "M-305" });
// 争议扫码：设备时间 18:40，晚于 M-303 退出生效 15:00
redeem("E-4-REDEEM", "R-2011", "2026-10-17T18:40:00", 88, "SCN-9001", { merchantId: "M-303" });
// 改道观众在城西第二现场完成观赛
redeem("E-5-REDEEM", "R-2052", "2026-10-17T19:35:00", 88, "SCN-7100", { merchantId: "M-308" });

// ---------- 9. 匿名化核销证据（哈希链） ----------
const BATCH = "EVB-G1-1018";
const evidences = [
  { evidence_id: "E-1", scan_code: "SCN-6001", pass_id: "P-1001", ticket_no: "T-A0-0001", reservation_id: "R-2007", merchant_id: "M-307", venue_id: "V-MUSEUM", area_id: "A-OLDSTREET", benefit_type: "CULTURE_VENUE", amount: 30, face_amount: 30, redeemed_slot_start: "2026-10-16T14:00:00", device_time: "2026-10-16T14:05:00", online: true, recorded_at: "2026-10-16T14:05:00", settlement_status: "SETTLED" },
  { evidence_id: "E-2", scan_code: "SCN-5001", pass_id: "P-1001", ticket_no: "T-A0-0001", reservation_id: "R-2002", merchant_id: "M-302", venue_id: "V-HOTEL-RIVERSIDE", area_id: "A-WATERFRONT", benefit_type: "HOTEL", amount: 600, face_amount: 600, redeemed_slot_start: "2026-10-16T20:00:00", device_time: "2026-10-16T16:20:00", online: true, recorded_at: "2026-10-16T16:20:00", settlement_status: "SETTLED" },
  { evidence_id: "E-3", scan_code: "SCN-7777", pass_id: "P-1002", ticket_no: "T-B1-0002", reservation_id: "R-2010", merchant_id: "M-304", venue_id: "V-BISTRO-304", area_id: "A-STADIUM-CORE", benefit_type: "F&B", amount: 60, face_amount: 60, redeemed_slot_start: "2026-10-17T11:30:00", device_time: "2026-10-17T11:40:00", online: false, recorded_at: "2026-10-17T13:10:00", settlement_status: "SETTLED" },
  { evidence_id: "E-6", scan_code: "SCN-7200", pass_id: "P-1001", ticket_no: "T-A0-0001", reservation_id: "R-2051", merchant_id: "M-305", venue_id: "V-BISTRO-305", area_id: "A-STADIUM-CORE", benefit_type: "F&B", amount: 70, face_amount: 70, redeemed_slot_start: "2026-10-17T12:30:00", device_time: "2026-10-17T12:35:00", online: true, recorded_at: "2026-10-17T12:35:00", settlement_status: "SETTLED" },
  { evidence_id: "E-4", scan_code: "SCN-9001", pass_id: "P-1003", ticket_no: "T-C1-0003", reservation_id: "R-2011", merchant_id: "M-303", venue_id: "V-BAR-CENTRAL", area_id: "A-STADIUM-CORE", benefit_type: "SECOND_VENUE", amount: 88, face_amount: 88, redeemed_slot_start: "2026-10-17T19:00:00", device_time: "2026-10-17T18:40:00", online: true, recorded_at: "2026-10-17T18:40:00", settlement_status: "PENDING_REVIEW", review_reason: "设备时间晚于商户退出生效时间（15:00）" },
  { evidence_id: "E-5", scan_code: "SCN-7100", pass_id: "P-1002", ticket_no: "T-B1-0002", reservation_id: "R-2052", merchant_id: "M-308", venue_id: "V-FANZONE-WEST", area_id: "A-WESTGATE", benefit_type: "SECOND_VENUE", amount: 88, face_amount: 88, redeemed_slot_start: "2026-10-17T19:00:00", device_time: "2026-10-17T19:35:00", online: true, recorded_at: "2026-10-17T19:35:00", settlement_status: "SETTLED" },
];

let prevHash = "GENESIS";
const evidenceHashes = [];
for (const e of evidences) {
  const fields = {
    evidence_id: e.evidence_id,
    holder_key: holderKey(e.pass_id),
    ticket_no_hash: ticketHash(e.ticket_no),
    scan_code: e.scan_code,
    merchant_id: e.merchant_id,
    venue_id: e.venue_id,
    area_id: e.area_id,
    benefit_type: e.benefit_type,
    amount: e.amount,
    face_amount: e.face_amount,
    redeemed_slot_start: e.redeemed_slot_start,
    device_time: e.device_time,
    online: e.online,
    recorded_at: e.recorded_at,
    settlement_status: e.settlement_status,
    ...(e.review_reason ? { review_reason: e.review_reason } : {}),
  };
  const h = evidenceHash(prevHash, fields);
  evidenceHashes.push(h);
  emit({
    type: "REDEMPTION_EVIDENCE_RECORDED",
    aggregateType: "redemption_evidence",
    aggregateId: BATCH,
    at: e.recorded_at,
    source: "ANALYTICS",
    scheduleVersion: e.recorded_at.startsWith("2026-10-16") ? 1 : 2,
    summary: `匿名化核销证据 ${e.evidence_id}（${e.settlement_status}）`,
    eventId: nextId("EVT-EVID"),
    payload: { prev_hash: prevHash, evidence_hash: h, ...fields },
  });
  prevHash = h;
}
const sealedHash = batchHash(evidenceHashes);
emit({
  type: "EVIDENCE_BATCH_SEALED",
  aggregateType: "redemption_evidence",
  aggregateId: BATCH,
  at: "2026-10-18T09:00:00",
  source: "ANALYTICS",
  scheduleVersion: 2,
  summary: "处置窗口证据批次封档（含 6 条证据，其中 1 条待裁定）",
  payload: {
    batch_id: BATCH,
    evidence_ids: evidences.map((e) => e.evidence_id),
    prev_hash: "GENESIS",
    evidence_hashes: evidenceHashes,
    batch_hash: sealedHash,
  },
});

// ---------- 10. 商户结算：只结算真实核销 ----------
// gross_face = 证据面值之和；merchant_discount 按协议让利；net_payable = gross - discount；
// funding_breakdown 按现金来源拆分，金额合计必须等于 net_payable。
const settle = (claimId, at, merchantId, { evidenceIds, grossFace, discount = 0, depositForfeited = 0, fundingBreakdown, note, pendingReviews = [] }) =>
  emit({
    type: "MERCHANT_CLAIM_SETTLED",
    aggregateType: "merchant_claim",
    aggregateId: claimId,
    at,
    source: "LEDGER",
    scheduleVersion: 2,
    summary: note ?? `商户 ${merchantId} 按真实核销结算`,
    payload: {
      merchant_id: merchantId, evidence_ids: evidenceIds,
      gross_face: grossFace, merchant_discount: discount,
      net_payable: grossFace - discount, deposit_forfeited: depositForfeited,
      funding_breakdown: fundingBreakdown,
      ...(pendingReviews.length ? { pending_reviews: pendingReviews } : {}),
    },
  });

settle("CL-M-307", "2026-10-18T09:30:00", "M-307", {
  evidenceIds: ["E-1"], grossFace: 30,
  fundingBreakdown: [{ funding_source: "PASS_PREPAID_FUNDS", amount: 30 }],
  note: "M-307 博物馆按真实核销结算 30 元",
});

settle("CL-M-302", "2026-10-18T09:31:00", "M-302", {
  evidenceIds: ["E-2"], grossFace: 600, discount: 60,
  fundingBreakdown: [{ funding_source: "PASS_PREPAID_FUNDS", amount: 540 }],
  note: "M-302 酒店首晚真实核销面值 600 元，协议让利 60 元，应付 540 元",
});

settle("CL-M-304", "2026-10-18T09:32:00", "M-304", {
  evidenceIds: ["E-3"], grossFace: 60, depositForfeited: 10,
  fundingBreakdown: [{ funding_source: "PASS_PREPAID_FUNDS", amount: 60 }],
  note: "M-304 退出前离线扫码真实核销 60 元照付；违约保证金另抵扣 10 元给替补商户",
});

settle("CL-M-305", "2026-10-18T09:33:00", "M-305", {
  evidenceIds: ["E-6"], grossFace: 70,
  fundingBreakdown: [
    { funding_source: "PASS_PREPAID_FUNDS", amount: 60 },
    { funding_source: "MERCHANT_DEPOSIT_OFFSET", amount: 10 },
  ],
  note: "替补商户 M-305 承接履约 70 元：60 元预售池 + 10 元 M-304 违约保证金抵扣",
});

settle("CL-M-308", "2026-10-18T09:34:00", "M-308", {
  evidenceIds: ["E-5"], grossFace: 88,
  fundingBreakdown: [{ funding_source: "PASS_PREPAID_FUNDS", amount: 88 }],
  note: "改道承接商户 M-308 按真实核销结算 88 元",
});

// 退出商户 M-303：无真实核销结算，保证金扣 88，争议扫码挂起
settle("CL-M-303", "2026-10-18T09:35:00", "M-303", {
  evidenceIds: [], grossFace: 0, depositForfeited: 88,
  fundingBreakdown: [],
  pendingReviews: [{ scan_code: "SCN-9001", evidence_id: "E-4", reason: "设备时间晚于商户退出生效时间（15:00）" }],
  note: "M-303 无真实核销可结算；保证金扣划 88 元（对应 R-2004 退款），争议扫码 SCN-9001 挂起",
});

// ---------- 11. 清算对账 ----------
emit({
  type: "LEDGER_RECONCILED",
  aggregateType: "settlement_ledger",
  aggregateId: LEDGER,
  at: "2026-10-18T10:00:00",
  source: "LEDGER",
  scheduleVersion: 2,
  summary: "取消演练清算对账：补偿笔笔有预约、结算笔笔有证据，无悬置错配",
  payload: {
    refunds_total: 688,
    alternatives_total: 40,
    voided_total: 0,
    merchant_settlement_total: 788,
    // 观众侧补偿资金来源：600 取消保证金 + 88 违约商户自担 + 30 文旅补贴 + 10 保证金抵扣 = 728
    compensation_funding: {
      ORGANIZER_CANCELLATION_FUND: 600,
      MERCHANT_SELF_BORNE: 88,
      CITY_CULTURE_TOURISM_SUBSIDY: 30,
      MERCHANT_DEPOSIT_OFFSET: 10,
    },
    // 商户结算现金来源：预售池 778 + 违约保证金抵扣 10 = 788
    settlement_funding: {
      PASS_PREPAID_FUNDS: 778,
      MERCHANT_DEPOSIT_OFFSET: 10,
    },
    deposit_custody: {
      // 保证金扣划与去向闭环：M-303 的 88 元对应 R-2004 退款；M-304 的 10 元付给替补 M-305
      forfeited: { "M-303": 88, "M-304": 10 },
      applied: { MERCHANT_SELF_BORNE: 88, MERCHANT_DEPOSIT_OFFSET: 10 },
    },
    merchant_discount_total: 60,
    compensation_count: 5,
    settlement_claim_count: 6,
    evidence_count: 6,
    settled_evidence_count: 5,
    unmatched_count: 0,
    pending_review_count: 1,
    pending_reviews: [{ evidence_id: "E-4", scan_code: "SCN-9001", reservation_id: "R-2011", merchant_id: "M-303" }],
  },
});

// ---------- 12. 归因报告：新增消费 vs 普通客流，汇总可重算 ----------
const baselineDatasetHash = sha256("baseline:non-matchday-weekends:2026W04..W07:v1");
const buckets = [
  {
    dimensions: { area_id: "A-OLDSTREET" },
    merchant_rolled_up: ["M-307"],
    control_base: 22,
    redemption_count: 1,
    redemption_amount: 30,
    incremental_amount: 8,
    incremental_pct: 36.4,
  },
  {
    dimensions: { area_id: "A-WATERFRONT" },
    merchant_rolled_up: ["M-302"],
    control_base: 420,
    redemption_count: 1,
    redemption_amount: 600,
    incremental_amount: 180,
    incremental_pct: 42.9,
  },
  {
    dimensions: { area_id: "A-STADIUM-CORE" },
    merchant_rolled_up: ["M-304", "M-305"],
    control_base: 95,
    redemption_count: 2,
    redemption_amount: 130,
    incremental_amount: 35,
    incremental_pct: 36.8,
  },
  {
    dimensions: { area_id: "A-WESTGATE" },
    merchant_rolled_up: ["M-308"],
    control_base: 30,
    redemption_count: 1,
    redemption_amount: 88,
    incremental_amount: 58,
    incremental_pct: 193.3,
  },
];

emit({
  type: "ATTRIBUTION_REPORT_PUBLISHED",
  aggregateType: "attribution_report",
  aggregateId: "ATTR-G1-1018",
  at: "2026-10-18T11:00:00",
  source: "ANALYTICS",
  scheduleVersion: 2,
  summary: "G1 周末赛事新增消费归因报告（普通客流基线已钉版，待裁定证据不计入）",
  payload: {
    evidence_batches: [BATCH],
    baseline_dataset_hash: baselineDatasetHash,
    formula: "incremental_amount(area) = Σ amount(SETTLED evidence, match pass holders, area) − control_base(area, 近 4 个非赛事周末均值化基线)",
    buckets,
    suppressed_buckets: [
      { dimensions: { merchant_id: "M-307" }, reason: "单元格核销笔数 1 < 最小阈值 5，已并入街区 A-OLDSTREET 汇总" },
    ],
    totals: {
      redemption_count: 5,
      redemption_amount: 848,
      control_base: 567,
      incremental_amount: 281,
    },
    excluded_evidence: ["E-4"],
  },
});

const doc = {
  drill: "MATCH-2026-G1 cancellation",
  generated_at: new Date().toISOString(),
  note: "由 scripts/generate-cancellation-drill.mjs 生成；证据哈希链与汇总数可由测试重算复核。",
  events,
};

const out = fileURLToPath(new URL("../data/cancellation-drill.json", import.meta.url));
await writeFile(out, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(`已生成 ${events.length} 条事件 → ${out}`);
