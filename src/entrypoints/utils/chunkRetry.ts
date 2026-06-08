import type { TextBlock } from './blockExtractor';
import type { Chunk } from './chunkBuilder';

/**
 * Decide whether a chunk translation should be retried.
 *
 * Used by translateChunksViaBackground (content.ts) to gate per-chunk
 * retry. Pure function — extracted here so it's testable in isolation
 * and the policy is documented in one place.
 *
 * Returns `true` only when ALL of:
 *  - this isn't already a retry (cap recursion at 1)
 *  - there is something missing (missingCount > 0)
 *  - the API doesn't look completely broken (missing < 50% of chunk):
 *    if 50%+ blocks are missing, the API is probably failing entirely
 *    and retrying is wasted budget; the global missing sweep at the
 *    end + the visual fanyi-missing marker cover that case instead.
 *
 * @param opts.missingCount how many blocks from this chunk were not
 *                          present in the API response
 * @param opts.totalCount   total blocks the chunk originally contained
 * @param opts.isRetry      true if this is already a retry attempt
 */
export function shouldRetryMissing(opts: {
  missingCount: number;
  totalCount: number;
  isRetry: boolean;
}): boolean {
  const { missingCount, totalCount, isRetry } = opts;
  if (isRetry) return false;
  if (missingCount <= 0) return false;
  // Use >= 50% as the "API is broken" cutoff. Note: this counts missing
  // against the chunk's total, not the page's total — a chunk with 30
  // blocks losing 14 (47%) still retries, but losing 15 (50%) doesn't.
  if (missingCount >= totalCount / 2) return false;
  return true;
}

/**
 * Pick the blocks that need to be re-translated, preserving the order
 * they appeared in the original chunk (so cache key + retries stay
 * deterministic).
 */
export function pickMissingBlocks(
  blocks: TextBlock[],
  missingIds: string[],
): TextBlock[] {
  const missingSet = new Set(missingIds);
  return blocks.filter((b) => missingSet.has(b.id));
}

/**
 * Build a fresh chunk containing only the blocks that were missing
 * from the parent's response. The retry chunk has:
 *  - id: `${parentChunk.id}_retry` so logs are easy to scan
 *  - blocks: subset in original order
 *  - jsonContent: re-serialized (DIFFERENT from parent's jsonContent,
 *    even if the block ids are the same) → bypasses translation cache
 *    and triggers a fresh API call
 *  - estimatedTokens: sum of block text length / 4 (consistent with
 *    chunkBuilder.estimateTokens)
 */
export function buildRetryChunk(
  parentChunk: Chunk,
  missingIds: string[],
): Chunk {
  const retryBlocks = pickMissingBlocks(parentChunk.blocks, missingIds);
  const estimatedTokens = retryBlocks.reduce(
    (sum, b) => sum + Math.ceil(b.text.length / 4),
    0,
  );
  return {
    id: `${parentChunk.id}_retry`,
    blocks: retryBlocks,
    jsonContent: JSON.stringify(retryBlocks.map((b) => ({ id: b.id, text: b.text }))),
    estimatedTokens,
  };
}

/**
 * Compute which block ids from the input were not present in the
 * response. Used right after parsing the API response to feed into
 * buildRetryChunk / shouldRetryMissing.
 */
export function diffMissingIds(
  inputIds: string[],
  outputIds: string[],
): string[] {
  const outputSet = new Set(outputIds);
  return inputIds.filter((id) => !outputSet.has(id));
}
