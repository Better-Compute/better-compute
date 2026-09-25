// Reading a request body with a byte cap, for endpoints anyone can reach before the signature is checked (the
// inbox, refresh and webhook handlers): a declared `content-length` over the cap is refused without reading, and
// a streamed body is abandoned as soon as it passes the cap, so a large or slow body is never buffered in full.

/** The body as UTF-8 text, or `undefined` when it is (or declares itself) larger than `maxBytes`. */
export async function readBodyCapped(
  request: Request,
  maxBytes: number,
): Promise<string | undefined> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
