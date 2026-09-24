import {
  ComputeError,
  apiMethod,
  assertMigrations,
  computeActions,
  type ApiGroups,
  type ApiSurfaceRow,
  type CommandKindSpec,
  type ComputeModule,
  type ComputePlugin,
  type ComputeResourceKind,
  type DriverDefinition,
  type Extension,
  type MethodDefinition,
  type MethodKind,
  type Migration,
  type ModuleContext,
  type RegistryView,
} from '@better-compute/core';

/** One routable method: a core group's, a module's, or a plugin's. */
export interface RegisteredMethod {
  /** The route below the base path: `system/version`, or `plugins/acme/widgets/poke` for plugins. */
  readonly path: string;
  readonly group: string;
  readonly method: string;
  /** The plugin id, for methods mounted under `plugins/{id}`. */
  readonly plugin?: string;
  /** Who contributed it: `server`, a module name, or a plugin's name. */
  readonly module: string;
  readonly action: string | null;
  readonly kind: MethodKind;
  /** The normative §9.2 row, when the method is one of the table's. */
  readonly row?: ApiSurfaceRow;
  readonly definition: MethodDefinition;
}

/**
 * - `uncatalogued`: the declared action is missing from the merged IAM catalog (fails `initialize()`).
 * - `mismatch`: the method disagrees with its §9.2 row on action, kind or resource (fails `initialize()`).
 * - `undeclared`: a non-plugin method with no §9.2 row (fails `scripts/authz-matrix.mjs`).
 */
export type RegistryProblemKind = 'uncatalogued' | 'mismatch' | 'undeclared';

export interface RegistryProblem {
  kind: RegistryProblemKind;
  path: string;
  message: string;
}

/** The module host's view of everything registered (PLAN.md §5.1). Immutable once built. */
export interface Registry extends RegistryView {
  /** Module and plugin names in registration order; the built-in `inventory` comes first. */
  readonly modules: readonly string[];
  /** Plugin ids in registration order. */
  readonly plugins: readonly string[];
  /** Every routable method: `system`, the built-ins, injected modules, then plugins. */
  readonly methods: readonly RegisteredMethod[];
  /** A method by its route below the base path. */
  method(path: string): RegisteredMethod | undefined;
  /** The merged catalog's actions: compute's own plus every module's and plugin's. */
  readonly actions: ReadonlySet<string>;
  /** Module and plugin migrations in registration order; the store applies its base schema first. */
  readonly migrations: readonly Migration[];
  /** Extensions from the options and every module, unique by `kind:id@version`. */
  readonly extensions: readonly Extension[];
  readonly commandKinds: readonly CommandKindSpec[];
  /** Methods that are uncatalogued, disagree with §9.2, or (outside plugins) are not in §9.2. */
  problems(): RegistryProblem[];
}

export interface RegistryInput {
  /** The server's own groups (`system`). */
  core: ApiGroups;
  /** The built-in modules first (`inventory`), then the injected ones, in order. */
  modules: readonly ComputeModule[];
  plugins: readonly ComputePlugin[];
  /** Extensions from the options: drivers, providers, attestors, scheduler plugins, sinks. */
  extensions: readonly unknown[];
  /** Builds what each module's `api()` receives, around the registry being built. */
  context(registry: RegistryView): ModuleContext;
}

const namePattern = /^[a-z][a-z0-9-]{0,63}$/;
const segmentPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const actionPattern = /^compute:[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9-]{0,63}$/;
/** Segments a JavaScript object or the client's Proxy cannot carry, and the plugin mount point. */
const reservedSegments = new Set([
  'then',
  'catch',
  'finally',
  'toJSON',
  'constructor',
  'prototype',
  '__proto__',
  'plugins',
]);
/** `core` owns the store's base migrations; `server` the system group; `capacity` arrives in v0.1. */
const reservedNames = new Set(['core', 'server', 'capacity', 'plugins']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const invalid = (message: string) => new ComputeError('INVALID_CONFIG', message);

function checkSegment(value: string, what: string): void {
  if (!segmentPattern.test(value) || reservedSegments.has(value))
    throw invalid(`${what} ${JSON.stringify(value)} is not a usable route segment`);
}

function checkMethod(path: string, value: unknown): MethodDefinition {
  if (!isRecord(value)) throw invalid(`${path} is not a method definition (use defineMethod)`);
  for (const member of ['resource', 'validate', 'handler'])
    if (typeof value[member] !== 'function') throw invalid(`${path}: ${member} must be a function`);
  const { action, kind } = value;
  if (kind !== 'read' && kind !== 'mutation' && kind !== 'public')
    throw invalid(`${path}: kind must be read, mutation or public`);
  if (kind === 'public' && action !== null)
    throw invalid(`${path}: a public method has action null`);
  if (kind !== 'public' && (typeof action !== 'string' || !actionPattern.test(action)))
    throw invalid(`${path}: ${String(action)} is not a compute:<area>:<verb> action`);
  return value as unknown as MethodDefinition;
}

/** The resource kinds a §9.2 row decides on: its own, and those of its "… or @ …" alternatives. */
export function rowResourceKinds(row: ApiSurfaceRow): ComputeResourceKind[] {
  const kinds = row.resource === null ? [] : [row.resource];
  for (const alternative of row.alternatives ?? []) kinds.push(alternative.resource);
  return kinds;
}

/**
 * Placeholder input for probing `resource(input)`: every property reads as a string. A resource
 * function is a pure projection of its validated input, so the probe reveals the kind it decides on.
 */
const probeInput: unknown = new Proxy(Object.freeze({}), {
  get: (_target, key) => (typeof key === 'string' ? 'probe' : undefined),
});

function probedKind(definition: MethodDefinition): string | undefined {
  try {
    const resource = definition.resource(probeInput);
    return isRecord(resource) && typeof resource.type === 'string' ? resource.type : undefined;
  } catch {
    return undefined; // Undecidable without real input; the envelope checks every call instead.
  }
}

/**
 * Registers the core groups, then each module and plugin: names and plugin ids unique, `requires`
 * met, methods unique per route with well-formed definitions, plugin actions `compute:<id>:*`,
 * migrations owned by their module, extensions unique by `kind:id@version`, command kinds unique.
 * Throws `INVALID_CONFIG`. Catalog completeness and §9.2 agreement are `problems()`, which
 * `initialize()` enforces.
 */
export function createRegistry(input: RegistryInput): Registry {
  const methods = new Map<string, RegisteredMethod>();
  const moduleNames: string[] = [];
  const pluginIds: string[] = [];
  const actions = new Set<string>(computeActions);
  const migrations: Migration[] = [];
  const extensions = new Map<string, Extension>();
  const commandKinds = new Map<string, CommandKindSpec>();

  const view: RegistryView = {
    hasModule: (name) => moduleNames.includes(name),
    commandKind: (kind) => commandKinds.get(kind),
    driver: (id) =>
      [...extensions.values()].find(
        (extension): extension is DriverDefinition =>
          extension.extension === 'driver' && extension.id === id,
      ),
  };
  const context = input.context(view);

  function addExtension(value: unknown, owner: string): void {
    if (
      !isRecord(value) ||
      typeof value.extension !== 'string' ||
      typeof value.id !== 'string' ||
      !value.id
    )
      throw invalid(`${owner}: extensions must be built with a define* helper`);
    const version = typeof value.version === 'string' ? value.version : '';
    const key = `${value.extension}:${value.id}@${version}`;
    if (extensions.has(key)) throw invalid(`Extension ${key} is registered twice`);
    extensions.set(key, value as unknown as Extension);
  }

  function addGroups(owner: string, plugin: string | undefined, groups: unknown): void {
    if (groups === undefined) return;
    if (!isRecord(groups))
      throw invalid(`${owner}: api() must return { group: { method: definition } }`);
    for (const group of Object.keys(groups)) {
      checkSegment(group, `${owner}: group`);
      const members = groups[group];
      if (!isRecord(members)) throw invalid(`${owner}: group ${group} must be an object`);
      for (const name of Object.keys(members)) {
        checkSegment(name, `${owner}: method ${group}.`);
        const path = plugin ? `plugins/${plugin}/${group}/${name}` : `${group}/${name}`;
        const existing = methods.get(path);
        if (existing)
          throw invalid(`${path} is registered twice (by ${existing.module} and ${owner})`);
        const definition = checkMethod(path, members[name]);
        if (plugin && definition.action && !definition.action.startsWith(`compute:${plugin}:`))
          throw invalid(`${path}: plugin actions are compute:${plugin}:<verb>`);
        const row = plugin ? undefined : apiMethod(group, name);
        methods.set(
          path,
          Object.freeze({
            path,
            group,
            method: name,
            ...(plugin ? { plugin } : {}),
            module: owner,
            action: definition.action,
            kind: definition.kind,
            ...(row ? { row } : {}),
            definition,
          }),
        );
      }
    }
  }

  function addModule(module: ComputeModule, plugin?: string): void {
    const name = module.name;
    if (typeof name !== 'string' || !namePattern.test(name))
      throw invalid(`Module name ${JSON.stringify(name)} must match ${namePattern}`);
    if (reservedNames.has(name)) throw invalid(`${name} is a reserved module name`);
    if (moduleNames.includes(name)) throw invalid(`Module ${name} is registered twice`);
    moduleNames.push(name);
    for (const migration of module.migrations ?? []) {
      if (!String(migration?.name).startsWith(`${name}/`))
        throw invalid(
          `Migration ${String(migration?.name)} of ${name} must be named ${name}/<nnnn>_<slug>`,
        );
      migrations.push(migration);
    }
    for (const extension of module.extensions ?? []) addExtension(extension, name);
    for (const spec of module.commandKinds ?? []) {
      if (!isRecord(spec) || typeof spec.kind !== 'string')
        throw invalid(`${name}: command kinds need a kind`);
      if (commandKinds.has(spec.kind))
        throw invalid(`Command kind ${spec.kind} is registered twice`);
      commandKinds.set(spec.kind, spec);
    }
    const catalog = module.catalog ?? {};
    const declared = [
      ...(catalog.actions ?? []),
      ...Object.values(catalog.resourceTypes ?? {}).flatMap((type) => type?.actions ?? []),
    ];
    for (const action of declared) {
      if (typeof action !== 'string' || !actionPattern.test(action))
        throw invalid(`${name}: catalog action ${String(action)} is not compute:<area>:<verb>`);
      if (plugin && !action.startsWith(`compute:${plugin}:`))
        throw invalid(`${name}: plugin catalog actions are compute:${plugin}:<verb>`);
      actions.add(action);
    }
    if (module.api !== undefined && typeof module.api !== 'function')
      throw invalid(`${name}: api must be a function of the module context`);
    addGroups(name, plugin, module.api?.(context));
  }

  for (const extension of input.extensions) addExtension(extension, 'options');
  addGroups('server', undefined, input.core);
  for (const module of input.modules) {
    if (!isRecord(module)) throw invalid('modules must be built with defineModule');
    addModule(module);
  }
  for (const plugin of input.plugins) {
    if (!isRecord(plugin)) throw invalid('plugins must be built with definePlugin');
    if (typeof plugin.id !== 'string' || !namePattern.test(plugin.id))
      throw invalid(`Plugin id ${JSON.stringify(plugin.id)} must match ${namePattern}`);
    if (pluginIds.includes(plugin.id)) throw invalid(`Plugin ${plugin.id} is registered twice`);
    pluginIds.push(plugin.id);
    addModule(plugin, plugin.id);
  }
  for (const module of [...input.modules, ...input.plugins])
    for (const required of module.requires ?? [])
      if (!moduleNames.includes(required))
        throw invalid(`${module.name} requires module ${required}, which is not registered`);
  assertMigrations(migrations);

  const registered = Object.freeze([...methods.values()]);
  return Object.freeze({
    ...view,
    modules: Object.freeze([...moduleNames]),
    plugins: Object.freeze([...pluginIds]),
    methods: registered,
    method: (path: string) => methods.get(path),
    actions,
    migrations: Object.freeze([...migrations]),
    extensions: Object.freeze([...extensions.values()]),
    commandKinds: Object.freeze([...commandKinds.values()]),
    problems() {
      const problems: RegistryProblem[] = [];
      for (const entry of registered) {
        const { path, action, kind, row } = entry;
        if (action !== null && !actions.has(action))
          problems.push({
            kind: 'uncatalogued',
            path,
            message: `${path} declares ${action}, which is missing from the merged IAM catalog`,
          });
        if (!row) {
          if (!entry.plugin)
            problems.push({
              kind: 'undeclared',
              path,
              message: `${path} is not in the §9.2 method table (third-party APIs mount as plugins)`,
            });
          continue;
        }
        if (action !== row.action || kind !== row.kind)
          problems.push({
            kind: 'mismatch',
            path,
            message: `${path} declares ${action ?? 'public'} (${kind}); §9.2 says ${row.action ?? 'public'} (${row.kind})`,
          });
        const probed = row.resource === null ? undefined : probedKind(entry.definition);
        const allowed: string[] = rowResourceKinds(row);
        if (probed !== undefined && !allowed.includes(probed))
          problems.push({
            kind: 'mismatch',
            path,
            message: `${path} decides on ${probed}; §9.2 says ${allowed.join(' or ')}`,
          });
      }
      return problems;
    },
  });
}
