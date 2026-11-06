import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type CallContext, type ComputeError } from '@better-compute/core';
import {
  providerResourcesConformanceCases,
  type ProviderResourcesConformanceSubject,
} from '@better-compute/vps';
import {
  deploymentTag,
  digitaloceanProvider,
  keyTag,
  managedTag,
  tagFor,
} from '@better-compute/provider-digitalocean';
import { seedKnowledgeBase } from './support/do-emulator/knowledge-bases.js';
import { DoEmulator, type RecordedRequest } from './support/do-emulator/index.js';
import {
  build,
  ctx,
  doAccount,
  freshBudgets,
  platformAccount,
  secrets,
} from './support/do-harness.js';

// provider-digitalocean's Agent Platform kinds (P8 task 4) against the emulator. Knowledge bases: an embedding model
// over web and Spaces data sources, indexed into an OpenSearch database; the sources change in place (and reindex),
// anything else is a new knowledge base. No agents are deployed (DO-D21: the ADK is deprecated).

const t0 = Date.parse('2026-11-05T10:00:00Z');
const emulator = () => new DoEmulator({ now: () => t0 });
const labels = {
  'better-compute-managed': 'true',
  'better-compute-resource': 'crs_kb',
  'better-compute-tenant': 'acme',
};
const mutations = (emu: DoEmulator, method: string, path: RegExp): RecordedRequest[] =>
  emu.requests.filter((r) => r.method === method && path.test(r.url.pathname));

async function failure(promise: Promise<unknown>): Promise<ComputeError> {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

beforeEach(freshBudgets);

const model = '22653204-79ed-11ef-bf8f-4e013e2ddde4';
const kbSpec = {
  region: 'tor1',
  embeddingModel: model,
  webSources: ['https://docs.example.com/'],
};

describe('ProviderResources conformance: do.knowledge-base', () => {
  const subject = (): ProviderResourcesConformanceSubject => {
    const emu = emulator();
    const unmanaged = seedKnowledgeBase(emu.state);
    return {
      provider: digitaloceanProvider({ fetch: emu.fetch }),
      config: { ...doAccount, regions: ['tor1'] },
      context: { secrets, account: platformAccount },
      kind: 'do.knowledge-base',
      spec: kbSpec,
      updatedSpec: { ...kbSpec, webSources: [...kbSpec.webSources, 'https://blog.example.com/'] },
      replaceSpec: { ...kbSpec, embeddingModel: '05700391-7aa8-11ef-bf8f-4e013e2ddde4' },
      unmanaged: unmanaged.uuid,
    };
  };
  for (const test of providerResourcesConformanceCases())
    it(test.name, async () => {
      freshBudgets();
      await test.run(subject());
    });
});

describe('do.knowledge-base', () => {
  const request = (extra: Record<string, unknown> = {}) => ({
    kind: 'do.knowledge-base',
    name: 'bc-r-kb',
    spec: kbSpec,
    labels,
    ...extra,
  });
  const call = (key = 'crs_kb'): CallContext => ctx(key);
  async function settle(resources: any, req: any) {
    let state = await resources.ensure(req, call());
    for (let round = 0; round < 10 && !['ready', 'error'].includes(state.state); round++)
      state = await resources.ensure({ ...req, id: state.id }, call());
    return state;
  }

  it('is an ai kind; its sources change in place; Spaces sources, a database and a VPC are account-wide', async () => {
    const { resources } = await build(emulator());
    const kind = resources.kinds().find((entry) => entry.kind === 'do.knowledge-base')!;
    expect(kind).toMatchObject({
      family: 'ai',
      regional: true,
      updatable: ['webSources', 'spacesSources'],
      outputs: ['status', 'indexing', 'databaseId'],
    });
    expect(kind.accountWide!(kbSpec)).toEqual([]);
    expect(
      kind.accountWide!({
        ...kbSpec,
        spacesSources: ['nyc3/docs-bucket/guides/'],
        database: '5a4981aa-9653-4bd1-bef5-d6bff52042e4',
      }),
    ).toEqual(['spacesSources', 'database']);
  });

  it('creates with the ownership tags and its sources; ready once the database is online and indexed', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const first = await resources.ensure(request(), call());
    expect(first.state).toBe('pending');
    expect(mutations(emu, 'POST', /knowledge_bases$/)[0]!.body).toEqual({
      name: 'bc-r-kb',
      region: 'tor1',
      embedding_model_uuid: model,
      datasources: [
        {
          web_crawler_data_source: {
            base_url: 'https://docs.example.com/',
            crawling_option: 'SCOPED',
          },
        },
      ],
      tags: expect.arrayContaining([
        managedTag,
        deploymentTag('default'),
        keyTag('crs_kb'),
        tagFor('better-compute-resource', 'crs_kb'),
      ]),
    });
    const ready = await settle(resources, request({ id: first.id }));
    const kb = emu.state.knowledgeBases.get(first.id)!;
    expect(ready).toMatchObject({
      state: 'ready',
      outputs: {
        status: 'ONLINE',
        indexing: 'INDEX_JOB_STATUS_COMPLETED',
        databaseId: kb.database_id,
      },
      usage: { 'do.knowledge-base.hours': 1 },
      spec: kbSpec,
    });
    // A retry without the id finds it by its key tag.
    expect((await resources.ensure(request(), call())).id).toBe(first.id);
    expect(mutations(emu, 'POST', /knowledge_bases$/)).toHaveLength(1);
  });

  it('a source change adds and removes data sources, then reindexes; the embedding model is replaceRequired', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const ready = await settle(resources, request());
    const changed = { ...kbSpec, webSources: ['https://blog.example.com/'] };
    const updating = await resources.ensure(request({ id: ready.id, spec: changed }), call());
    expect(updating.state).toBe('updating');
    expect(mutations(emu, 'POST', /data_sources$/).map((r) => r.body)).toEqual([
      {
        web_crawler_data_source: {
          base_url: 'https://blog.example.com/',
          crawling_option: 'SCOPED',
        },
      },
    ]);
    expect(mutations(emu, 'DELETE', /data_sources\//)).toHaveLength(1);
    expect(mutations(emu, 'POST', /indexing_jobs$/).map((r) => r.body)).toEqual([
      { knowledge_base_uuid: ready.id },
    ]);
    const after = await settle(resources, request({ id: ready.id, spec: changed }));
    expect(after.state).toBe('ready');
    expect(after.spec).toEqual(changed);
    expect(mutations(emu, 'POST', /indexing_jobs$/)).toHaveLength(1);
    const error = await failure(
      resources.ensure(
        request({
          id: ready.id,
          spec: { ...kbSpec, embeddingModel: '05700391-7aa8-11ef-bf8f-4e013e2ddde4' },
        }),
        call(),
      ),
    );
    expect(error.details).toMatchObject({ reason: 'replaceRequired', field: 'embeddingModel' });
  });

  it('refuses before any call: no sources, and an account-wide source on a shared account', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const none = await failure(
      resources.ensure(request({ spec: { region: 'tor1', embeddingModel: model } }), call()),
    );
    expect(none.details?.reason).toBe('dataSources');
    const spaces = await failure(
      resources.ensure(
        request({ spec: { ...kbSpec, spacesSources: ['nyc3/docs-bucket/guides/'] } }),
        call(),
      ),
    );
    expect(spaces.details?.reason).toBe('accountWide');
    expect(mutations(emu, 'POST', /knowledge_bases/)).toEqual([]);
    // On the tenant's own account a Spaces source goes through.
    await resources.ensure(
      request({
        accountScope: 'tenant',
        spec: { ...kbSpec, spacesSources: ['nyc3/docs-bucket/guides/'] },
      }),
      call(),
    );
    expect(mutations(emu, 'POST', /knowledge_bases$/)[0]!.body.datasources).toContainEqual({
      spaces_data_source: { bucket_name: 'docs-bucket', item_path: 'guides/', region: 'nyc3' },
    });
  });

  it('delete leaves a knowledge base made by hand or by another deployment alone; adopt and release by tags', async () => {
    const emu = emulator();
    const { resources } = await build(emu, { ...doAccount, regions: ['tor1'] });
    const byHand = seedKnowledgeBase(emu.state);
    const foreign = seedKnowledgeBase(emu.state, {
      tags: [managedTag, 'better-compute-deployment:0123456789ab'],
    });
    for (const id of [byHand.uuid, foreign.uuid])
      expect(
        (await failure(resources.delete('do.knowledge-base', id, call()))).details?.reason,
      ).toBe('notManaged');
    expect(mutations(emu, 'DELETE', /knowledge_bases/)).toEqual([]);
    expect(
      (await failure(resources.adopt!('do.knowledge-base', foreign.uuid, labels, call()))).details
        ?.reason,
    ).toBe('managedByAnother');
    const adopted = await resources.adopt!('do.knowledge-base', byHand.uuid, labels, call());
    expect(adopted.spec).toEqual({
      region: 'tor1',
      embeddingModel: byHand.embedding_model_uuid,
      webSources: ['https://example.com/'],
    });
    expect(adopted.outputs?.databaseId).toBe(byHand.database_id);
    expect(emu.state.knowledgeBases.get(byHand.uuid)!.tags).toEqual(
      expect.arrayContaining([managedTag, deploymentTag('default')]),
    );
    await resources.release!('do.knowledge-base', byHand.uuid, call());
    expect(emu.state.knowledgeBases.get(byHand.uuid)!.tags).toEqual([]);
  });
});
