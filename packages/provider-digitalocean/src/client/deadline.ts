/**
 * A read's signal: its own deadline, joined with the caller's signal when the context carries one (vps passes the
 * request's signal to `providerAccounts.check` and `findings`), so a cancelled request stops calling DigitalOcean
 * and spending the account's budget. `timedOut()` tells the read's own deadline from the caller's cancellation.
 */
export function readDeadline(
  context: { signal?: AbortSignal },
  ms: number,
): { signal: AbortSignal; timedOut: () => boolean; done: () => void } {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new DOMException('The read took too long', 'TimeoutError'));
  }, ms);
  const signal = context.signal
    ? AbortSignal.any([context.signal, controller.signal])
    : controller.signal;
  return {
    signal,
    timedOut: () => expired,
    done: () => clearTimeout(timer),
  };
}
