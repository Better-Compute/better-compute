import { ComputeError } from '@better-compute/core';

/**
 * A request parameter. Plain objects are structures; a `Map` is an awsQuery map (`Name.entry.N.key`),
 * which has no EC2 form. `undefined` members are left out.
 */
export type QueryValue =
  | string
  | number
  | boolean
  | undefined
  | readonly QueryValue[]
  | ReadonlyMap<string, QueryValue>
  | { readonly [key: string]: QueryValue };
export type QueryParams = { readonly [key: string]: QueryValue };

type Flavour = 'ec2' | 'awsQuery';

/** RFC 3986 percent-encoding: only the unreserved set (`A-Za-z0-9-._~`) stays literal. */
function encode(text: string): string {
  try {
    return encodeURIComponent(text).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  } catch {
    throw new ComputeError('INVALID_INPUT', 'query parameter is not valid Unicode');
  }
}

function flatten(flavour: Flavour, name: string, value: QueryValue, out: [string, string][]): void {
  if (value === undefined) return;
  if (typeof value === 'string') out.push([name, value]);
  else if (typeof value === 'boolean') out.push([name, value ? 'true' : 'false']);
  else if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new ComputeError('INVALID_INPUT', `query parameter ${name} is not a finite number`);
    out.push([name, String(value)]);
  } else if (Array.isArray(value)) {
    const members = (value as readonly QueryValue[]).filter((member) => member !== undefined);
    // awsQuery spells an empty list as an empty value; EC2 has no way to and omits it.
    if (members.length === 0 && flavour === 'awsQuery') out.push([name, '']);
    members.forEach((member, index) =>
      flatten(
        flavour,
        flavour === 'ec2' ? `${name}.${index + 1}` : `${name}.member.${index + 1}`,
        member,
        out,
      ),
    );
  } else if (value instanceof Map) {
    if (flavour === 'ec2')
      throw new ComputeError('INVALID_INPUT', `query parameter ${name}: EC2 has no map type`);
    [...(value as ReadonlyMap<string, QueryValue>)]
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .forEach(([key, entry], index) => {
        out.push([`${name}.entry.${index + 1}.key`, key]);
        flatten(flavour, `${name}.entry.${index + 1}.value`, entry, out);
      });
  } else
    for (const [key, member] of Object.entries(value as { readonly [key: string]: QueryValue }))
      flatten(flavour, name === '' ? key : `${name}.${key}`, member, out);
}

function serialize(flavour: Flavour, action: string, version: string, params: QueryParams): string {
  const pairs: [string, string][] = [];
  flatten(flavour, '', params, pairs);
  // Action and Version are the caller's own arguments and win over same-named parameters.
  const encoded = pairs
    .filter(([key]) => key !== 'Action' && key !== 'Version')
    .concat([
      ['Action', action],
      ['Version', version],
    ])
    .map(([key, value]): [string, string] => [encode(key), encode(value)]);
  encoded.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return encoded.map(([key, value]) => `${key}=${value}`).join('&');
}

/** EC2 flattening: lists are `Name.1`, `Name.1.Sub`; booleans `true`/`false`; undefined omitted. Sorted keys. */
export function serializeEc2Query(action: string, version: string, params: QueryParams): string {
  return serialize('ec2', action, version, params);
}

/** awsQuery flattening: lists are `Name.member.1`; maps `Name.entry.1.key`/`.value`. Sorted keys. */
export function serializeAwsQuery(action: string, version: string, params: QueryParams): string {
  return serialize('awsQuery', action, version, params);
}
