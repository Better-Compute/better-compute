// Method names as the compute API spells them, shared by the proxy (server) and the change journal (browser).

/** A method path: `capacity/summary`, `nodes/list`, `system/version`. */
export const METHOD_PATH = /^[a-z][A-Za-z0-9]*(\/[a-z][A-Za-z0-9]*){1,3}$/;

/**
 * Read methods: the last segment is a getter or a listing (get, list, summary, version, status, timeline,
 * preview, history, diff, show, describe, catalog, search, find, estimate, optionally followed by more words:
 * `listSshCerts`, `getPolicy`). Signed out, the proxy forwards only these (with the shared connection, if
 * any); mutations need an operator's own session. A name that reads *and* writes (`getOrCreate`,
 * `listAndPrune`, `findAndLock`) is not a read. This is a name check, so give ADMIN_COMPUTE_TOKEN a read-only
 * role too: the API's own authorization is the real boundary.
 */
const READ_METHOD = /^(get|list|summary|version|status|timeline|preview|history|diff|show|describe|catalog|search|find|estimate)([A-Z][A-Za-z0-9]*)?$/;
const WRITE_WORD =
  /(?:Or|And|Then|Create|Delete|Update|Set|Put|Upsert|Insert|Remove|Prune|Purge|Revoke|Rotate|Write|Apply|Cancel|Release|Drain|Cordon|Reset|Ensure|Sync|Claim|Acquire|Lock|Mark|Ack|Refresh|Issue|Grant|Start|Stop|Run|Exec|Send|Save|Commit|Assign|Allocate|Reserve|Book)(?=[A-Z]|$)/;

export function isReadMethod(path: string): boolean {
  if (!METHOD_PATH.test(path)) return false;
  const method = path.split('/').at(-1)!;
  const match = READ_METHOD.exec(method);
  return Boolean(match) && !WRITE_WORD.test(match![2] ?? '');
}
