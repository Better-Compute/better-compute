import {
  ComputeError,
  type CallContext,
  type ProviderCatalogEntry,
  type ProviderDiscoveredResource,
  type ProviderResourceKind,
  type ProviderResourceRequest,
  type ProviderResources,
  type ProviderResourceSignal,
  type ProviderResourceState,
} from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import type { DoConfig } from '../config.js';
import { deploymentTag } from '../ids.js';
import { addonKind } from './kinds/addons.js';
import { appKind } from './kinds/apps.js';
import { databaseKinds } from './kinds/databases.js';
import { functionsKinds } from './kinds/functions.js';
import { guardrailKind } from './kinds/guardrails.js';
import { dedicatedInferenceKind } from './kinds/inference.js';
import { inferenceKeyKind } from './kinds/inference-keys.js';
import { knowledgeBaseKind } from './kinds/knowledge-bases.js';
import { actionGatewayKind, agentHarnessKind } from './kinds/managed-agents.js';
import { partnerKind } from './kinds/partner.js';
import { oneClickCatalog } from './one-clicks.js';
import { doSignals } from './signals.js';
import type { DoKind, DoKindEnv } from './kind.js';

// The `ProviderResources` dispatcher: every long-tail DigitalOcean kind, by name. The cloud-resources module
// validates a spec with the kind's manifest before it calls; the dispatcher refuses an unknown kind and a preview
// kind the account does not enable (a rejected promise, before anything is sent), and passes everything else to
// the kind.

/** Every kind this provider serves, in catalog order. */
export function doResourceKinds(): DoKind[] {
  return [
    ...databaseKinds(),
    appKind(),
    ...functionsKinds(),
    addonKind(),
    partnerKind(),
    dedicatedInferenceKind(),
    inferenceKeyKind(),
    knowledgeBaseKind(),
    guardrailKind(),
    agentHarnessKind(),
    actionGatewayKind(),
  ];
}

export class DoResources implements ProviderResources {
  readonly #kinds: ReadonlyMap<string, DoKind>;
  readonly #env: DoKindEnv;

  constructor(
    client: DoClient,
    config: DoConfig,
    deployment: string,
    kinds: readonly DoKind[] = doResourceKinds(),
  ) {
    this.#kinds = new Map(kinds.map((kind) => [kind.definition.kind, kind]));
    this.#env = {
      client,
      deploymentTag: deploymentTag(deployment),
      previews: config.previews === true,
    };
  }

  kinds(): readonly ProviderResourceKind[] {
    return [...this.#kinds.values()].map((kind) => kind.definition);
  }

  /**
   * The kind, for `use`. A preview kind is refused on an account without previews for making or finding one
   * (`ensure`, `adopt`, `discover`, `release`), never for reading or deleting one (`keep`): a resource made while
   * previews were on (billed by the hour) can always be torn down, by its tenant or by a tenant teardown.
   */
  #kind(kind: string, use: 'make' | 'keep' = 'make'): DoKind {
    const found = this.#kinds.get(kind);
    if (!found)
      throw new ComputeError('UNSUPPORTED', `DigitalOcean serves no ${kind}`, undefined, {
        provider: 'digitalocean',
        reason: 'kind',
      });
    if (use === 'make' && found.definition.preview === true && !this.#env.previews)
      throw new ComputeError(
        'UNSUPPORTED',
        `${kind} is a DigitalOcean preview; the account must enable previews`,
        undefined,
        {
          provider: 'digitalocean',
          reason: 'preview',
        },
      );
    return found;
  }

  async ensure(
    request: ProviderResourceRequest,
    context: CallContext,
  ): Promise<ProviderResourceState> {
    return this.#kind(request.kind).ensure(this.#env, request, context);
  }

  async get(
    kind: string,
    id: string,
    context: CallContext,
  ): Promise<ProviderResourceState | undefined> {
    return this.#kind(kind, 'keep').get(this.#env, id, context);
  }

  async delete(kind: string, id: string, context: CallContext): Promise<ProviderResourceState> {
    return this.#kind(kind, 'keep').delete(this.#env, id, context);
  }

  discover(kind: string, context: CallContext): AsyncIterable<ProviderDiscoveredResource> {
    const found = this.#kind(kind);
    if (!found.discover)
      throw new ComputeError('UNSUPPORTED', `${kind} cannot be discovered`, undefined, {
        provider: 'digitalocean',
        reason: 'discover',
      });
    return found.discover(this.#env, context);
  }

  async adopt(
    kind: string,
    id: string,
    labels: Readonly<Record<string, string>>,
    context: CallContext,
  ): Promise<ProviderResourceState> {
    const found = this.#kind(kind);
    if (!found.adopt)
      throw new ComputeError('UNSUPPORTED', `${kind} cannot be adopted`, undefined, {
        provider: 'digitalocean',
        reason: 'adopt',
      });
    return found.adopt(this.#env, id, labels, context);
  }

  async release(kind: string, id: string, context: CallContext): Promise<void> {
    const found = this.#kind(kind);
    if (!found.release)
      throw new ComputeError('UNSUPPORTED', `${kind} cannot be released`, undefined, {
        provider: 'digitalocean',
        reason: 'release',
      });
    await found.release(this.#env, id, context);
  }

  /** Managed Agents signals (a preview): read-only, refused with nothing sent unless the account enables previews. */
  async signals(context: CallContext): Promise<ProviderResourceSignal[]> {
    if (!this.#env.previews)
      throw new ComputeError(
        'UNSUPPORTED',
        'Managed Agents signals are a DigitalOcean preview; the account must enable previews',
        undefined,
        { provider: 'digitalocean', reason: 'preview' },
      );
    return doSignals(this.#env.client, context);
  }

  /** The 1-Click applications: Droplet images and DOKS add-ons, installed through those surfaces. */
  catalog(context: CallContext): Promise<ProviderCatalogEntry[]> {
    return oneClickCatalog(this.#env.client, context);
  }
}
