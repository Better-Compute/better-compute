import type { DoEmulator } from './index.js';
import type { Json } from './state.js';

// Projects under `/v2/projects` (DigitalOcean P9, DO-D22): list, create (a name is unique in the account: a second
// create of it is a 409), and resource assignment by URN (`do:droplet:<id>`). Shapes follow the OpenAPI
// `projects` resource (spec). A test reads and edits `projectsOf(emulator)`.

export interface EmulatedProjects {
  /** By id. */
  projects: Map<string, Json>;
  /** The URNs assigned to each project, by project id. */
  resources: Map<string, string[]>;
}

const all = new WeakMap<DoEmulator, EmulatedProjects>();

export function projectsOf(emulator: DoEmulator): EmulatedProjects {
  let projects = all.get(emulator);
  if (!projects) {
    projects = { projects: new Map(), resources: new Map() };
    const id = '00000000-0000-4000-8000-000000000001';
    projects.projects.set(id, {
      id,
      name: 'default-project',
      description: '',
      purpose: 'Just trying out DigitalOcean',
      environment: 'Development',
      is_default: true,
    });
    all.set(emulator, projects);
  }
  return projects;
}

const urnPattern = /^do:[a-z_]+:[A-Za-z0-9-]+$/;

export function registerProjects(emulator: DoEmulator): void {
  emulator.route('GET', /^\/projects$/, (context) =>
    emulator.paged(context, 'projects', [...projectsOf(emulator).projects.values()]),
  );
  emulator.route('POST', /^\/projects$/, (context) => {
    const state = projectsOf(emulator);
    const body = context.body ?? {};
    const name = body.name;
    if (typeof name !== 'string' || name.length === 0 || name.length > 175)
      return emulator.error('422-unknown');
    if ([...state.projects.values()].some((project) => project.name === name))
      return { status: 409, body: { id: 'conflict', message: 'name is already in use' } };
    const id = `${String(context.state.nextId()).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const project = {
      id,
      name,
      description: body.description ?? '',
      purpose: body.purpose ?? '',
      environment: body.environment ?? '',
      is_default: false,
    };
    state.projects.set(id, project);
    return { status: 201, body: { project } };
  });
  emulator.route('POST', /^\/projects\/([^/]+)\/resources$/, (context) => {
    const state = projectsOf(emulator);
    const id = context.match[1]!;
    if (!state.projects.has(id)) return emulator.error('not-found');
    const urns = (context.body?.resources ?? []) as unknown[];
    if (!urns.every((urn) => typeof urn === 'string' && urnPattern.test(urn)))
      return emulator.error('422-unknown');
    // A resource belongs to one project: assigning it moves it.
    for (const [project, list] of state.resources)
      state.resources.set(
        project,
        list.filter((urn) => !(urns as string[]).includes(urn)),
      );
    const list = state.resources.get(id) ?? [];
    list.push(...(urns as string[]));
    state.resources.set(id, list);
    return {
      status: 200,
      body: {
        resources: (urns as string[]).map((urn) => ({
          urn,
          assigned_at: new Date(context.state.now()).toISOString(),
          status: 'ok',
        })),
      },
    };
  });
}
