import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { dedupeEnvelope, validateEvent } from "../src/validator.js";
import { batchHash, canonical, evidenceHash, hmacHex, sha256 } from "../src/hashing.js";

const doc = JSON.parse(
  await readFile(new URL("../data/cancellation-drill.json", import.meta.url), "utf8"),
);
const events = doc.events;
const byType = (t) => events.filter((e) => e.event_type === t);
const byAgg = (id) => events.filter((e) => e.aggregate_id === id);
const byId = new Map(events.map((e) => [e.event_id, e]));

test("信封合法：全部事件通过校验且 event_id 全局唯一", () => {
  const ids = new Set();
  for (const e of events) {
    assert.deepEqual(validateEvent(e), [], `${e.event_id} 校验失败：${validateEvent(e)}`);
    assert.ok(!ids.has(e.event_id), `event_id 重复：${e.event_id}`);
    ids.add(e.event_id);
  }
});

test("聚合版本只追加、严格递增，更正不回写旧事件", () => {
  const seen = new Map();
  for (const e of events) {
    const key = `${e.aggregate_type}:${e.aggregate_id}`;
    const prev = seen.get(key) ?? 0;
    assert.ok(e.version > prev, `${key} 版本未递增`);
    seen.set(key, e.version);
  }
  const schedule = byAgg("MATCH-2026-G1");
  assert.equal(schedule[0].event_type, "SCHEDULE_PUBLISHED");
  assert.equal(schedule[0].version, 1);
  assert.equal(schedule.at(-1).event_type, "SCHEDULE_CANCELLED");
  assert.equal(schedule.at(-1).version, 2); // 取消产生新版本，v1 记录原样保留
});

test("跨系统消息按信封去重；断网重传同一扫码流水只核销一次", () => {
  const seen = new Set();
  const scan = {
    event_id: "EVT-X-0001",
    event_type: "BENEFIT_REDEEMED",
    aggregate_type: "benefit_reservation",
    aggregate_id: "R-2010",
    occurred_at: "2026-10-17T11:40:00+08:00",
    version: 1,
    summary: "离线扫码首次上传",
    idempotency_key: "SCN-7777",
  };
  const retransmitted = { ...scan, event_id: "EVT-X-0002", summary: "断网恢复后重传" };
  assert.deepEqual(dedupeEnvelope(seen, scan), { accepted: true, duplicate: false, key: "idem:SCN-7777" });
  assert.equal(dedupeEnvelope(seen, retransmitted).accepted, false); // 换 event_id 也只算一次

  // 演练流内扫码流水号不重复：一次扫码一条核销
  const scans = byType("BENEFIT_REDEEMED").map((e) => e.idempotency_key);
  assert.equal(new Set(scans).size, scans.length);
  // 退款补偿单同样幂等
  const refundKeys = byType("COMPENSATION_POSTED").map((e) => e.idempotency_key);
  assert.equal(new Set(refundKeys).size, refundKeys.length);
});

test("限流只冻结与限制窗口、区域相交的时段，不波及次日展览和首日活动", () => {
  const restriction = byType("CAPACITY_RESTRICTED")[0].payload;
  assert.equal(restriction.area_id, "A-STADIUM-CORE");
  const frozen = byType("INVENTORY_SLOT_FROZEN");
  const affected = new Set(frozen.flatMap((e) => e.payload.reservation_ids_affected));
  assert.deepEqual([...affected].sort(), ["R-2001", "R-2008"]);
  for (const e of frozen) {
    assert.equal(e.payload.area_id, restriction.area_id);
    for (const slot of e.payload.frozen_slots) {
      assert.ok(slot.slot_start < restriction.effective_to && slot.slot_end > restriction.effective_from);
    }
  }
  // 次日新城展览、首日老街博物馆、非管控区酒店均未被冻结
  for (const id of ["R-2006", "R-2007", "R-2002", "R-2003"]) assert.ok(!affected.has(id));
});

test("在途观众在取消后立即收到可执行改道，选择即生成替代预约", () => {
  const cancelledAt = Date.parse(byType("SCHEDULE_CANCELLED")[0].occurred_at);
  const offer = byType("DIVERSION_OFFERED")[0];
  assert.equal(offer.payload.spectator_state, "IN_TRANSIT");
  assert.ok(Date.parse(offer.occurred_at) - cancelledAt <= 5 * 60 * 1000); // 5 分钟内触达
  assert.deepEqual(offer.payload.channels, ["APP_PUSH", "SMS"]);
  for (const opt of offer.payload.options) {
    assert.ok(opt.slots_left > 0, `${opt.option_id} 没有真实余量`);
    assert.ok(opt.action_endpoint.startsWith("citypass://"));
    assert.ok(Date.parse(opt.valid_until) > Date.parse(offer.occurred_at));
  }
  const selected = byType("DIVERSION_SELECTED")[0];
  const chosen = offer.payload.options.find((o) => o.option_id === selected.payload.option_id);
  assert.ok(chosen);
  const repl = byId.get(byType("BENEFIT_RESERVED").find((r) => r.aggregate_id === selected.payload.new_reservation_id).event_id);
  assert.equal(repl.payload.replaces_reservation_id, "R-2008");
  assert.equal(repl.causation_id, selected.event_id); // 因果链指回改道选择
});

test("补偿矩阵：已使用不退现金、一笔一资金来源、未使用按情形分流", () => {
  const compensations = byType("COMPENSATION_POSTED");
  assert.equal(compensations.length, 5);
  const reservations = new Map(byType("BENEFIT_RESERVED").map((e) => [e.aggregate_id, e]));
  for (const c of compensations) {
    const r = reservations.get(c.payload.reservation_id);
    assert.ok(r, `${c.event_id} 补偿无对应预约`);
    assert.ok(typeof c.payload.funding_source === "string"); // 一笔只有一个资金来源
    if (c.payload.usage_state === "USED") {
      assert.ok(!(c.payload.kind === "REFUND" && c.payload.amount > 0), "已使用权益不得现金退款");
    }
  }
  // 已核销的酒店首晚 R-2002、博物馆 R-2007 不出现在任何补偿中
  const compensated = new Set(compensations.map((c) => c.payload.reservation_id));
  for (const id of ["R-2002", "R-2007"]) assert.ok(!compensated.has(id));

  // 分流路径逐一核对
  const byRes = Object.fromEntries(compensations.map((c) => [c.payload.reservation_id, c]));
  assert.equal(byRes["R-2003"].payload.kind, "REFUND");
  assert.equal(byRes["R-2003"].payload.funding_source, "ORGANIZER_CANCELLATION_FUND");
  assert.equal(byRes["R-2004"].payload.funding_source, "MERCHANT_SELF_BORNE");
  assert.equal(byRes["R-2005"].payload.kind, "ALTERNATIVE");
  assert.equal(byRes["R-2005"].payload.funding_source, "MERCHANT_DEPOSIT_OFFSET");
  assert.equal(byRes["R-2001"].payload.funding_source, "CITY_CULTURE_TOURISM_SUBSIDY");
  assert.equal(byRes["R-2008"].payload.kind, "ALTERNATIVE");
  assert.equal(byRes["R-2008"].payload.amount, 0); // 改道不退现金

  // 清算总数可由逐笔补偿重算
  const recon = byType("LEDGER_RECONCILED")[0].payload;
  const sum = (kind) => compensations.filter((c) => c.payload.kind === kind).reduce((s, c) => s + c.payload.amount, 0);
  assert.equal(sum("REFUND"), recon.refunds_total, 688);
  assert.equal(sum("ALTERNATIVE"), recon.alternatives_total, 40);
  const fundTotals = {};
  for (const c of compensations) fundTotals[c.payload.funding_source] = (fundTotals[c.payload.funding_source] ?? 0) + c.payload.amount;
  assert.deepEqual(fundTotals, recon.compensation_funding);

  // 保证金扣划与去向闭环
  const forfeited = Object.values(recon.deposit_custody.forfeited).reduce((a, b) => a + b, 0);
  const applied = Object.values(recon.deposit_custody.applied).reduce((a, b) => a + b, 0);
  assert.equal(forfeited, applied);
});

test("商户只结算真实核销：结算金额逐条对得上 SETTLED 证据，争议扫码挂起", () => {
  const claims = byType("MERCHANT_CLAIM_SETTLED");
  const evidenceEvents = byType("REDEMPTION_EVIDENCE_RECORDED");
  const evidenceById = new Map(evidenceEvents.map((e) => [e.payload.evidence_id, e.payload]));

  let settlementTotal = 0;
  const settledEvidenceIds = new Set();
  for (const claim of claims) {
    const p = claim.payload;
    const refs = p.evidence_ids.map((id) => evidenceById.get(id));
    for (const ev of refs) {
      assert.equal(ev.settlement_status, "SETTLED", `${claim.aggregate_id} 不得结算待裁定证据 ${ev.evidence_id}`);
      settledEvidenceIds.add(ev.evidence_id);
    }
    assert.equal(p.gross_face, refs.reduce((s, e) => s + e.face_amount, 0));
    assert.equal(p.net_payable, p.gross_face - p.merchant_discount);
    assert.equal(
      p.funding_breakdown.reduce((s, l) => s + l.amount, 0),
      p.net_payable,
    );
    settlementTotal += p.net_payable;
  }
  assert.equal(settlementTotal, byType("LEDGER_RECONCILED")[0].payload.merchant_settlement_total, 788);

  // 退出商户 M-303 无真实核销可结算，争议证据 E-4 不进入任何结算
  const m303 = claims.find((c) => c.payload.merchant_id === "M-303").payload;
  assert.equal(m303.gross_face, 0);
  assert.equal(m303.net_payable, 0);
  assert.equal(m303.pending_reviews[0].evidence_id, "E-4");
  assert.ok(!settledEvidenceIds.has("E-4"));

  // 离线扫码（设备时间在商户退出生效前）作为真实核销照付
  const m304 = claims.find((c) => c.payload.merchant_id === "M-304").payload;
  assert.ok(m304.evidence_ids.includes("E-3"));
});

test("证据匿名化：无明文身份字段，且哈希链与批次封档可重算", () => {
  const banned = ["pass_id", "ticket_no", "holder_name", "phone", "id_card", "order_id"];
  const events_ = byType("REDEMPTION_EVIDENCE_RECORDED");
  const hashes = [];
  let prev = "GENESIS";
  for (const e of events_) {
    for (const k of banned) assert.ok(!(k in e.payload), `证据 ${e.event_id} 出现禁字段 ${k}`);
    assert.notEqual(e.payload.holder_key, "P-1001"); // 持证人以 HMAC 呈现
    const { prev_hash, evidence_hash, ...fields } = e.payload;
    assert.equal(prev_hash, prev);
    const recomputed = evidenceHash(prev, fields);
    assert.equal(recomputed, evidence_hash);
    hashes.push(evidence_hash);
    prev = evidence_hash;
  }
  const seal = byType("EVIDENCE_BATCH_SEALED")[0].payload;
  assert.equal(seal.batch_hash, batchHash(hashes));
  assert.deepEqual(seal.evidence_hashes, hashes);
});

test("归因报告：汇总数可从 SETTLED 证据逐桶重算，待裁定证据排除", () => {
  const report = byType("ATTRIBUTION_REPORT_PUBLISHED")[0].payload;
  const evidence = byType("REDEMPTION_EVIDENCE_RECORDED")
    .map((e) => e.payload)
    .filter((e) => e.settlement_status === "SETTLED");

  // 用票根哈希验证"持票观众"判定路径本身可复算
  assert.equal(sha256("drill:T-A0-0001"), evidence.find((e) => e.evidence_id === "E-1").ticket_no_hash);
  assert.equal(hmacHex("drill-batch-salt-B1", "P-1001"), evidence.find((e) => e.evidence_id === "E-1").holder_key);

  const totals = { redemption_count: 0, redemption_amount: 0, control_base: 0, incremental_amount: 0 };
  for (const bucket of report.buckets) {
    const area = bucket.dimensions.area_id;
    const rows = evidence.filter((e) => e.area_id === area);
    assert.equal(bucket.redemption_count, rows.length, `${area} 笔数对不上`);
    assert.equal(bucket.redemption_amount, rows.reduce((s, e) => s + e.amount, 0), `${area} 金额对不上`);
    assert.equal(bucket.incremental_amount, bucket.redemption_amount - bucket.control_base);
    assert.equal(bucket.incremental_pct, Math.round((bucket.incremental_amount / bucket.control_base) * 1000) / 10);
    totals.redemption_count += bucket.redemption_count;
    totals.redemption_amount += bucket.redemption_amount;
    totals.control_base += bucket.control_base;
    totals.incremental_amount += bucket.incremental_amount;
  }
  assert.deepEqual(
    {
      redemption_count: totals.redemption_count,
      redemption_amount: totals.redemption_amount,
      control_base: totals.control_base,
      incremental_amount: totals.incremental_amount,
    },
    report.totals,
  );
  assert.ok(report.suppressed_buckets.length > 0); // 小单元格抑制留痕
  assert.deepEqual(report.excluded_evidence, ["E-4"]);
});

test("转赠遵守赛事规则并保留责任链", () => {
  const transfer = byType("PASS_QUALIFICATION_TRANSFERRED")[0].payload;
  assert.ok(transfer.rule_basis.includes("转赠规则"));
  assert.equal(transfer.eligibility_check.realname, "PASSED");
  assert.ok(Array.isArray(transfer.prior_chain) && transfer.prior_chain.includes("H-A0"));
  assert.ok(transfer.accepted_at);
  // 取消发生在受让人接受之后，P-1001 的补偿链路挂在同一通行证，历史核销不被改写
  const redeemedOnPass = byType("BENEFIT_REDEEMED").filter((e) => ["R-2002", "R-2007"].includes(e.aggregate_id));
  assert.equal(redeemedOnPass.length, 2);
});

test("不做整张通行证回滚：已使用权益保留、各权益独立处置、对账无错配", () => {
  // 没有任何事件删除/作废通行证；P-1001 上同时存在已核销、退款、改约三种结局
  const compensated = byType("COMPENSATION_POSTED").map((c) => c.payload.reservation_id);
  for (const id of ["R-2002", "R-2007"]) assert.ok(!compensated.includes(id)); // 已使用保留
  assert.ok(compensated.includes("R-2003")); // 未使用退款
  assert.ok(compensated.includes("R-2001")); // 未使用改约
  assert.equal(byType("LEDGER_RECONCILED")[0].payload.unmatched_count, 0);
});

test("规范化函数稳定（复核方用同样算法重算哈希）", () => {
  assert.equal(canonical({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(canonical([1, { x: 1 }]), '[1,{"x":1}]');
});
