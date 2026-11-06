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
import { seedGuardrail } from './support/do-emulator/guardrails.js';
import { seedDatabase } from './support/do-emulator/databases.js';
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

  it('a reindex whose start failed after the sources changed is started on the next ensure, exactly once', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const ready = await settle(resources, request());
    const changed = { ...kbSpec, webSources: ['https://blog.example.com/'] };
    emu.failNext({ method: 'POST', path: /^\/gen-ai\/indexing_jobs$/ }, 503, {
      id: 'service_unavailable',
      message: 'try again later',
    });
    await failure(resources.ensure(request({ id: ready.id, spec: changed }), call()));
    // The sources changed at DigitalOcean; the job did not start.
    const kb = emu.state.knowledgeBases.get(ready.id)!;
    expect(kb._sources.map((source: any) => source.web_crawler_data_source.base_url)).toEqual([
      'https://blog.example.com/',
    ]);
    expect(kb.last_indexing_job.status).toBe('INDEX_JOB_STATUS_COMPLETED');
    // The next run has nothing to add or remove, and still starts the job.
    const retried = await resources.ensure(request({ id: ready.id, spec: changed }), call());
    expect(retried.state).toBe('updating');
    expect(emu.state.knowledgeBases.get(ready.id)!.last_indexing_job.status).toBe(
      'INDEX_JOB_STATUS_RUNNING',
    );
    const after = await settle(resources, request({ id: ready.id, spec: changed }));
    expect(after).toMatchObject({ state: 'ready', spec: changed });
    // One failed start, one job: nothing more once it is indexed.
    expect(mutations(emu, 'POST', /indexing_jobs$/)).toHaveLength(2);
    await resources.ensure(request({ id: ready.id, spec: changed }), call());
    expect(mutations(emu, 'POST', /indexing_jobs$/)).toHaveLength(2);
    expect(mutations(emu, 'POST', /data_sources$/)).toHaveLength(1);
    expect(mutations(emu, 'DELETE', /data_sources\//)).toHaveLength(1);
  });

  it('delete removes the OpenSearch database DigitalOcean made for it, after the knowledge base', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const ready = await settle(resources, request());
    const made = emu.state.knowledgeBases.get(ready.id)!.database_id as string;
    expect(emu.state.databases.get(made)?.engine).toBe('opensearch');
    let state = await resources.delete('do.knowledge-base', ready.id, call());
    for (let round = 0; round < 5 && state.state !== 'deleted'; round++)
      state = await resources.delete('do.knowledge-base', ready.id, call());
    expect(state.state).toBe('deleted');
    expect(emu.state.knowledgeBases.has(ready.id)).toBe(false);
    expect(emu.state.databases.has(made)).toBe(false);
    expect(mutations(emu, 'DELETE', /\/databases\//).map((r) => r.url.pathname)).toEqual([
      expect.stringMatching(new RegExp(`/databases/${made}$`)),
    ]);
    // Deleting again sends nothing more.
    expect((await resources.delete('do.knowledge-base', ready.id, call())).state).toBe('deleted');
    expect(mutations(emu, 'DELETE', /\/databases\//)).toHaveLength(1);
  });

  it('delete leaves a database the tenant named, one another resource manages, or one another knowledge base uses', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const drain = async (id: string) => {
      let state = await resources.delete('do.knowledge-base', id, call());
      for (let round = 0; round < 5 && state.state !== 'deleted'; round++)
        state = await resources.delete('do.knowledge-base', id, call());
      return state;
    };
    // Named in the spec (the tenant's own account): the tenant's database, never removed.
    const named = seedDatabase(emu.state, { engine: 'opensearch', region: 'tor1' });
    const own = await settle(
      resources,
      request({ accountScope: 'tenant', spec: { ...kbSpec, database: named.id } }),
    );
    expect((await drain(own.id)).state).toBe('deleted');
    expect(emu.state.databases.has(named.id)).toBe(true);
    // Made by DigitalOcean, but since taken over as a cloud resource of its own: left to that resource.
    const adopted = await settle(resources, request());
    const adoptedDb = emu.state.knowledgeBases.get(adopted.id)!.database_id as string;
    emu.state.databases.get(adoptedDb)!.tags = [managedTag, deploymentTag('default')];
    expect((await drain(adopted.id)).state).toBe('deleted');
    expect(emu.state.databases.has(adoptedDb)).toBe(true);
    // Made by DigitalOcean, and used by another knowledge base too: left alone.
    const shared = await settle(resources, request({ name: 'bc-r-kb2' }));
    const sharedDb = emu.state.knowledgeBases.get(shared.id)!.database_id as string;
    seedKnowledgeBase(emu.state, { database_id: sharedDb });
    expect((await drain(shared.id)).state).toBe('deleted');
    expect(emu.state.databases.has(sharedDb)).toBe(true);
    expect(mutations(emu, 'DELETE', /\/databases\//)).toEqual([]);
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

const guardrailSpec = { type: 'jailbreak', defaultResponse: 'I cannot help with that request.' };

describe('ProviderResources conformance: do.guardrail', () => {
  const subject = (): ProviderResourcesConformanceSubject => {
    const emu = emulator();
    const unmanaged = seedGuardrail(emu.state);
    return {
      provider: digitaloceanProvider({ fetch: emu.fetch }),
      config: doAccount,
      context: { secrets, account: platformAccount },
      kind: 'do.guardrail',
      spec: guardrailSpec,
      updatedSpec: { ...guardrailSpec, defaultResponse: 'No.' },
      replaceSpec: { ...guardrailSpec, type: 'content-moderation' },
      unmanaged: unmanaged.uuid,
    };
  };
  for (const test of providerResourcesConformanceCases())
    it(test.name, async () => {
      freshBudgets();
      await test.run(subject());
    });
});

describe('do.guardrail', () => {
  const hash = deploymentTag('default').split(':')[1]!;
  const request = (extra: Record<string, unknown> = {}) => ({
    kind: 'do.guardrail',
    name: 'bc-r-guard',
    spec: guardrailSpec,
    labels,
    ...extra,
  });
  const call = (key = 'crs_guard'): CallContext => ctx(key);

  it('is an account-level ai kind; the response and description change in place', async () => {
    const { resources } = await build(emulator());
    const kind = resources.kinds().find((entry) => entry.kind === 'do.guardrail')!;
    expect(kind).toMatchObject({
      family: 'ai',
      regional: false,
      outputs: ['type'],
      updatable: ['defaultResponse', 'description'],
    });
    expect(kind.quota).toBeUndefined();
    expect(kind.secretOutputs ?? []).toEqual([]);
  });

  it('creates a guardrail named for this deployment; a retry finds it by name and sends nothing', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const created = await resources.ensure(request(), call());
    expect(created).toMatchObject({
      state: 'ready',
      outputs: { type: 'GUARDRAIL_TYPE_JAILBREAK' },
      spec: guardrailSpec,
    });
    expect(mutations(emu, 'POST', /guardrails$/).map((r) => r.body)).toEqual([
      {
        name: `bc-r-guard-bc${hash}`,
        type: 'GUARDRAIL_TYPE_JAILBREAK',
        default_response: 'I cannot help with that request.',
      },
    ]);
    expect((await resources.ensure(request(), call())).id).toBe(created.id);
    expect((await resources.ensure(request({ id: created.id }), call())).state).toBe('ready');
    expect(mutations(emu, 'POST', /guardrails/)).toHaveLength(1);
    expect(mutations(emu, 'PUT', /guardrails/)).toEqual([]);
    expect((await resources.get('do.guardrail', created.id, call()))?.managedBy).toBe('this');
  });

  it('a response or description change is one PUT; the type is replaceRequired with nothing sent', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const created = await resources.ensure(request(), call());
    const changed = { ...guardrailSpec, defaultResponse: 'No.', description: 'Blocks jailbreaks' };
    const updated = await resources.ensure(request({ id: created.id, spec: changed }), call());
    expect(updated).toMatchObject({ state: 'ready', spec: changed });
    expect(mutations(emu, 'PUT', /guardrails\//).map((r) => r.body)).toEqual([
      { default_response: 'No.', description: 'Blocks jailbreaks' },
    ]);
    const error = await failure(
      resources.ensure(
        request({ id: created.id, spec: { ...guardrailSpec, type: 'sensitive-data' } }),
        call(),
      ),
    );
    expect(error.details).toMatchObject({ reason: 'replaceRequired', field: 'type' });
    expect(mutations(emu, 'PUT', /guardrails\//)).toHaveLength(1);
  });

  it('a guardrail gone at DigitalOcean is an error state, not a silent re-create', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const created = await resources.ensure(request(), call());
    emu.state.guardrails.delete(created.id);
    const state = await resources.ensure(request({ id: created.id }), call());
    expect(state.state).toBe('error');
    expect(mutations(emu, 'POST', /guardrails/)).toHaveLength(1);
  });

  it('leaves guardrails made by hand or by another deployment alone; discover says whose they are', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const byHand = seedGuardrail(emu.state);
    const foreign = seedGuardrail(emu.state, {
      name: 'bc-r-guard-bc0123456789ab',
      type: 'GUARDRAIL_TYPE_SENSITIVE_DATA',
    });
    // A guardrail of another deployment with the same base name is not this one's.
    const created = await resources.ensure(request(), call());
    expect(created.id).not.toBe(foreign.uuid);
    for (const id of [byHand.uuid, foreign.uuid])
      expect((await failure(resources.delete('do.guardrail', id, call()))).details?.reason).toBe(
        'notManaged',
      );
    expect(mutations(emu, 'DELETE', /guardrails/)).toEqual([]);
    const seen: Record<string, unknown>[] = [];
    for await (const entry of resources.discover!('do.guardrail', call()))
      seen.push(entry as unknown as Record<string, unknown>);
    expect(seen.find((entry) => entry.id === byHand.uuid)).not.toHaveProperty('managedBy');
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: byHand.uuid,
          spec: expect.objectContaining({ type: 'jailbreak' }),
        }),
        expect.objectContaining({
          id: foreign.uuid,
          managedBy: 'other',
          spec: expect.objectContaining({ type: 'sensitive-data' }),
        }),
        expect.objectContaining({ id: created.id, managedBy: 'this' }),
      ]),
    );
  });

  it('an unknown type, an empty or an over-long response never validates', async () => {
    const { resources } = await build(emulator());
    const kind = resources.kinds().find((entry) => entry.kind === 'do.guardrail')!;
    for (const spec of [
      { type: 'prompt-injection', defaultResponse: 'x' },
      { type: 'jailbreak', defaultResponse: 'x'.repeat(1001) },
      { type: 'jailbreak', defaultResponse: '' },
    ])
      expect((await kind.spec['~standard'].validate(spec)).issues).toBeDefined();
  });
});
