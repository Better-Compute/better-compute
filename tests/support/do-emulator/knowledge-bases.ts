import { randomUUID } from 'node:crypto';
import type { DoEmulator, RouteContext } from './index.js';
import { seedDatabase } from './databases.js';
import { touchTags } from './tags.js';
import type { DoState, Json } from './state.js';

// GenAI knowledge bases with their data sources. Shapes follow the API reference (genai), not a recording: the live
// suite captures real bodies before release. A new knowledge base's database is CREATING for
// `emulator.knowledgeBaseReads` reads, then ONLINE; an indexing job (started at create and by
// POST /gen-ai/indexing_jobs) is INDEX_JOB_STATUS_RUNNING for as many reads, then INDEX_JOB_STATUS_COMPLETED. The list
// answers every knowledge base (no tag filter); names are unique per account. A create that names no `database_id`
// makes an OpenSearch database for the knowledge base (online at once), which stays when the knowledge base goes.

function kbBody(kb: Json): Json {
  const { _reads, _sources, _status, ...rest } = kb;
  return structuredClone(rest);
}

function observeKb(emulator: DoEmulator, kb: Json): void {
  const job = kb.last_indexing_job;
  if (kb._status === 'ONLINE' && job?.status !== 'INDEX_JOB_STATUS_RUNNING') return;
  kb._reads = (kb._reads ?? 0) + 1;
  if (kb._reads <= emulator.knowledgeBaseReads) return;
  kb._reads = 0;
  kb._status = 'ONLINE';
  if (job) job.status = 'INDEX_JOB_STATUS_COMPLETED';
}

function source(input: Json): Json | undefined {
  if (input?.spaces_data_source) {
    const spaces = input.spaces_data_source;
    if (typeof spaces.bucket_name !== 'string' || typeof spaces.region !== 'string')
      return undefined;
    return { uuid: randomUUID(), spaces_data_source: { ...spaces } };
  }
  if (input?.web_crawler_data_source) {
    const web = input.web_crawler_data_source;
    if (typeof web.base_url !== 'string') return undefined;
    return { uuid: randomUUID(), web_crawler_data_source: { ...web } };
  }
  return undefined;
}

/** Seeds a knowledge base made outside better-compute (online, one web source). */
export function seedKnowledgeBase(state: DoState, fields: Json = {}): Json {
  const uuid = randomUUID();
  const kb: Json = {
    uuid,
    name: `by-hand-${uuid.slice(0, 6)}`,
    region: 'tor1',
    embedding_model_uuid: '22653204-79ed-11ef-bf8f-4e013e2ddde4',
    database_id: randomUUID(),
    tags: [],
    created_at: new Date(state.now()).toISOString(),
    last_indexing_job: { uuid: randomUUID(), status: 'INDEX_JOB_STATUS_COMPLETED' },
    ...fields,
    _status: 'ONLINE',
    _sources: [
      {
        uuid: randomUUID(),
        web_crawler_data_source: { base_url: 'https://example.com/', crawling_option: 'SCOPED' },
      },
    ],
  };
  state.knowledgeBases.set(uuid, kb);
  return kb;
}

export function registerKnowledgeBases(emulator: DoEmulator): void {
  const list = /^\/gen-ai\/knowledge_bases$/;
  const one = /^\/gen-ai\/knowledge_bases\/([^/]+)$/;
  const sources = /^\/gen-ai\/knowledge_bases\/([^/]+)\/data_sources$/;
  const oneSource = /^\/gen-ai\/knowledge_bases\/([^/]+)\/data_sources\/([^/]+)$/;
  const kbOf = (context: RouteContext) =>
    context.state.knowledgeBases.get(decodeURIComponent(context.match[1]!));

  emulator.route('GET', list, (context) => {
    for (const kb of context.state.knowledgeBases.values()) observeKb(emulator, kb);
    return emulator.paged(
      context,
      'knowledge_bases',
      [...context.state.knowledgeBases.values()].map(kbBody),
    );
  });

  emulator.route('POST', list, (context) => {
    const input = context.body ?? {};
    if (
      typeof input.name !== 'string' ||
      typeof input.region !== 'string' ||
      typeof input.embedding_model_uuid !== 'string' ||
      !Array.isArray(input.datasources) ||
      input.datasources.length === 0
    )
      return emulator.error('422-unknown');
    const made = (input.datasources as Json[]).map(source);
    if (made.some((entry) => entry === undefined)) return emulator.error('422-unknown');
    if ([...context.state.knowledgeBases.values()].some((kb) => kb.name === input.name))
      return emulator.error('422-name-in-use');
    const tags = Array.isArray(input.tags) ? (input.tags as string[]) : [];
    touchTags(context.state, tags);
    const database =
      typeof input.database_id === 'string'
        ? input.database_id
        : seedDatabase(context.state, {
            name: `genai-${randomUUID().slice(0, 8)}`,
            engine: 'opensearch',
            version: '2',
            region: input.region,
            size: 'db-s-2vcpu-4gb',
          }).id;
    const kb = seedKnowledgeBase(context.state, {
      name: input.name,
      region: input.region,
      embedding_model_uuid: input.embedding_model_uuid,
      database_id: database,
      ...(typeof input.vpc_uuid === 'string' ? { vpc_uuid: input.vpc_uuid } : {}),
      tags,
      last_indexing_job: { uuid: randomUUID(), status: 'INDEX_JOB_STATUS_RUNNING' },
    });
    kb._status = 'CREATING';
    kb._sources = made;
    return { status: 200, body: { knowledge_base: kbBody(kb) } };
  });

  emulator.route('GET', one, (context) => {
    const kb = kbOf(context);
    if (!kb) return emulator.error('not-found');
    observeKb(emulator, kb);
    return { status: 200, body: { knowledge_base: kbBody(kb), database_status: kb._status } };
  });

  emulator.route('PUT', one, (context) => {
    const kb = kbOf(context);
    if (!kb) return emulator.error('not-found');
    const input = context.body ?? {};
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags)) return emulator.error('422-unknown');
      touchTags(context.state, input.tags);
      kb.tags = [...input.tags];
    }
    if (typeof input.name === 'string') kb.name = input.name;
    return { status: 200, body: { knowledge_base: kbBody(kb) } };
  });

  emulator.route('DELETE', one, (context) => {
    const kb = kbOf(context);
    if (!kb) return emulator.error('not-found');
    context.state.knowledgeBases.delete(kb.uuid);
    return { status: 200, body: { uuid: kb.uuid } };
  });

  emulator.route('GET', sources, (context) => {
    const kb = kbOf(context);
    if (!kb) return emulator.error('not-found');
    return emulator.paged(
      context,
      'knowledge_base_data_sources',
      structuredClone(kb._sources as Json[]),
    );
  });

  emulator.route('POST', sources, (context) => {
    const kb = kbOf(context);
    if (!kb) return emulator.error('not-found');
    const made = source(context.body ?? {});
    if (!made) return emulator.error('422-unknown');
    kb._sources.push(made);
    return { status: 200, body: { knowledge_base_data_source: structuredClone(made) } };
  });

  emulator.route('DELETE', oneSource, (context) => {
    const kb = kbOf(context);
    if (!kb) return emulator.error('not-found');
    const id = decodeURIComponent(context.match[2]!);
    const before = kb._sources.length;
    kb._sources = (kb._sources as Json[]).filter((entry) => entry.uuid !== id);
    if (kb._sources.length === before) return emulator.error('not-found');
    return { status: 200, body: { data_source_uuid: id, knowledge_base_uuid: kb.uuid } };
  });

  emulator.route('POST', /^\/gen-ai\/indexing_jobs$/, (context) => {
    const kb = context.state.knowledgeBases.get(String(context.body?.knowledge_base_uuid));
    if (!kb) return emulator.error('not-found');
    kb.last_indexing_job = { uuid: randomUUID(), status: 'INDEX_JOB_STATUS_RUNNING' };
    kb._reads = 0;
    return { status: 200, body: { job: structuredClone(kb.last_indexing_job) } };
  });
}
