import {
  ComputeError,
  defineMethod,
  type MethodDefinition,
  type Project,
  type SqlTx,
} from '@better-compute/core';
import { defineListMethod, type ListRecipe } from '../list.js';
import {
  admittedOf,
  derivedId,
  fields,
  int,
  keyReused,
  limit,
  notFound,
  page,
  visibleIn,
  type Page,
} from './common.js';
import { parser, v } from './input.js';

// `projects` (PLAN.md §9.2, module server): an app-owned grouping of a tenant's work. `create` is
// idempotent per (tenant, caller identity, key) and decided on the tenant; `get` on the project;
// `list` follows the list recipe.

export interface CreateProjectInput {
  tenantId: string;
  /** DNS-label style (`ml-research`), unique in the tenant. */
  name: string;
  idempotencyKey: string;
}
export interface GetProjectInput {
  tenantId: string;
  projectId: string;
}
export interface ListProjectsInput {
  tenantId: string;
  state?: Project['state'];
  /** At most 50 (the default). */
  limit?: number;
  cursor?: string;
}

export type ProjectsApi = {
  projects: {
    create: MethodDefinition<CreateProjectInput, Project>;
    get: MethodDefinition<GetProjectInput, Project>;
    list: MethodDefinition<ListProjectsInput, Page<Project>>;
    /** (v0.2) Marks the project archived; archiving an archived project returns it unchanged. */
    archive: MethodDefinition<GetProjectInput, Project>;
  };
};

const createInput: (input: unknown) => CreateProjectInput = parser({
  tenantId: fields.tenantId,
  name: v.string({ pattern: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, max: 63 }),
  idempotencyKey: fields.idempotencyKey,
});
const getInput: (input: unknown) => GetProjectInput = parser({
  tenantId: fields.tenantId,
  projectId: fields.projectId,
});
const listInput: (input: unknown) => ListProjectsInput = parser({
  tenantId: fields.tenantId,
  state: v.optional(v.option(['active', 'archived'])),
  limit: limit(50),
  cursor: v.optional(fields.cursor),
});

interface ProjectRow {
  id: string;
  tenant_id: string;
  name: string;
  state: Project['state'];
  version: unknown;
}
const columns = 'p.id, p.tenant_id, p.name, p.state, p.version';

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  state: row.state,
  version: int(row.version),
});

async function findProject(tx: SqlTx, tenantId: string, id: string): Promise<Project | undefined> {
  const { rows } = await tx.query<ProjectRow>(
    `SELECT ${columns} FROM projects p WHERE p.id = $1 AND p.tenant_id = $2`,
    [id, tenantId],
  );
  return rows[0] && toProject(rows[0]);
}

export function projectsApi(lists: ListRecipe): ProjectsApi {
  return {
    projects: {
      create: defineMethod<CreateProjectInput, Project>({
        action: 'compute:projects:manage',
        kind: 'mutation',
        resource: (input) => ({ type: 'tenant', id: input.tenantId }),
        validate: createInput,
        admission: {
          // §3.4 step 4: the same request again returns the project without a second decision.
          async prepare(context, input, tx) {
            const id = await derivedId('prj', input.tenantId, context, input.idempotencyKey);
            const existing = await findProject(tx, input.tenantId, id);
            if (existing) {
              if (existing.name !== input.name) throw keyReused();
              return { status: 'replay', result: existing };
            }
            return { status: 'decide', resource: { type: 'tenant', id: input.tenantId } };
          },
        },
        async handler(context, input) {
          const admitted = admittedOf(context);
          const id = await derivedId('prj', input.tenantId, context, input.idempotencyKey);
          // No conflict target: the id and (tenant_id, name) both count, and neither aborts the tx.
          const { rows } = await context.sql.query<ProjectRow>(
            `INSERT INTO projects AS p (id, tenant_id, name, state, version)
             VALUES ($1, $2, $3, 'active', 1)
             ON CONFLICT DO NOTHING
             RETURNING ${columns}`,
            [id, input.tenantId, input.name],
          );
          if (!rows[0]) {
            const existing = await findProject(context.sql, input.tenantId, id);
            if (existing?.name === input.name) return existing; // a concurrent retry got there first
            if (existing) throw keyReused();
            throw new ComputeError('CONFLICT', `A project named ${input.name} already exists`);
          }
          const project = toProject(rows[0]);
          await context.authz.upsert(context.sql, {
            type: 'project',
            id,
            tenantId: input.tenantId,
            attributes: {},
            ownerId: admitted.identityId,
          });
          await context.events.publish(context.sql, {
            type: 'project.created',
            tenantId: input.tenantId,
            subject: `project/${id}`,
            data: { projectId: id, name: project.name },
          });
          return project;
        },
      }),
      get: defineMethod<GetProjectInput, Project>({
        action: 'compute:projects:read',
        kind: 'read',
        resource: (input) => ({ type: 'project', id: input.projectId }),
        validate: getInput,
        async handler(context, input) {
          const project = await findProject(context.sql, input.tenantId, input.projectId);
          if (!project) throw notFound('Project');
          return project;
        },
      }),
      list: defineListMethod<ListProjectsInput, Page<Project>>({
        action: 'compute:projects:read',
        kind: 'read',
        resource: (input) => ({ type: 'tenant', id: input.tenantId }),
        validate: listInput,
        async handler(context, input) {
          const size = input.limit ?? 50;
          let result: Page<Project> = { items: [] };
          const items = await lists.authorizeItems(
            context,
            input.tenantId,
            async () => {
              const { rows } = await context.sql.query<ProjectRow>(
                `SELECT ${columns} FROM projects p
                 WHERE p.tenant_id = $1 AND ($2::text IS NULL OR p.state = $2)
                   AND ($3::text IS NULL OR p.id > $3) AND ${visibleIn('project', 'p.id', '$1')}
                 ORDER BY p.id LIMIT $4`,
                [input.tenantId, input.state ?? null, input.cursor ?? null, size + 1],
              );
              result = page(rows, size, toProject, (row) => row.id);
              return result.items;
            },
            { action: 'compute:projects:read', type: 'project', id: (project) => project.id },
          );
          return { ...result, items };
        },
      }),
      archive: defineMethod<GetProjectInput, Project>({
        action: 'compute:projects:manage',
        kind: 'mutation',
        resource: (input) => ({ type: 'project', id: input.projectId }),
        validate: getInput,
        async handler(context, input) {
          const { rows } = await context.sql.query<ProjectRow>(
            `UPDATE projects p SET state = 'archived', version = version + 1
              WHERE p.id = $1 AND p.tenant_id = $2 AND p.state <> 'archived'
             RETURNING ${columns}`,
            [input.projectId, input.tenantId],
          );
          if (!rows[0]) {
            const project = await findProject(context.sql, input.tenantId, input.projectId);
            if (!project) throw notFound('Project');
            return project; // already archived
          }
          const project = toProject(rows[0]);
          await context.events.publish(context.sql, {
            type: 'project.archived',
            tenantId: input.tenantId,
            subject: `project/${project.id}`,
            data: { projectId: project.id, name: project.name },
          });
          return project;
        },
      }),
    },
  };
}
