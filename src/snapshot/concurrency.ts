/** Default fan-out for filesystem work; keeps descriptor use well under the usual 256 soft limit. */
export const DEFAULT_FILE_CONCURRENCY_V1 = 16;

/**
 * Maps over `items` with at most `limit` operations in flight, preserving input order in the
 * result. Unlike `Promise.all` over a full `map`, concurrency does not grow with the input size,
 * so a change touching thousands of files cannot exhaust file descriptors.
 */
export async function mapWithConcurrencyV1<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  limit: number = DEFAULT_FILE_CONCURRENCY_V1,
): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("concurrency limit must be a positive safe integer");
  }
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index] as T, index);
    }
  });
  await Promise.all(runners);
  return results;
}
