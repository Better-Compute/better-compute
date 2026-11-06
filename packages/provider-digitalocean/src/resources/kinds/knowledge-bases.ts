import {
  ComputeError,
  field,
  isComputeError,
  manifest,
  type CallContext,
  type ProviderDiscoveredResource,
  type ProviderResourceRequest,
  type ProviderResourceState,
} from '@better-compute/core';
import { keyTag } from '../../ids.js';
import {
  assertOwned,
  found,
  managedBy,
  ownershipTags,
  ownTags,
  replaceRequired,
  strings,
  type DoKind,
  type DoKindEnv,
} from '../kind.js';

// Knowledge bases (`do.knowledge-base`, P8, Agent Platform): an embedding model over web and Spaces data sources,
// indexed into an OpenSearch database DigitalOcean makes (or one of the tenant's own). The data sources change in place:
// added and removed one by one, then one indexing job; the region, embedding model, database and VPC are a new
// knowledge base. Spaces buckets, a database and a VPC are account-wide objects, so only the tenant's own account may
// name them. Ownership by tags (DO-D5), idempotency by the key tag (DO-D4); adopt and release write and take off the
// ownership tags. No agents are deployed (DO-D21). Shapes follow the API reference (genai), not a recording.
//
// Deleting a knowledge base leaves the OpenSearch database DigitalOcean made for it: it holds the tenant's indexed
// data, and is removed (or kept) through the database's own resource.

export const knowledgeBaseKindName = 'do.knowledge-base';
/** One per knowledge base per hour while it exists. */
export const knowledgeBaseHoursMeter = 'do.knowledge-base.hours';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `<region>/<bucket>[/<path>]`. */
const spacesSource = /^([a-z]{3}[0-9])\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])(?:\/(.{0,1024}))?$/;

export interface KnowledgeBaseSpec {
  region: string;
  embeddingModel: string;
  webSources?: string[];
  spacesSources?: string[];
  database?: string;
  vpc?: string;
}

interface DoDataSource {
  uuid: string;
  spaces_data_source?: { bucket_name: string; item_path?: string; region: string } | null;
  web_crawler_data_source?: { base_url: string; crawling_option?: string } | null;
}

interface DoKnowledgeBase {
  uuid: string;
  name: string;
  region: string;
  embedding_model_uuid: string;
  database_id?: string | null;
  vpc_uuid?: string | null;
  tags?: string[] | null;
  created_at: string;
  last_indexing_job?: { uuid?: string; status?: string } | null;
}

const base = '/gen-ai/knowledge_bases';
const path = (id: string) => `${base}/${encodeURIComponent(id)}`;

/** A source as the spec names it: `web:<url>` or `spaces:<region>/<bucket>/<path>`, so lists compare as sets. */
function sourceKey(source: DoDataSource): string | undefined {
  if (source.web_crawler_data_source) return `web:${source.web_crawler_data_source.base_url}`;
  const spaces = source.spaces_data_source;
  if (spaces)
    return `spaces:${spaces.region}/${spaces.bucket_name}${spaces.item_path ? `/${spaces.item_path}` : ''}`;
  return undefined;
}

function wantedSources(spec: KnowledgeBaseSpec): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const url of spec.webSources ?? [])
    out.set(`web:${url}`, {
      web_crawler_data_source: { base_url: url, crawling_option: 'SCOPED' },
    });
  for (const entry of spec.spacesSources ?? []) {
    const match = spacesSource.exec(entry);
    if (!match) continue;
    out.set(`spaces:${entry}`, {
      spaces_data_source: {
        bucket_name: match[2],
        ...(match[3] ? { item_path: match[3] } : {}),
        region: match[1],
      },
    });
  }
  return out;
}

function specOf(kb: DoKnowledgeBase, sources: readonly DoDataSource[] | undefined) {
  const keys = (sources ?? []).map(sourceKey).filter((key): key is string => key !== undefined);
  const web = keys.filter((key) => key.startsWith('web:')).map((key) => key.slice(4));
  const spaces = keys.filter((key) => key.startsWith('spaces:')).map((key) => key.slice(7));
  return {
    region: kb.region,
    embeddingModel: kb.embedding_model_uuid,
    ...(web.length > 0 ? { webSources: web } : {}),
    ...(spaces.length > 0 ? { spacesSources: spaces } : {}),
    ...(kb.vpc_uuid ? { vpc: kb.vpc_uuid } : {}),
  };
}

function phase(
  databaseStatus: string | undefined,
  kb: DoKnowledgeBase,
): ProviderResourceState['state'] {
  const db = (databaseStatus ?? '').toUpperCase();
  if (db === 'ERROR' || db === 'FAILED') return 'error';
  if (db !== 'ONLINE') return 'pending';
  const job = (kb.last_indexing_job?.status ?? '').toUpperCase();
  if (job.endsWith('FAILED') || job.endsWith('ERROR')) return 'error';
  if (job.endsWith('RUNNING') || job.endsWith('PENDING') || job.endsWith('QUEUED'))
    return 'updating';
  return 'ready';
}

function state(
  kb: DoKnowledgeBase,
  databaseStatus: string | undefined,
  sources: readonly DoDataSource[] | undefined,
): ProviderResourceState {
  const current = phase(databaseStatus, kb);
  return {
    id: kb.uuid,
    state: current,
    ...(current === 'error'
      ? {
          message: `The knowledge base is ${databaseStatus ?? 'failed'} (${kb.last_indexing_job?.status ?? 'no job'})`,
        }
      : {}),
    outputs: strings({
      status: databaseStatus,
      indexing: kb.last_indexing_job?.status,
      databaseId: kb.database_id,
    }),
    usage: { [knowledgeBaseHoursMeter]: 1 },
    ...(sources !== undefined ? { spec: specOf(kb, sources) } : {}),
  };
}

async function read(env: DoKindEnv, id: string, signal: AbortSignal) {
  const reply = await found(() =>
    env.client.request<{ knowledge_base: DoKnowledgeBase; database_status?: string }>(
      'GET',
      path(id),
      {
        signal,
        budget: 'observe',
      },
    ),
  );
  return reply ? { kb: reply.knowledge_base, databaseStatus: reply.database_status } : undefined;
}

async function sourcesOf(env: DoKindEnv, id: string, signal: AbortSignal): Promise<DoDataSource[]> {
  const out: DoDataSource[] = [];
  for await (const source of env.client.pages<DoDataSource>(
    `${path(id)}/data_sources`,
    'knowledge_base_data_sources',
    {
      signal,
      budget: 'observe',
    },
  ))
    out.push(source);
  return out;
}

/** The oldest knowledge base carrying the key's tag that this deployment manages (the list has no tag filter). */
async function byKey(env: DoKindEnv, context: CallContext): Promise<DoKnowledgeBase | undefined> {
  const key = keyTag(context.idempotencyKey);
  const mine: DoKnowledgeBase[] = [];
  for await (const kb of env.client.pages<DoKnowledgeBase>(base, 'knowledge_bases', {
    signal: context.signal,
    budget: 'observe',
  }))
    if (
      (kb.tags ?? []).some((tag) => tag.toLowerCase() === key) &&
      managedBy(env, kb.tags) === 'this'
    )
      mine.push(kb);
  return mine.sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.uuid.localeCompare(b.uuid),
  )[0];
}

function accountWide(spec: unknown): string[] {
  const wanted = spec as Partial<KnowledgeBaseSpec> | undefined;
  return [
    ...((wanted?.spacesSources ?? []).length > 0 ? ['spacesSources'] : []),
    ...(wanted?.database !== undefined ? ['database'] : []),
    ...(wanted?.vpc !== undefined ? ['vpc'] : []),
  ];
}

export function knowledgeBaseKind(): DoKind {
  const what = (id: string) => `Knowledge base ${id}`;

  async function tags(env: DoKindEnv, kb: DoKnowledgeBase, next: string[], signal: AbortSignal) {
    await env.client.request('PUT', path(kb.uuid), {
      body: { uuid: kb.uuid, tags: next },
      signal,
      budget: 'mutate',
    });
  }

  return {
    definition: {
      kind: knowledgeBaseKindName,
      family: 'ai',
      description:
        'A DigitalOcean knowledge base: an embedding model over web and Spaces sources, indexed for retrieval',
      spec: manifest({
        region: field.string({ pattern: /^[a-z]{3}[0-9]$/ }).describe('Region slug, e.g. tor1'),
        embeddingModel: field.string({ pattern: uuid }).describe('The embedding model (its uuid)'),
        webSources: field
          .list(field.string({ pattern: /^https:\/\/[^\s]{1,2040}$/ }), { max: 20 })
          .optional()
          .describe('Web pages to crawl (https URLs; the crawl stays within each)'),
        spacesSources: field
          .list(field.string({ pattern: spacesSource }), { max: 20 })
          .optional()
          .describe("Spaces objects of the tenant's own account: <region>/<bucket>[/<path>]"),
        database: field
          .string({ pattern: uuid })
          .optional()
          .describe(
            "An OpenSearch database of the tenant's own account (default: DigitalOcean makes one)",
          ),
        vpc: field
          .string({ pattern: uuid })
          .optional()
          .describe("A VPC of the tenant's own account (refused on a shared account)"),
      }),
      outputs: ['status', 'indexing', 'databaseId'],
      regional: true,
      updatable: ['webSources', 'spacesSources'],
      meters: [{ meter: knowledgeBaseHoursMeter, unit: 'hour' }],
      accountWide,
    },

    async ensure(env, request: ProviderResourceRequest, context) {
      const wanted = request.spec as KnowledgeBaseSpec;
      const sources = wantedSources(wanted);
      if (sources.size === 0)
        throw new ComputeError(
          'INVALID_INPUT',
          `${knowledgeBaseKindName}: name at least one web or Spaces source`,
          undefined,
          {
            provider: 'digitalocean',
            reason: 'dataSources',
            fields: ['webSources', 'spacesSources'],
          },
        );
      const reaching = accountWide(wanted);
      if (reaching.length > 0 && request.accountScope !== 'tenant')
        throw new ComputeError(
          'INVALID_INPUT',
          `${knowledgeBaseKindName}: ${reaching[0]} is account-wide; only a knowledge base on the tenant's own account may name it`,
          undefined,
          { provider: 'digitalocean', reason: 'accountWide', fields: reaching },
        );
      let kb: DoKnowledgeBase | undefined;
      let databaseStatus: string | undefined;
      if (request.id !== undefined) {
        const current = await read(env, request.id, context.signal);
        if (!current)
          return {
            id: request.id,
            state: 'error',
            message: `${what(request.id)} is gone at DigitalOcean`,
          };
        ({ kb, databaseStatus } = current);
        assertOwned(env, kb.tags, what(kb.uuid));
      } else {
        const keyed = await byKey(env, context);
        if (keyed)
          ({ kb, databaseStatus } = (await read(env, keyed.uuid, context.signal)) ?? { kb: keyed });
      }
      if (!kb) {
        try {
          const created = await env.client.request<{ knowledge_base: DoKnowledgeBase }>(
            'POST',
            base,
            {
              body: {
                name: request.name,
                region: wanted.region,
                embedding_model_uuid: wanted.embeddingModel,
                datasources: [...sources.values()],
                ...(wanted.database !== undefined ? { database_id: wanted.database } : {}),
                ...(wanted.vpc !== undefined ? { vpc_uuid: wanted.vpc } : {}),
                tags: ownershipTags(env, request.labels, context),
              },
              signal: context.signal,
              budget: 'mutate',
            },
          );
          return state(created.knowledge_base, undefined, undefined);
        } catch (error) {
          // The name is taken: a racing create of ours made it (its key tag finds it), or it is someone else's.
          if (!isComputeError(error, 'CONFLICT')) throw error;
          const keyed = await byKey(env, context);
          if (!keyed) throw error;
          ({ kb, databaseStatus } = (await read(env, keyed.uuid, context.signal)) ?? { kb: keyed });
        }
      }
      if (wanted.region !== kb.region) throw replaceRequired(knowledgeBaseKindName, 'region');
      if (wanted.embeddingModel !== kb.embedding_model_uuid)
        throw replaceRequired(knowledgeBaseKindName, 'embeddingModel');
      if (wanted.database !== undefined && wanted.database !== kb.database_id)
        throw replaceRequired(knowledgeBaseKindName, 'database');
      if ((wanted.vpc ?? null) !== (kb.vpc_uuid ?? null))
        throw replaceRequired(knowledgeBaseKindName, 'vpc');
      const have = await sourcesOf(env, kb.uuid, context.signal);
      const current = state(kb, databaseStatus, have);
      if (current.state !== 'ready') return current;
      const haveKeys = new Map(have.map((source) => [sourceKey(source), source]));
      const add = [...sources.entries()].filter(([key]) => !haveKeys.has(key));
      const remove = have.filter((source) => {
        const key = sourceKey(source);
        return key !== undefined && !sources.has(key);
      });
      if (add.length === 0 && remove.length === 0) return current;
      for (const [, body] of add)
        await env.client.request('POST', `${path(kb.uuid)}/data_sources`, {
          body,
          signal: context.signal,
          budget: 'mutate',
        });
      for (const source of remove)
        await found(() =>
          env.client.request(
            'DELETE',
            `${path(kb.uuid)}/data_sources/${encodeURIComponent(source.uuid)}`,
            {
              signal: context.signal,
              budget: 'mutate',
            },
          ),
        );
      await env.client.request('POST', '/gen-ai/indexing_jobs', {
        body: { knowledge_base_uuid: kb.uuid },
        signal: context.signal,
        budget: 'mutate',
      });
      return { ...current, state: 'updating', spec: specOf(kb, [...sources.keys()].map(fromKey)) };
    },

    async get(env, id, context) {
      const current = await read(env, id, context.signal);
      if (!current) return undefined;
      const sources = await sourcesOf(env, id, context.signal);
      return {
        ...state(current.kb, current.databaseStatus, sources),
        managedBy: managedBy(env, current.kb.tags) ?? 'none',
      };
    },

    async delete(env, id, context) {
      const current = await read(env, id, context.signal);
      if (!current) return { id, state: 'deleted' };
      assertOwned(env, current.kb.tags, what(id));
      await found(() =>
        env.client.request('DELETE', path(id), { signal: context.signal, budget: 'mutate' }),
      );
      return { id, state: 'deleting' };
    },

    async *discover(env, context): AsyncIterable<ProviderDiscoveredResource> {
      for await (const kb of env.client.pages<DoKnowledgeBase>(base, 'knowledge_bases', {
        signal: context.signal,
        budget: 'sweep',
      })) {
        const owner = managedBy(env, kb.tags);
        yield {
          id: kb.uuid,
          name: kb.name,
          region: kb.region,
          ...(owner !== undefined ? { managedBy: owner } : {}),
        };
      }
    },

    async adopt(env, id, labels, context) {
      const current = await read(env, id, context.signal);
      if (!current) throw new ComputeError('NOT_FOUND', `${what(id)} not found`);
      if (managedBy(env, current.kb.tags) === 'other')
        throw new ComputeError(
          'INVALID_STATE',
          `${what(id)} is managed by another deployment`,
          undefined,
          {
            provider: 'digitalocean',
            reason: 'managedByAnother',
          },
        );
      const have = current.kb.tags ?? [];
      const next = [
        ...have,
        ...ownershipTags(env, labels, context).filter(
          (tag) => !have.some((entry) => entry.toLowerCase() === tag),
        ),
      ];
      await tags(env, current.kb, next, context.signal);
      const sources = await sourcesOf(env, id, context.signal);
      return state({ ...current.kb, tags: next }, current.databaseStatus, sources);
    },

    async release(env, id, context) {
      const current = await read(env, id, context.signal);
      if (!current) return;
      const own = new Set(ownTags(current.kb.tags).map((tag) => tag.toLowerCase()));
      if (own.size === 0) return;
      await tags(
        env,
        current.kb,
        (current.kb.tags ?? []).filter((tag) => !own.has(tag.toLowerCase())),
        context.signal,
      );
    },
  };
}

/** A data source from its spec key (to report the spec a change is converging to). */
function fromKey(key: string): DoDataSource {
  if (key.startsWith('web:'))
    return { uuid: '', web_crawler_data_source: { base_url: key.slice(4) } };
  const match = spacesSource.exec(key.slice(7))!;
  return {
    uuid: '',
    spaces_data_source: {
      region: match[1]!,
      bucket_name: match[2]!,
      ...(match[3] ? { item_path: match[3] } : {}),
    },
  };
}
