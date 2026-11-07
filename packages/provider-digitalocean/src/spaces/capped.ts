// Reading a response body with a size cap: Spaces answers (an error body, a bucket's marker) can be
// written or shaped by others, so only so much of one is ever held in memory. Internal: not part of
// the package's exports.

/**
 * Up to `cap` bytes of the body. Reading stops once the cap is reached (the rest is cancelled), so
 * a body without a length, or with a false one, is never read into memory whole.
 */
export async function readCappedBytes(response: Response, cap: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const all = new Uint8Array(Math.min(size, cap));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, all.length - offset);
    all.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= all.length) break;
  }
  return all;
}
