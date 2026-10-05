import { createHash, createHmac } from "node:crypto";

/** 无空白、键排序的规范化 JSON，用于哈希与跨系统复核 */
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function hmacHex(secret, text) {
  return createHmac("sha256", secret).update(text, "utf8").digest("hex");
}

/** 证据哈希链：prev_hash + 本条证据（剔除哈希字段） */
export function evidenceHash(prevHash, evidenceFields) {
  return sha256(`${prevHash}|${canonical(evidenceFields)}`);
}

/** 批次封档哈希：批内证据哈希排序后串联 */
export function batchHash(evidenceHashes) {
  return sha256([...evidenceHashes].sort().join("|"));
}
