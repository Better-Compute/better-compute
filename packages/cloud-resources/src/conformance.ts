import {
  ComputeError,
  isComputeError,
  systemClock,
  type CallContext,
  type Logger,
  type ProviderContext,
  type ProviderDefinition,
  type ProviderResourceKind,
  type ProviderResources,
  type ProviderResourceState,
} from '@better-compute/core';
import {
  check,
  checkEqual,
  checkRejects,
  ConformanceFailure,
  type ConformanceCase,
} from '@better-compute/core/conformance';

// The `ProviderResources` contract as conformance cases, run from any test runner against an emulator, a second
// fake or a live account. The same cases run against every provider that implements the contract (DigitalOcean,
// later AWS and GCP), which is what keeps the contract provider-neutral.

/** What the cases run against: a provider, an account config, one kind and specs for it. */
export interface ProviderResourcesConformanceSubject {
  provider: ProviderDefinition;
  /** Account config, validated by the provider's manifest. */
  config: unknown;
  context?: Partial<ProviderContext>;
  /** The kind the lifecycle cases create. */
  kind: string;
  /** A valid spec of `kind`. */
  spec: Record<string, unknown>;
  /** `spec` with one `updatable` field changed: converges in place. Skipped when absent. */
  updatedSpec?: Record<string, unknown>;
  /** `spec` with one field that is not `updatable` changed: `replaceRequired`. Skipped when absent. */
  replaceSpec?: Record<string, unknown>;
  /** A resource id of `kind` the deployment does not manage: `delete` refuses it. Skipped when absent. */
  unmanaged?: string;
  /** Ownership labels the cases pass to `ensure` (default: managed + a resource id). */
  labels?: Readonly<Record<string, string>>;
  /** A per-run prefix so concurrent runs never share idempotency keys or names. */
  prefix?: string;
  /** How many `ensure`/`get`/`delete` calls a resource may take to settle (default 20). */
  maxPolls?: number;
  /** Called between polls (an emulator tick, a sleep against a live account). */
  between?: () => Promise<void>;
}

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const kindPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const families = ['storage', 'network', 'edge', 'data', 'platform', 'ai', 'observability'];
const states: readonly ProviderResourceState['state'][] = [
  'pending',
  'ready',
  'updating',
  'deleting',
  'deleted',
  'error',
];

async function client(subject: ProviderResourcesConformanceSubject): Promise<{
  resources: ProviderResources;
  call: (key: string) => CallContext;
}> {
  const context: ProviderContext = {
    clock: subject.context?.clock ?? systemClock,
    log: subject.context?.log ?? quiet,
    secrets: subject.context?.secrets ?? {
      resolve: async () => {
        throw new ComputeError('INVALID_CONFIG', 'The conformance subject gave no secret resolver');
      },
    },
    ...(subject.context?.account ? { account: subject.context.account } : {}),
  };
  const parsed = await subject.provider.config['~standard'].validate(subject.config);
  if ('issues' in parsed && parsed.issues)
    throw new ComputeError(
      'INVALID_CONFIG',
      `The subject's config does not validate: ${parsed.issues[0]?.message}`,
    );
  const impl = await subject.provider.create((parsed as { value: unknown }).value, context);
  check(
    typeof impl.resources === 'object' && impl.resources !== null,
    'ProviderImpl.resources is present',
  );
  const call = (key: string): CallContext => ({
    idempotencyKey: key,
    signal: new AbortController().signal,
    clock: context.clock,
    secrets: context.secrets,
    log: context.log,
  });
  return { resources: impl.resources, call };
}

function checkState(
  state: ProviderResourceState | undefined,
  kind: ProviderResourceKind,
  what: string,
): asserts state is ProviderResourceState {
  check(state !== undefined, `${what}: expected a state`);
  check(typeof state.id === 'string' && state.id.length > 0, `${what}: id is a non-empty string`);
  check(
    states.includes(state.state),
    `${what}: state ${String(state.state)} is not in the contract`,
  );
  for (const [name, value] of Object.entries(state.outputs ?? {})) {
    check(kind.outputs.includes(name), `${what}: output ${name} is not declared by ${kind.kind}`);
    check(typeof value === 'string', `${what}: output ${name} is a string`);
  }
  for (const name of Object.keys(state.secretOutputs ?? {}))
    check(
      (kind.secretOutputs ?? []).includes(name),
      `${what}: secret output ${name} is not declared by ${kind.kind}`,
    );
}

async function validSpec(kind: ProviderResourceKind, spec: unknown): Promise<unknown> {
  const result = await kind.spec['~standard'].validate(spec);
  if (result.issues)
    throw new ComputeError(
      'INVALID_CONFIG',
      `The subject's spec does not validate for ${kind.kind}: ${result.issues[0]?.message}`,
    );
  return result.value;
}

/** Calls `step` until it answers a state in `until` (or `maxPolls` runs out). */
async function settle(
  subject: ProviderResourcesConformanceSubject,
  step: () => Promise<ProviderResourceState | undefined>,
  until: readonly ProviderResourceState['state'][],
  what: string,
): Promise<ProviderResourceState | undefined> {
  const limit = subject.maxPolls ?? 20;
  let last: ProviderResourceState | undefined;
  for (let poll = 0; poll < limit; poll++) {
    last = await step();
    if (last === undefined || until.includes(last.state)) return last;
    check(last.state !== 'error', `${what}: the provider reported error: ${last.message ?? ''}`);
    await subject.between?.();
  }
  throw new ConformanceFailure(`${what}: still ${last?.state ?? 'absent'} after ${limit} polls`);
}

/** The `ProviderResources` contract as conformance cases. */
export function providerResourcesConformanceCases(): ConformanceCase<ProviderResourcesConformanceSubject>[] {
  const key = (subject: ProviderResourcesConformanceSubject, name: string) =>
    `${subject.prefix ?? 'bc-conformance'}-${name}`;
  const labels = (subject: ProviderResourcesConformanceSubject, name: string) =>
    subject.labels ?? {
      'better-compute-managed': 'true',
      'better-compute-resource': key(subject, name),
    };
  const kindOf = (resources: ProviderResources, kind: string) => {
    const found = resources.kinds().find((entry) => entry.kind === kind);
    check(found !== undefined, `kinds() lists the subject's kind ${kind}`);
    return found;
  };

  /** Creates the subject's resource and waits until it is ready. */
  async function ready(subject: ProviderResourcesConformanceSubject, name: string) {
    const { resources, call } = await client(subject);
    const kind = kindOf(resources, subject.kind);
    const spec = await validSpec(kind, subject.spec);
    const request = {
      kind: subject.kind,
      name: key(subject, name),
      spec,
      labels: labels(subject, name),
    };
    const first = await resources.ensure(request, call(key(subject, name)));
    checkState(first, kind, 'ensure');
    const settled = await settle(
      subject,
      () => resources.ensure({ ...request, id: first.id }, call(key(subject, name))),
      ['ready'],
      'ensure',
    );
    checkState(settled, kind, 'ensure (settled)');
    checkEqual(settled.id, first.id, 'ensure keeps the id while it converges');
    return { resources, call, kind, request, state: settled };
  }

  async function cleanUp(
    subject: ProviderResourcesConformanceSubject,
    resources: ProviderResources,
    call: (key: string) => CallContext,
    id: string,
  ): Promise<void> {
    try {
      await settle(
        subject,
        () => resources.delete(subject.kind, id, call(`cleanup-${id}`)),
        ['deleted'],
        'cleanup',
      );
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
  }

  return [
    {
      name: 'kinds are well formed: provider-prefixed, a family, a manifest, declared outputs',
      async run(subject) {
        const { resources } = await client(subject);
        const kinds = resources.kinds();
        check(kinds.length > 0, 'kinds() lists at least one kind');
        const seen = new Set<string>();
        for (const kind of kinds) {
          check(
            kindPattern.test(kind.kind) && kind.kind.length <= 64 && kind.kind.includes('.'),
            `kind ${kind.kind} is provider-prefixed [a-z0-9.-], at most 64 characters`,
          );
          check(!seen.has(kind.kind), `kind ${kind.kind} is listed once`);
          seen.add(kind.kind);
          check(
            families.includes(kind.family),
            `${kind.kind}: family ${kind.family} is in the contract`,
          );
          check(
            typeof kind.spec?.['~standard']?.validate === 'function',
            `${kind.kind}: spec is a Standard Schema`,
          );
          check(Array.isArray(kind.outputs), `${kind.kind}: outputs is a list`);
          check(Array.isArray(kind.updatable), `${kind.kind}: updatable is a list`);
          for (const name of kind.secretOutputs ?? [])
            check(
              !kind.outputs.includes(name),
              `${kind.kind}: ${name} is not both a plain and a secret output`,
            );
          if (kind.parent !== undefined)
            check(
              kinds.some((entry) => entry.kind === kind.parent),
              `${kind.kind}: parent ${kind.parent} is listed`,
            );
        }
        kindOf(resources, subject.kind);
      },
    },
    {
      name: 'ensure of a kind the provider does not list is refused with UNSUPPORTED',
      async run(subject) {
        const { resources, call } = await client(subject);
        await checkRejects(
          () =>
            resources.ensure(
              { kind: 'conformance.no-such-kind', name: key(subject, 'none'), spec: {} },
              call(key(subject, 'none')),
            ),
          'UNSUPPORTED',
          'an unknown kind',
        );
      },
    },
    {
      name: 'ensure is idempotent by idempotencyKey and converges to ready; get follows it',
      async run(subject) {
        const { resources, call, kind, request, state } = await ready(subject, 'idem');
        try {
          const again = await resources.ensure(request, call(key(subject, 'idem')));
          checkState(again, kind, 'ensure again');
          checkEqual(again.id, state.id, 'a retried ensure (no id given) finds the same resource');
          const got = await resources.get(subject.kind, state.id, call(key(subject, 'idem-get')));
          checkState(got, kind, 'get');
          checkEqual(got.id, state.id, 'get returns the resource');
          check(got.state === 'ready', `get reports ready, not ${got.state}`);
        } finally {
          await cleanUp(subject, resources, call, state.id);
        }
      },
    },
    {
      name: 'an updatable change converges in place; any other change is replaceRequired',
      async run(subject) {
        if (subject.updatedSpec === undefined && subject.replaceSpec === undefined) return;
        const { resources, call, kind, request, state } = await ready(subject, 'update');
        try {
          if (subject.updatedSpec !== undefined) {
            const spec = await validSpec(kind, subject.updatedSpec);
            const updated = await settle(
              subject,
              () =>
                resources.ensure({ ...request, spec, id: state.id }, call(key(subject, 'update'))),
              ['ready'],
              'update',
            );
            checkState(updated, kind, 'update');
            checkEqual(updated.id, state.id, 'an in-place change keeps the id');
          }
          if (subject.replaceSpec !== undefined) {
            const spec = await validSpec(kind, subject.replaceSpec);
            const error = await checkRejects(
              () =>
                resources.ensure({ ...request, spec, id: state.id }, call(key(subject, 'update'))),
              'INVALID_STATE',
              'a change to a field that is not updatable',
            );
            checkEqual(
              (error as ComputeError).details?.reason,
              'replaceRequired',
              'the refusal names replaceRequired',
            );
          }
        } finally {
          await cleanUp(subject, resources, call, state.id);
        }
      },
    },
    {
      name: 'delete removes the resource; get is then undefined; deleting again counts as deleted',
      async run(subject) {
        const { resources, call, state } = await ready(subject, 'delete');
        const gone = await settle(
          subject,
          () => resources.delete(subject.kind, state.id, call(key(subject, 'delete'))),
          ['deleted'],
          'delete',
        );
        check(gone?.state === 'deleted', 'delete reaches deleted');
        const after = await resources.get(subject.kind, state.id, call(key(subject, 'delete-get')));
        check(after === undefined || after.state === 'deleted', 'get after delete is undefined');
        const again = await resources.delete(subject.kind, state.id, call(key(subject, 'delete')));
        check(again.state === 'deleted', 'deleting a deleted resource counts as deleted');
      },
    },
    {
      name: 'delete refuses a resource this deployment does not manage (notManaged)',
      async run(subject) {
        if (subject.unmanaged === undefined) return;
        const { resources, call } = await client(subject);
        const error = await checkRejects(
          () => resources.delete(subject.kind, subject.unmanaged!, call(key(subject, 'unmanaged'))),
          'INVALID_STATE',
          'deleting an unmanaged resource',
        );
        checkEqual(
          (error as ComputeError).details?.reason,
          'notManaged',
          'the refusal names notManaged',
        );
      },
    },
  ];
}
