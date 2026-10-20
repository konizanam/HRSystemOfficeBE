import { computeAuditHash, type HashableAuditRow } from './canonical-json';

export interface VerifyResult {
  ok: boolean;
  checked: number;
  firstId: string | null;
  lastId: string | null;
  lastHash: string | null;
  firstBrokenId: string | null;
  reason: string | null;
}

export type StoredAuditRow = HashableAuditRow & { hash: string };

/**
 * Recomputes the chain over rows in id order and reports the first broken id (section 9.3).
 * `expectedPrevHash` is the hash of the row before the first one (undefined = trust the first row's
 * prevHash, used when verifying a range).
 */
export async function verifyChain(
  rows: AsyncIterable<StoredAuditRow> | Iterable<StoredAuditRow>,
  expectedPrevHash?: string | null,
): Promise<VerifyResult> {
  let prev: string | null | undefined = expectedPrevHash;
  let checked = 0;
  let firstId: string | null = null;
  let lastId: string | null = null;
  let lastHash: string | null = null;

  for await (const row of rows) {
    const id = String(row.id);
    firstId ??= id;
    if (prev !== undefined && row.prevHash !== prev) {
      return {
        ok: false,
        checked,
        firstId,
        lastId,
        lastHash,
        firstBrokenId: id,
        reason: 'prevHash does not match the previous row',
      };
    }
    const expected = computeAuditHash(row);
    if (expected !== row.hash) {
      return {
        ok: false,
        checked,
        firstId,
        lastId,
        lastHash,
        firstBrokenId: id,
        reason: 'hash does not match row content',
      };
    }
    prev = row.hash;
    lastId = id;
    lastHash = row.hash;
    checked += 1;
  }
  return { ok: true, checked, firstId, lastId, lastHash, firstBrokenId: null, reason: null };
}
