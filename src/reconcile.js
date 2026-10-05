/**
 * 取消比赛演练的可复核汇总。全部为纯函数：读入事件流（应已完成信封去重），
 * 返回可逐笔追溯的台账。任何一个汇总数都能用事件编号重新算出。
 */

export function sum(amounts) {
  return amounts.reduce((acc, x) => acc + x, 0);
}

/** 补偿台账：按 compensation_id 汇总 POSTED 与 PAID，核对资金来源与金额。 */
export function compensationLedger(events) {
  const posted = new Map();
  const paid = new Map();

  for (const e of events) {
    if (e.event_type === "COMPENSATION_POSTED") {
      if (posted.has(e.compensation_id)) {
        throw new Error(`补偿重复入账：${e.compensation_id}`);
      }
      posted.set(e.compensation_id, {
        compensation_id: e.compensation_id,
        amount_cents: e.amount_cents,
        funding_source: e.funding_source,
        usage_state: e.usage_state,
        resolution: e.resolution,
        posted_event_id: e.event_id,
      });
    }
    if (e.event_type === "COMPENSATION_PAID") {
      for (const line of e.paid ?? []) {
        if (paid.has(line.compensation_id)) {
          throw new Error(`补偿被重复支付：${line.compensation_id}`);
        }
        const order = posted.get(line.compensation_id);
        if (!order) throw new Error(`支付找不到入账记录：${line.compensation_id}`);
        if (order.amount_cents !== line.amount_cents) {
          throw new Error(`支付金额与入账不一致：${line.compensation_id}`);
        }
        if (order.funding_source !== line.funding_source) {
          throw new Error(`支付资金来源与入账不一致：${line.compensation_id}`);
        }
        paid.set(line.compensation_id, { ...line, paid_event_id: e.event_id });
      }
    }
  }

  const items = [...posted.values()].map((p) => ({
    ...p,
    settlement_kind: p.resolution === "NON_CASH_PRIORITY" ? "NON_CASH" : "CASH",
    // 非现金权益在 POSTED 时即发放，无需也不应出现现金支付事件
    paid: paid.has(p.compensation_id) || p.resolution === "NON_CASH_PRIORITY",
  }));
  const byFundingPosted = groupSum(items.map((i) => [i.funding_source, i.amount_cents]));
  const byFundingPaid = groupSum(
    items.filter((i) => i.paid).map((i) => [i.funding_source, i.amount_cents]),
  );
  return {
    items,
    posted_total_cents: sum(items.map((i) => i.amount_cents)),
    paid_total_cents: sum([...paid.values()].map((i) => i.amount_cents)),
    unpaid: items.filter((i) => !i.paid).map((i) => i.compensation_id),
    byFundingPosted,
    byFundingPaid,
  };
}

/** 商户清算：按批次核对行合计，并把每行回链到真实核销证据。 */
export function merchantSettlements(events) {
  const redemptionById = new Map(
    events.filter((e) => e.event_type === "BENEFIT_REDEEMED").map((e) => [e.event_id, e]),
  );
  const batches = [];
  for (const e of events.filter((x) => x.event_type === "MERCHANT_SETTLEMENT_POSTED")) {
    const computed = sum(e.lines.map((l) => l.amount_cents));
    if (computed !== e.total_cents) {
      throw new Error(`批次 ${e.batch_id} 合计不符：行合计 ${computed} ≠ ${e.total_cents}`);
    }
    for (const line of e.lines) {
      // 商户只结算真实核销：正数行必须逐笔挂在核销证据上，且金额一致
      if (line.amount_cents > 0) {
        if (!line.evidence_event_ids?.length) {
          throw new Error(`批次 ${e.batch_id} 中 ${line.merchant_id} 缺少核销证据`);
        }
        const evidenceTotal = sum(
          line.evidence_event_ids.map((id) => {
            const r = redemptionById.get(id);
            if (!r) throw new Error(`核销证据不存在：${id}`);
            if (r.merchant_id !== line.merchant_id) {
              throw new Error(`证据 ${id} 商户与结算行不一致`);
            }
            return r.amount_cents;
          }),
        );
        if (evidenceTotal !== line.amount_cents) {
          throw new Error(
            `批次 ${e.batch_id} 中 ${line.merchant_id} 结算 ${line.amount_cents} 与核销 ${evidenceTotal} 不符`,
          );
        }
      }
    }
    batches.push(e);
  }

  const byMerchant = {};
  for (const b of batches) {
    for (const line of b.lines) {
      byMerchant[line.merchant_id] = (byMerchant[line.merchant_id] ?? 0) + line.amount_cents;
    }
  }
  return {
    batches: batches.map((b) => ({ batch_id: b.batch_id, total_cents: b.total_cents })),
    grand_total_cents: sum(batches.map((b) => b.total_cents)),
    byMerchant,
  };
}

/**
 * 时段冻结：限制只冻结受影响时段内的预约。
 * 返回每个限制在生效窗口内实际冻结的 reservation_id 集合。
 */
export function frozenSlots(events) {
  const lifts = new Map();
  for (const e of events.filter((x) => x.event_type === "RESTRICTION_LIFTED")) {
    lifts.set(e.aggregate_id, e.occurred_at);
  }
  return events
    .filter((e) => e.event_type === "CAPACITY_RESTRICTED")
    .map((e) => ({
      restriction_id: e.aggregate_id,
      slot_id: e.slot_id,
      issuer: e.issuer,
      scope: e.scope,
      frozen_reservation_ids: e.affected_reservation_ids,
      lifted_at: lifts.get(e.aggregate_id) ?? null,
    }));
}

/**
 * 赛事新增消费归因（双口径，全部由匿名证据行与基线复算）：
 * 1) 通行证净新增 = 关联消费 − 同人群反事实（基线人均 × 人数）
 * 2) 街区总净增 = 街区实际 − 街区基线（含外溢）
 */
export function attributionReport(events) {
  const evidence = events.filter((e) => e.event_type === "REDEMPTION_EVIDENCE_ANONYMIZED");
  const reconciled = events.find((e) => e.event_type === "ATTRIBUTION_RECONCILED");
  const baseline = events.find((e) => e.event_type === "DISTRICT_BASELINE_IMPORTED");
  if (!reconciled || !baseline) throw new Error("缺少归因复算或基线事件");

  const headcount = sum(evidence.map((e) => e.headcount));
  const attributedGross = sum(evidence.map((e) => e.gross_cents));
  const counterfactual = headcount * baseline.baseline_per_capita_cents;
  const netNew = attributedGross - counterfactual;
  const districtNetNew = reconciled.district_actual_gross_cents - reconciled.district_baseline_gross_cents;

  return {
    evidence_hashes: evidence.map((e) => e.evidence_hash),
    headcount,
    attributed_gross_cents: attributedGross,
    counterfactual_total_cents: counterfactual,
    net_new_cents: netNew,
    district_net_new_cents: districtNetNew,
    matches_recorded:
      reconciled.evidence_count === evidence.length &&
      reconciled.headcount === headcount &&
      reconciled.attributed_gross_cents === attributedGross &&
      reconciled.counterfactual_total_cents === counterfactual &&
      reconciled.net_new_cents === netNew &&
      reconciled.district_net_new_cents === districtNetNew,
  };
}

/** 赛历版本只增不改：同一赛事的 schedule_version 必须严格递增。 */
export function scheduleVersionChain(events) {
  const versions = events
    .filter((e) => "schedule_version" in e)
    .map((e) => ({ event_id: e.event_id, schedule_version: e.schedule_version }));
  for (let i = 1; i < versions.length; i += 1) {
    if (versions[i].schedule_version < versions[i - 1].schedule_version) {
      throw new Error(`赛历版本回退：${versions[i].event_id}`);
    }
  }
  return versions;
}

function groupSum(pairs) {
  const out = {};
  for (const [key, value] of pairs) out[key] = (out[key] ?? 0) + value;
  return out;
}
