import {
  ComputeError,
  defineMethod,
  isId,
  type Json,
  type MethodDefinition,
  type ModuleContext,
  type Profile,
  type ProfileDocument,
  type Workflow,
  type WorkflowStep,
} from '@better-compute/core';
import { abortWorkflow, retryWorkflow, type EngineOptions, type StepRow, type WorkflowRow } from './engine.js';
import { expandProfile, type ExpansionIssue, type PlannedStep } from './expand.js';
import { createProfile, deleteProfile, profileSource, updateProfile } from './profiles.js';

// The `profiles` and `workflows` groups of PLAN.md §9.2 (v0.2 rows). Workflows start from other
// modules (metal deploy, release, …) through `ctx.workflows`; the API reads them and lets an
// operator abort or retry one.

const tenantPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const profileIdPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;

function fail(message: string): never {
  throw new ComputeError('INVALID_INPUT', message);
}
function object(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('The request must be an object');
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) fail(`Unknown field ${JSON.stringify(key)}`);
  return raw as Record<string, unknown>;
}
const tenant = (value: unknown): string =>
  typeof value === 'string' && tenantPattern.test(value) ? value : fail('tenantId is invalid');
const profileId = (value: unknown): string =>
  typeof value === 'string' && profileIdPattern.test(value) ? value : fail('profileId is invalid');
function positive(value: unknown, name: string, max = 1_000_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max)
    fail(`${name} must be an integer from 1 to ${max}`);
  return value;
}
function optionalPositive(value: unknown, name: string, max?: number): number | undefined {
  return value === undefined ? undefined : positive(value, name, max);
}
const nodeId = (value: unknown): string => (isId(value, 'node') ? value : fail('nodeId must be a node_ id'));
const workflowId = (value: unknown): string => (isId(value, 'wf') ? value : fail('workflowId must be a wf_ id'));
function visibility(value: unknown): 'private' | 'public' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'private' && value !== 'public') fail("visibility must be 'private' or 'public'");
  return value;
}
function cursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 256) fail('cursor is invalid');
  return value;
}

// --- Inputs and outputs --------------------------------------------------------------------------

export interface CreateProfileInput {
  tenantId: string;
  document: ProfileDocument;
  visibility?: 'private' | 'public';
}
export interface ProfileRefInput {
  tenantId: string;
  profileId: string;
  /** Defaults to the latest version. */
  profileVersion?: number;
}
export interface UpdateProfileInput {
  tenantId: string;
  profileId: string;
  profileVersion: number;
  document?: ProfileDocument;
  visibility?: 'private' | 'public';
  expectedVersion?: number;
}
export interface DeleteProfileInput {
  tenantId: string;
  profileId: string;
  /** Omitted: every version. */
  profileVersion?: number;
}
export interface ListProfilesInput {
  tenantId: string;
  limit?: number;
  cursor?: string;
}
export interface ProfileValidation {
  valid: boolean;
  issues: ExpansionIssue[];
}
/** What `profiles.render` returns: the steps a workflow of this profile would run. */
export interface RenderedProfile {
  profile: ProfileDocument;
  steps: PlannedStep[];
}

export interface WorkflowRefInput {
  tenantId: string;
  nodeId: string;
  workflowId: string;
}
export interface ListWorkflowsInput {
  tenantId: string;
  nodeId: string;
  limit?: number;
  cursor?: string;
}
export interface AbortWorkflowInput extends WorkflowRefInput {
  reason?: string;
}
export interface RetryWorkflowInput extends WorkflowRefInput {
  /** Defaults to the first main step that did not succeed. */
  fromStep?: string;
}
/** A workflow with its steps, as `workflows.get` returns it. */
export interface WorkflowView extends Workflow {
  outcome?: 'failed' | 'cancelled';
  error?: Json;
  createdAt: number;
  finishedAt?: number;
  steps: (WorkflowStep & { phase: PlannedStep['phase']; startedAt?: number; finishedAt?: number; error?: Json })[];
}

export type ProvisionApi = {
  profiles: {
    create: MethodDefinition<CreateProfileInput, Profile>;
    get: MethodDefinition<ProfileRefInput, Profile>;
    validate: MethodDefinition<ProfileRefInput, ProfileValidation>;
    render: MethodDefinition<ProfileRefInput, RenderedProfile>;
    list: MethodDefinition<ListProfilesInput, { items: Profile[]; cursor?: string }>;
    update: MethodDefinition<UpdateProfileInput, Profile>;
    delete: MethodDefinition<DeleteProfileInput, { deleted: number }>;
  };
  workflows: {
    get: MethodDefinition<WorkflowRefInput, WorkflowView>;
    list: MethodDefinition<ListWorkflowsInput, { items: WorkflowView[]; cursor?: string }>;
    abort: MethodDefinition<AbortWorkflowInput, WorkflowView>;
    retry: MethodDefinition<RetryWorkflowInput, WorkflowView>;
  };
};

// --- Views -----------------------------------------------------------------------------------------

type WorkflowDbRow = WorkflowRow & { created_at: Date; finished_at: Date | null };

function workflowView(row: WorkflowDbRow, steps: StepRow[]): WorkflowView {
  const view: WorkflowView = {
    id: row.id,
    tenantId: row.tenant_id,
    profileId: row.profile_id,
    profileVersion: Number(row.profile_version),
    state: row.state,
    version: Number(row.version),
    createdAt: row.created_at.getTime(),
    steps: steps.map((step) => {
      const out: WorkflowView['steps'][number] = {
        workflowId: step.workflow_id,
        id: step.id,
        index: step.index,
        phase: step.phase,
        action: step.action,
        runsOn: step.runs_on,
        args: step.args,
        state: step.state,
        attempt: step.attempt,
        idempotencyKey: step.idempotency_key,
      };
      if (step.driver) out.driver = step.driver;
      if (step.command_id) out.commandId = step.command_id;
      if (step.deadline) out.deadline = step.deadline.getTime();
      if (step.result !== null) out.result = step.result;
      if (step.await) out.await = step.await;
      if (step.started_at) out.startedAt = step.started_at.getTime();
      if (step.finished_at) out.finishedAt = step.finished_at.getTime();
      if (step.error !== null) out.error = step.error;
      return out;
    }),
  };
  if (row.node_id) view.nodeId = row.node_id;
  if (row.instance_id) view.instanceId = row.instance_id;
  if (row.step_id) view.stepId = row.step_id;
  if (row.outcome) view.outcome = row.outcome;
  if (row.error !== null) view.error = row.error;
  if (row.finished_at) view.finishedAt = row.finished_at.getTime();
  return view;
}

async function readWorkflow(context: ModuleContext, input: WorkflowRefInput): Promise<WorkflowView> {
  const { rows } = await context.sql.query<WorkflowDbRow>(
    'SELECT * FROM workflows WHERE id = $1 AND tenant_id = $2 AND node_id = $3',
    [input.workflowId, input.tenantId, input.nodeId],
  );
  if (!rows[0]) throw new ComputeError('NOT_FOUND', `Workflow ${input.workflowId} does not exist`);
  const steps = await context.sql.query<StepRow>('SELECT * FROM workflow_steps WHERE workflow_id = $1 ORDER BY index', [
    input.workflowId,
  ]);
  return workflowView(rows[0], steps.rows);
}

// --- The groups ------------------------------------------------------------------------------------

/** The `profiles` and `workflows` groups over one engine configuration. */
export function provisionApi(context: ModuleContext, options: EngineOptions & { moduleProfiles: readonly ProfileDocument[] }): ProvisionApi {
  const profiles = profileSource(options.moduleProfiles);
  const findProfile = async (input: ProfileRefInput) => {
    const found = await profiles.find(context.sql, input.tenantId, input.profileId, input.profileVersion);
    if (!found)
      throw new ComputeError('NOT_FOUND', `Profile ${input.profileId}${input.profileVersion ? `@${input.profileVersion}` : ''} does not exist`);
    return found;
  };
  const profileRef = (raw: unknown): ProfileRefInput => {
    const input = object(raw, ['tenantId', 'profileId', 'profileVersion']);
    const out: ProfileRefInput = { tenantId: tenant(input.tenantId), profileId: profileId(input.profileId) };
    const version = optionalPositive(input.profileVersion, 'profileVersion');
    if (version !== undefined) out.profileVersion = version;
    return out;
  };
  const profileResource = (input: { profileId: string }) => ({ type: 'profile', id: input.profileId });
  const workflowRef = (raw: unknown, extra: readonly string[] = []): WorkflowRefInput & Record<string, unknown> => {
    const input = object(raw, ['tenantId', 'nodeId', 'workflowId', ...extra]);
    return { ...input, tenantId: tenant(input.tenantId), nodeId: nodeId(input.nodeId), workflowId: workflowId(input.workflowId) };
  };
  const nodeResource = (input: { nodeId: string }) => ({ type: 'node', id: input.nodeId });

  return {
    profiles: {
      create: defineMethod<CreateProfileInput, Profile>({
        action: 'compute:profiles:manage',
        kind: 'mutation',
        resource: (input) => ({ type: 'tenant', id: input.tenantId }),
        validate(raw) {
          const input = object(raw, ['tenantId', 'document', 'visibility']);
          if (typeof input.document !== 'object' || input.document === null) fail('document must be a profile document');
          const out: CreateProfileInput = { tenantId: tenant(input.tenantId), document: input.document as ProfileDocument };
          const v = visibility(input.visibility);
          if (v) out.visibility = v;
          return out;
        },
        handler: (ctx, input) =>
          ctx.sql.transaction((tx) => createProfile(tx, ctx.authz, input.tenantId, input)),
      }),
      get: defineMethod<ProfileRefInput, Profile>({
        action: 'compute:profiles:read',
        kind: 'read',
        resource: profileResource,
        validate: profileRef,
        handler: (_ctx, input) => findProfile(input),
      }),
      validate: defineMethod<ProfileRefInput, ProfileValidation>({
        action: 'compute:profiles:read',
        kind: 'read',
        resource: profileResource,
        validate: profileRef,
        async handler(_ctx, input) {
          const { issues } = await expandProfile((await findProfile(input)).document, options.steps);
          return { valid: issues.length === 0, issues };
        },
      }),
      render: defineMethod<ProfileRefInput, RenderedProfile>({
        action: 'compute:profiles:read',
        kind: 'read',
        resource: profileResource,
        validate: profileRef,
        async handler(_ctx, input) {
          const profile = (await findProfile(input)).document;
          const { steps, issues } = await expandProfile(profile, options.steps);
          if (issues.length > 0)
            throw new ComputeError('INVALID_INPUT', `Profile ${profile.id}@${profile.version} does not resolve`, undefined, {
              issues: issues as unknown as Json,
            });
          return { profile, steps };
        },
      }),
      list: defineMethod<ListProfilesInput, { items: Profile[]; cursor?: string }>({
        action: 'compute:profiles:read',
        kind: 'read',
        resource: (input) => ({ type: 'tenant', id: input.tenantId }),
        validate(raw) {
          const input = object(raw, ['tenantId', 'limit', 'cursor']);
          const out: ListProfilesInput = { tenantId: tenant(input.tenantId) };
          const limit = optionalPositive(input.limit, 'limit', 200);
          if (limit !== undefined) out.limit = limit;
          const after = cursor(input.cursor);
          if (after !== undefined) out.cursor = after;
          return out;
        },
        handler: (ctx, input) =>
          profiles.list(ctx.sql, input.tenantId, { limit: input.limit ?? 50, ...(input.cursor ? { after: input.cursor } : {}) }),
      }),
      update: defineMethod<UpdateProfileInput, Profile>({
        action: 'compute:profiles:manage',
        kind: 'mutation',
        resource: profileResource,
        validate(raw) {
          const input = object(raw, ['tenantId', 'profileId', 'profileVersion', 'document', 'visibility', 'expectedVersion']);
          const out: UpdateProfileInput = {
            tenantId: tenant(input.tenantId),
            profileId: profileId(input.profileId),
            profileVersion: positive(input.profileVersion, 'profileVersion'),
          };
          if (input.document !== undefined) out.document = input.document as ProfileDocument;
          const v = visibility(input.visibility);
          if (v) out.visibility = v;
          const expected = optionalPositive(input.expectedVersion, 'expectedVersion', Number.MAX_SAFE_INTEGER);
          if (expected !== undefined) out.expectedVersion = expected;
          if (out.document === undefined && out.visibility === undefined) fail('Nothing to update: pass document or visibility');
          return out;
        },
        handler: (ctx, input) => ctx.sql.transaction((tx) => updateProfile(tx, ctx.authz, input.tenantId, input)),
      }),
      delete: defineMethod<DeleteProfileInput, { deleted: number }>({
        action: 'compute:profiles:manage',
        kind: 'mutation',
        resource: profileResource,
        validate: profileRef,
        handler: (ctx, input) => ctx.sql.transaction((tx) => deleteProfile(tx, ctx.authz, input.tenantId, input)),
      }),
    },
    workflows: {
      get: defineMethod<WorkflowRefInput, WorkflowView>({
        action: 'compute:workflows:read',
        kind: 'read',
        resource: nodeResource,
        validate: (raw) => workflowRef(raw),
        handler: (ctx, input) => readWorkflow(ctx, input),
      }),
      list: defineMethod<ListWorkflowsInput, { items: WorkflowView[]; cursor?: string }>({
        action: 'compute:workflows:read',
        kind: 'read',
        resource: nodeResource,
        validate(raw) {
          const input = object(raw, ['tenantId', 'nodeId', 'limit', 'cursor']);
          const out: ListWorkflowsInput = { tenantId: tenant(input.tenantId), nodeId: nodeId(input.nodeId) };
          const limit = optionalPositive(input.limit, 'limit', 100);
          if (limit !== undefined) out.limit = limit;
          const after = cursor(input.cursor);
          if (after !== undefined) out.cursor = after;
          return out;
        },
        async handler(ctx, input) {
          const limit = input.limit ?? 20;
          // Newest first; ids are ULIDs, so id order is creation order.
          const { rows } = await ctx.sql.query<WorkflowDbRow>(
            `SELECT * FROM workflows WHERE tenant_id = $1 AND node_id = $2 AND ($3::text IS NULL OR id < $3)
              ORDER BY id DESC LIMIT $4`,
            [input.tenantId, input.nodeId, input.cursor ?? null, limit + 1],
          );
          const page = rows.slice(0, limit);
          const steps = page.length
            ? (
                await ctx.sql.query<StepRow>('SELECT * FROM workflow_steps WHERE workflow_id = ANY($1) ORDER BY workflow_id, index', [
                  page.map((row) => row.id),
                ])
              ).rows
            : [];
          const items = page.map((row) => workflowView(row, steps.filter((step) => step.workflow_id === row.id)));
          return rows.length > limit ? { items, cursor: page.at(-1)!.id } : { items };
        },
      }),
      abort: defineMethod<AbortWorkflowInput, WorkflowView>({
        action: 'compute:workflows:manage',
        kind: 'mutation',
        resource: nodeResource,
        validate(raw) {
          const input = workflowRef(raw, ['reason']);
          if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 512))
            fail('reason must be a string of at most 512 characters');
          return input as AbortWorkflowInput;
        },
        async handler(ctx, input) {
          await readWorkflow(ctx, input);
          await ctx.sql.transaction((tx) =>
            abortWorkflow(ctx, tx, input.workflowId, { tenantId: input.tenantId, ...(input.reason ? { reason: input.reason } : {}) }),
          );
          return readWorkflow(ctx, input);
        },
      }),
      retry: defineMethod<RetryWorkflowInput, WorkflowView>({
        action: 'compute:workflows:manage',
        kind: 'mutation',
        resource: nodeResource,
        validate(raw) {
          const input = workflowRef(raw, ['fromStep']);
          if (input.fromStep !== undefined && (typeof input.fromStep !== 'string' || input.fromStep.length > 256))
            fail('fromStep must be a step id');
          return input as RetryWorkflowInput;
        },
        async handler(ctx, input) {
          await readWorkflow(ctx, input);
          await ctx.sql.transaction((tx) =>
            retryWorkflow(ctx, tx, input.workflowId, { tenantId: input.tenantId, ...(input.fromStep ? { fromStep: input.fromStep } : {}) }),
          );
          return readWorkflow(ctx, input);
        },
      }),
    },
  };
}
