import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyRedemptions,
  dedupeEnvelope,
  validateEvent,
} from "../src/validator.js";
import {
  attributionReport,
  compensationLedger,
  frozenSlots,
  merchantSettlements,
  scheduleVersionChain,
} from "../src/reconcile.js";

async function loadJsonl(path) {
  const text = await readFile(new URL(path, import.meta.url), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

test("样例符合领域约定", async () => {
  const sample = JSON.parse(
    await readFile(new URL("../data/sample.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(validateEvent(sample), []);
});

test("演练流每条事件都通过信封校验", async () => {
  const raw = await loadJsonl("../data/cancellation-drill.jsonl");
  for (const e of raw) assert.deepEqual(validateEvent(e), []);
});

test("信封去重：同一 event_id 的断网重投只保留首条", async () => {
  const raw = await loadJsonl("../data/cancellation-drill.jsonl");
  const { accepted, duplicates } = dedupeEnvelope(raw);
  assert.equal(raw.length, 45);
  assert.equal(accepted.length, 44);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].event_id, "drill-11");
});

test("扫码幂等：一次扫码断网重传只核销一次", async () => {
  const events = (await loadJsonl("../data/cancellation-drill.jsonl"));
  const { accepted } = dedupeEnvelope(events);
  const { accepted: redeemed, rejected } = applyRedemptions(accepted);

  // 6 个不同幂等键各核销一次（原住宿、线路、接驳、延住、替代观展、加映场）
  assert.equal(redeemed.length, 6);
  const keys = new Set(redeemed.map((r) => `${r.reservation_id}|${r.client_request_id}`));
  assert.equal(keys.size, 6);

  // 补扫 drill-12 与首次 drill-11 共用 scan-7788，被业务层拒绝
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].event.client_request_id, "scan-7788");
  assert.equal(rejected[0].first_event_id, "drill-11");
  assert.equal(rejected[0].event.event_id, "drill-12");
});

test("补偿台账：已用/未用权益与资金来源逐笔可核，全部支付无重复", async () => {
  const { accepted } = dedupeEnvelope(await loadJsonl("../data/cancellation-drill.jsonl"));
  const ledger = compensationLedger(accepted);

  // 六笔补偿：退票 28000 + 加映场 3000 + 接驳 1500 + 替代观展 2000 + 延住 20000 + 非现金 0
  assert.equal(ledger.posted_total_cents, 54500);
  assert.equal(ledger.paid_total_cents, 54500);
  assert.deepEqual(ledger.unpaid, []);

  assert.deepEqual(ledger.byFundingPosted, {
    TICKET_ESCROW: 28000,
    CITY_SUBSIDY: 4500, // 加映场 3000 + 接驳 1500
    MERCHANT_ESCROW: 2000,
    EVENT_INSURANCE: 20000,
    ORGANIZER: 0,
  });
  assert.deepEqual(ledger.byFundingPaid, ledger.byFundingPosted);

  // 已核销主题线路不退款、不追回（非现金权益，金额 0）
  const goodwill = ledger.items.find((i) => i.compensation_id === "cp-goodwill");
  assert.equal(goodwill.usage_state, "USED");
  assert.equal(goodwill.resolution, "NON_CASH_PRIORITY");
  assert.equal(goodwill.amount_cents, 0);

  // 已使用的酒店只补延住（取消险），原入住核销不受影响
  const hotel = ledger.items.find((i) => i.compensation_id === "cp-hotel-ext");
  assert.equal(hotel.usage_state, "USED_EXTENSION");
  assert.equal(hotel.funding_source, "EVENT_INSURANCE");

  // 通行证没有整张回滚：票是票、组合权益逐笔处理
  const ticket = ledger.items.find((i) => i.compensation_id === "cp-ticket");
  assert.equal(ticket.benefit_kind ?? "MATCH_TICKET", "MATCH_TICKET");
  assert.equal(ticket.resolution, "REFUND");
});

test("商户清算：只按真实核销结算，零核销与退出商户为 0", async () => {
  const { accepted } = dedupeEnvelope(await loadJsonl("../data/cancellation-drill.jsonl"));
  const settlement = merchantSettlements(accepted);

  assert.deepEqual(settlement.batches, [
    { batch_id: "batch-2026-1018-A", total_cents: 20000 },
    { batch_id: "batch-2026-1018-B", total_cents: 23500 },
    { batch_id: "batch-2026-1019-C", total_cents: 3000 },
  ]);
  assert.equal(settlement.grand_total_cents, 46500);
  assert.deepEqual(settlement.byMerchant, {
    "M-ROUTE": 12000,
    "M-HOTEL": 28000, // 10-17 晚 8000 + 取消延住 20000
    "M-FANZONE": 3000, // 取消前 0，次日加映场真实核销后才入账
    "M-EXHIBIT": 0, // 临时退出零核销
    "M-TRANSPORT": 1500,
    "M-MEMORY": 2000,
  });
});

test("限流只冻结受影响时段，解除不波及其他权益", async () => {
  const { accepted } = dedupeEnvelope(await loadJsonl("../data/cancellation-drill.jsonl"));
  const frozen = frozenSlots(accepted);
  assert.equal(frozen.length, 1);
  assert.equal(frozen[0].slot_id, "slot-1018-1800-2200");
  assert.deepEqual(frozen[0].frozen_reservation_ids, ["rv-fanzone"]);
  assert.equal(frozen[0].lifted_at, "2026-10-18T22:00:00+08:00");
});

test("资格转赠遵守赛事规则且责任链可追到实际核销人", async () => {
  const { accepted } = dedupeEnvelope(await loadJsonl("../data/cancellation-drill.jsonl"));
  const transfer = accepted.find((e) => e.event_type === "ENTITLEMENT_TRANSFERRED");
  assert.deepEqual(transfer.rule_checks, [
    "TOHOLDER_IS_VERIFIED_COMPANION",
    "WITHIN_REBOOK_WINDOW",
    "ONE_STEP_ONLY",
  ]);
  const chainEnd = transfer.responsibility_chain.at(-1).holder_ref;

  const redeem = accepted.find((e) => e.event_id === "drill-42");
  assert.equal(redeem.holder_ref, chainEnd);
  assert.equal(redeem.transfer_id, transfer.transfer_id);
  assert.equal(redeem.amount_cents, 3000);
});

test("匿名化证据归因：每个汇总数可由证据行与基线复算", async () => {
  const { accepted } = dedupeEnvelope(await loadJsonl("../data/cancellation-drill.jsonl"));
  const report = attributionReport(accepted);

  assert.deepEqual(report.evidence_hashes, [
    "sha256:7c41-route-band",
    "sha256:9b8e-fnband",
    "sha256:31d2-memory-band",
  ]);
  assert.equal(report.headcount, 120); // 40 + 60 + 20
  assert.equal(report.attributed_gross_cents, 1080000); // 320000 + 540000 + 220000
  assert.equal(report.counterfactual_total_cents, 720000); // 120 × 6000
  assert.equal(report.net_new_cents, 360000); // 赛事通行证净新增
  assert.equal(report.district_net_new_cents, 1250000); // 街区口径含外溢
  assert.equal(report.matches_recorded, true);

  // 证据行不得携带任何明文身份字段
  const evidence = accepted.filter((e) => e.event_type === "REDEMPTION_EVIDENCE_ANONYMIZED");
  for (const e of evidence) {
    assert.equal("holder_ref" in e, false);
    assert.equal("pass_id" in e, false);
  }
});

test("赛历版本只增不改：v1 排赛 → v2 取消 → v3 补赛", async () => {
  const { accepted } = dedupeEnvelope(await loadJsonl("../data/cancellation-drill.jsonl"));
  const chain = scheduleVersionChain(accepted);
  const versions = [...new Set(chain.map((c) => c.schedule_version))];
  assert.deepEqual(versions, [1, 2, 3]);
});
