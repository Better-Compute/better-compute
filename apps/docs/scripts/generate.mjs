// Generates the better-compute documentation's reference section from the live packages (mirrors
// ../better-iam/apps/docs/scripts/generate.mjs):
//
//   node apps/docs/scripts/generate.mjs           writes apps/docs/generated/*.json and
//                                                 apps/docs/content/docs/reference/** (generated pages)
//   node apps/docs/scripts/generate.mjs --check   fails when anything it would write differs (CI)
//
// Inputs: the built packages (run `tsc -b` first). A control plane is built with EVERY module registered
// (provision + metal, vps, events, fleet, rollout, audit, beside the built-in node controllers, inventory and
// capacity) on a PGlite executor that is never opened and an IamPort that refuses everything, so the method
// registry, command kinds, migrations and jobs are the ones a full deployment serves. Beside it: PLAN.md §9.2
// (core's `apiSurface`) for planned methods, core's error codes, the CLI manifest, every package.json.
// Hand-written text comes from apps/docs/descriptions/: `api/<group>.md` (an overview paragraph, then
// `## method` sections whose first paragraph is the summary) and `errors.md` (`## CODE` sections).
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import prettier from 'prettier';
import { checkDescriptions, firstParagraph, sections } from './descriptions.mjs';

const docs = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(docs, '..', '..');
const check = process.argv.includes('--check');

const dist = (pkg, entry = 'index.js') => join(root, 'packages', pkg, 'dist', entry);
const needed = [
  'core',
  'server',
  'postgres',
  'pki',
  'provision',
  'metal',
  'vps',
  'events',
  'fleet',
  'rollout',
  'audit',
  'cli',
  'observability',
];
const missing = needed.filter(
  (pkg) => !existsSync(dist(pkg, pkg === 'postgres' ? 'pglite.js' : 'index.js')),
);
if (missing.length) {
  console.error(`Missing builds: ${missing.join(', ')}. Run: node node_modules/typescript/bin/tsc -b`);
  process.exit(1);
}
const load = (pkg, entry) => import(pathToFileURL(dist(pkg, entry)).href);

const core = await load('core');
const server = await load('server');
const { pglite } = await load('postgres', 'pglite.js');
const pki = await load('pki');
const { provisionModule } = await load('provision');
const { metal } = await load('metal');
const { vps } = await load('vps');
const { eventsModule, eventCatalog } = await load('events');
const { fleetModule } = await load('fleet');
const { rolloutModule } = await load('rollout');
const { auditModule } = await load('audit');
const { cliManifest } = await load('cli');
const { metricCatalog } = await load('observability');

// ---- The live registry, with every module --------------------------------------------------------

const refuse = () => Promise.reject(new Error('the docs generator never calls IAM'));
const database = pglite();
const metalModule = metal();
const compute = server.betterCompute({
  database,
  iam: {
    authenticate: refuse,
    require: refuse,
    authorize: refuse,
    authorizeMany: refuse,
    requestConfirmation: refuse,
    billingCheck: refuse,
    recordUsage: refuse,
    featureEnabled: refuse,
    capabilities: () => ({
      pluginResolver: false,
      eventDetail: false,
      evaluate: false,
      readOnlyDecisions: false,
    }),
  },
  secret: 'docs-generator-placeholder-secret-0123456789',
  baseURL: 'https://compute.example.com',
  rootTenantId: 'root',
  // Tunnels (tunnels.open, nodes.issueSshCert/revokeSshCert) register only with an exec-ticket issuer.
  tunnels: { issuer: pki.createExecTicketIssuer({ issuer: 'https://docs.invalid' }) },
  modules: [
    provisionModule({ modules: [metalModule] }),
    metalModule,
    vps(),
    eventsModule({ secret: 'docs-generator-placeholder-secret-0123456789' }),
    fleetModule(),
    rolloutModule({
      release: { pins: [pki.spkiPin(pki.generateP256KeyPair().publicKey)] },
      downloadsUrl: 'https://downloads.example.com',
    }),
    auditModule({ signer: pki.createSigningKey() }),
  ],
});
const { registry, endpoint } = compute;


// ---- Data -----------------------------------------------------------------------------------------

const kebab = (text) => text.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const surface = new Map(core.apiSurface.map((row) => [`${row.group}/${row.method}`, row]));
const groups = new Map();
const addMethod = (group, entry) => {
  if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push(entry);
};
for (const row of core.apiSurface) {
  const registered = registry.method(`${row.group}/${row.method}`);
  addMethod(row.group, {
    method: row.method,
    route: `POST ${endpoint.basePath}/${row.group}/${row.method}`,
    kind: row.kind,
    action: row.action,
    resource: row.resource ? `compute-${row.resource}` : null,
    alternatives: (row.alternatives ?? []).map((pair) => ({
      action: pair.action,
      resource: `compute-${pair.resource}`,
    })),
    list: row.list === true,
    phase: row.phase,
    module: registered?.module ?? row.module,
    status: registered ? 'registered' : 'planned',
    input: registered?.definition?.validate?.jsonSchema ?? null,
  });
}
for (const method of registry.methods) {
  if (method.plugin || surface.has(`${method.group}/${method.method}`)) continue;
  addMethod(method.group, {
    method: method.method,
    route: `POST ${endpoint.basePath}/${method.path}`,
    kind: method.kind,
    action: method.action,
    resource: null,
    alternatives: [],
    list: false,
    phase: null,
    module: method.module,
    status: 'registered',
    input: method.definition?.validate?.jsonSchema ?? null,
  });
}

const descriptions = join(docs, 'descriptions');
const api = [];
for (const [group, methods] of [...groups].sort(([a], [b]) => byName(a, b))) {
  const text = await sections(join(descriptions, 'api', `${group}.md`));
  api.push({
    group,
    slug: kebab(group),
    module: methods[0].module,
    overview: text.get('') ?? '',
    methods: methods.map((method) => ({
      ...method,
      summary: firstParagraph(text.get(method.method)),
      description: text.get(method.method) ?? '',
    })),
  });
}

const errorText = await sections(join(descriptions, 'errors.md'));
const errors = core.errorCodes.map((code) => ({
  code,
  status: core.defaultStatus[code],
  description: errorText.get(code) ?? '',
}));

const cli = cliManifest();

const commandKinds = [...registry.commandKinds]
  .map((spec) => ({
    kind: spec.kind,
    lane: spec.lane,
    retrySafe: spec.retrySafe,
    selfTerminating: spec.selfTerminating === true,
    attested: spec.attested === true,
    destructive: spec.destructive === true,
    timeout: spec.timeout,
    roles: [...spec.roles],
    payload: spec.payload?.typeName ?? null,
  }))
  .sort((a, b) => byName(a.kind, b.kind));

const modules = registry.modules.map((name) => ({
  name,
  groups: api.filter((entry) => entry.methods.some((m) => m.module === name)).map((e) => e.group),
  migrations: registry.migrations
    .map((migration) => migration.name ?? migration.id)
    .filter((id) => typeof id === 'string' && id.startsWith(`${name}/`)),
}));
const jobs = Object.keys(compute.jobs).sort(byName);

const packages = [];
for (const entry of (await readdir(join(root, 'packages'), { withFileTypes: true }))
  .filter((dirent) => dirent.isDirectory())
  .map((dirent) => dirent.name)
  .sort(byName)) {
  const path = join(root, 'packages', entry, 'package.json');
  if (!existsSync(path)) continue;
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  packages.push({
    name: manifest.name,
    directory: `packages/${entry}`,
    description: manifest.description ?? '',
    private: manifest.private === true,
    exports: Object.keys(manifest.exports ?? {}),
  });
}

await database.close();

// ---- Pages ----------------------------------------------------------------------------------------

const code = (text) => `\`${text}\``;
/**
 * Markdown prose made safe for MDX: outside code spans and fences, `<` would open a JSX tag and
 * `{`/`}` a JS expression (e.g. `sha256/<base64>` or `{base-url}` in a CLI description).
 */
const prose = (text) =>
  String(text ?? '')
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, index) => (index % 2 ? part : part.replace(/[<{}]/g, (char) => `\\${char}`)))
    .join('');
const cell = (text) => prose(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
// `what` must not end the JS comment early (`packages/*/package.json`).
const generatedNote = (what) =>
  `{/* Generated by apps/docs/scripts/generate.mjs from ${what.replaceAll('*/', '*\\/')}. Do not edit; edit apps/docs/descriptions/ instead. */}`;
const frontmatter = (fields) =>
  `---\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n')}\n---\n`;

/** A JSON Schema node as a short type: `string`, `integer`, `one of a, b`, `list of string`, `map of integer`. */
const typeName = (schema) => {
  if (!schema || typeof schema !== 'object') return 'any';
  if (Array.isArray(schema.enum)) return `one of ${schema.enum.map((value) => code(value)).join(', ')}`;
  if (schema.type === 'array') return `list of ${typeName(schema.items)}`;
  if (schema.type === 'object' && schema.additionalProperties && typeof schema.additionalProperties === 'object')
    return `map of ${typeName(schema.additionalProperties)}`;
  return schema.type ?? 'any';
};

/** The limits a JSON Schema node states, in words. */
const constraints = (schema) => {
  if (!schema || typeof schema !== 'object') return '';
  const parts = [];
  if (schema.minLength !== undefined && schema.maxLength !== undefined)
    parts.push(`${schema.minLength}-${schema.maxLength} characters`);
  else if (schema.maxLength !== undefined) parts.push(`at most ${schema.maxLength} characters`);
  if (schema.pattern) parts.push(`matches ${code(schema.pattern)}`);
  if (schema.minimum !== undefined && schema.maximum !== undefined) parts.push(`${schema.minimum}-${schema.maximum}`);
  else if (schema.minimum !== undefined) parts.push(`at least ${schema.minimum}`);
  else if (schema.maximum !== undefined) parts.push(`at most ${schema.maximum}`);
  if (schema.maxItems !== undefined) parts.push(`${schema.minItems ?? 0}-${schema.maxItems} items`);
  if (schema.uniqueItems) parts.push('no repeats');
  if (schema.maxProperties !== undefined) parts.push(`at most ${schema.maxProperties} entries`);
  if (schema.propertyNames?.pattern) parts.push(`keys match ${code(schema.propertyNames.pattern)}`);
  if (schema.default !== undefined) parts.push(`default ${code(JSON.stringify(schema.default))}`);
  return parts.join('; ');
};

/** Input rows of an object schema, nested objects (and lists of objects) flattened to dotted names. */
function inputRows(schema, prefix = '', depth = 0) {
  if (!schema || schema.type !== 'object' || !schema.properties || depth > 3) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).flatMap(([key, field]) => {
    const name = `${prefix}${key}`;
    const row = { name, type: typeName(field), required: required.has(key), constraints: constraints(field) };
    const nested =
      field?.type === 'object' && field.properties
        ? inputRows(field, `${name}.`, depth + 1)
        : field?.type === 'array' && field.items?.type === 'object' && field.items.properties
          ? inputRows(field.items, `${name}[].`, depth + 1)
          : [];
    return [row, ...nested];
  });
}

const inputTable = (schema) => {
  const rows = inputRows(schema);
  if (!rows.length) return ['Takes an empty object: `{}`.'];
  return [
    '| Field | Type | Required | Constraints |',
    '| --- | --- | --- | --- |',
    ...rows.map((row) => `| ${code(row.name)} | ${cell(row.type)} | ${row.required ? 'yes' : ''} | ${cell(row.constraints)} |`),
  ];
};

const authorization = (method) => {
  if (method.action === null) return 'public';
  const pairs = [{ action: method.action, resource: method.resource }, ...method.alternatives];
  const text = pairs
    .map(({ action, resource }) => (resource ? `${code(action)} @ ${code(resource)}` : code(action)))
    .join(' or ');
  return method.list ? `${text} + items` : text;
};

const files = new Map();
const reference = 'content/docs/reference';

for (const entry of api) {
  const registered = entry.methods.filter((method) => method.status === 'registered').length;
  const lines = [
    frontmatter({
      title: entry.group,
      description:
        firstParagraph(entry.overview) ||
        `The ${entry.group} API group (${entry.module}): ${entry.methods.length} methods.`,
    }),
    generatedNote('the method registry and PLAN.md §9.2'),
    '',
    prose(entry.overview) ||
      `Methods of the ${code(entry.group)} group, contributed by ${code(entry.module)}.`,
    '',
    registered === entry.methods.length
      ? `All ${registered} methods are served by this release.`
      : `${registered} of ${entry.methods.length} methods are served by this release; the others are planned for the phase shown.`,
    '',
    '| Method | Kind | Authorization | Phase | Status |',
    '| --- | --- | --- | --- | --- |',
    ...entry.methods.map(
      (method) =>
        `| [${code(method.method)}](#${method.method.toLowerCase()}) | ${method.kind} | ${cell(authorization(method))} | ${method.phase ?? '—'} | ${method.status} |`,
    ),
  ];
  for (const method of entry.methods) {
    lines.push('', `## ${method.method}`, '', code(method.route), '');
    if (method.description) lines.push(prose(method.description), '');
    lines.push(
      `- **Kind:** ${method.kind}`,
      `- **Authorization:** ${authorization(method)}`,
      `- **Module:** ${code(method.module)}`,
      `- **Phase:** ${method.phase ?? 'not in PLAN.md §9.2'} (${method.status})`,
    );
    // Unknown fields are refused (INVALID_INPUT), so the table is the whole input.
    if (method.input) lines.push('', '**Input**', '', ...inputTable(method.input));
  }
  files.set(`${reference}/api/${entry.slug}.mdx`, lines.join('\n'));
}

files.set(
  `${reference}/api/index.mdx`,
  [
    frontmatter({
      title: 'API',
      description: `Every method of the compute API, by group: ${registry.methods.length} registered, ${core.apiSurface.length} in PLAN.md §9.2.`,
    }),
    generatedNote('the method registry and PLAN.md §9.2'),
    '',
    `Every method is ${code(`POST ${endpoint.basePath}/{group}/{method}`)} with a JSON object body, ${code('content-type: application/json')} and ${code('X-Better-Compute: 1')} (else ${code('CSRF_REJECTED')}), at most ${server.maxBodyBytes / 1024} KiB. Answers are ${code('{ "data": … }')} or ${code('{ "error": { "code", "message", "details"? } }')}; see [errors](/docs/reference/errors). Plugins are served under ${code(`${endpoint.basePath}/plugins/{id}/{group}/{method}`)}.`,
    '',
    'A call is authenticated (except public methods), refused before any database access when the caller is outside the input tenant and the root tenant, and decided once on `action @ resource`. *+ items* marks list methods, which also filter items one by one.',
    '',
    '| Group | Module | Methods | Served |',
    '| --- | --- | --- | --- |',
    ...api.map(
      (entry) =>
        `| [${code(entry.group)}](/docs/reference/api/${entry.slug}) | ${code(entry.module)} | ${entry.methods.length} | ${entry.methods.filter((m) => m.status === 'registered').length} |`,
    ),
  ].join('\n'),
);
files.set(
  `${reference}/api/meta.json`,
  JSON.stringify({ title: 'API', pages: ['index', ...api.map((entry) => entry.slug)] }),
);

files.set(
  `${reference}/errors.mdx`,
  [
    frontmatter({
      title: 'Errors',
      description: 'Every stable error code the API, the SDK and the CLI surface, with its HTTP status.',
    }),
    generatedNote("core's errorCodes and defaultStatus"),
    '',
    'Errors answer `{ "error": { "code", "message", "retryAfterMs"?, "details"? } }`. Codes are stable; messages are not.',
    '',
    '| Code | HTTP status | Meaning |',
    '| --- | --- | --- |',
    ...errors.map(
      (error) =>
        `| ${error.description ? `[${code(error.code)}](#${error.code.toLowerCase()})` : code(error.code)} | ${error.status} | ${cell(firstParagraph(error.description))} |`,
    ),
    // The table carries each meaning; a section per code carries the rest (when it happens, what to do).
    ...errors
      .filter((error) => error.description)
      .flatMap((error) => ['', `## ${error.code}`, '', `HTTP ${error.status}.`, '', prose(error.description)]),
  ].join('\n'),
);

const cliLines = [
  frontmatter({
    title: 'CLI',
    description: `The better-compute command line ${cli.version}: ${cli.commands.length} commands.`,
  }),
  generatedNote('cliManifest() of @better-compute/cli'),
  '',
  'Run `better-compute help <command>` for the same text in a terminal, or `better-compute help --json` for this manifest.',
];
const cliGroups = [...new Set(cli.commands.map((command) => command.group ?? 'Other'))];
for (const group of cliGroups) {
  cliLines.push('', `## ${group}`);
  for (const command of cli.commands.filter((c) => (c.group ?? 'Other') === group)) {
    cliLines.push('', `### ${command.name}`, '', prose(command.summary), '');
    if (command.usage) cliLines.push('```sh', command.usage, '```', '');
    if (command.description) cliLines.push(prose(command.description), '');
    if (command.flags?.length) {
      cliLines.push('| Flag | Description | Default | Environment |', '| --- | --- | --- | --- |');
      for (const flag of command.flags)
        cliLines.push(
          `| ${code(`${flag.flag}${flag.value ? ` ${flag.value}` : ''}`)} | ${cell(flag.description)} | ${flag.default === undefined ? '' : code(String(flag.default))} | ${flag.env ? code(flag.env) : ''} |`,
        );
      cliLines.push('');
    }
    if (command.examples?.length)
      cliLines.push('```sh', ...command.examples.map((example) => example), '```');
  }
}
if (cli.env?.length) {
  cliLines.push('', '## Environment', '', '| Variable | Description |', '| --- | --- |');
  for (const variable of cli.env)
    cliLines.push(`| ${code(variable.name)} | ${cell(variable.description)} |`);
}
files.set(`${reference}/cli.mdx`, cliLines.join('\n'));

files.set(
  `${reference}/command-kinds.mdx`,
  [
    frontmatter({
      title: 'Command kinds',
      description: `The ${commandKinds.length} command kinds daemons run, with lane, safety flags, timeout and payload.`,
    }),
    generatedNote('registry.commandKinds with every module'),
    '',
    'Commands reach a node over its gateway session, one lane per kind. *Retry-safe* kinds are re-run after a crash between accept and completion; *self-terminating* ones end the agent (a reboot, a kexec, an upgrade) and complete when it rejoins; *attested* results are node-signed and verified before any transition; *destructive* ones must be signed.',
    '',
    '| Kind | Lane | Roles | Retry-safe | Self-terminating | Attested | Destructive | Timeout | Payload |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...commandKinds.map(
      (kind) =>
        `| ${code(kind.kind)} | ${kind.lane} | ${kind.roles.join(', ')} | ${kind.retrySafe ? 'yes' : ''} | ${kind.selfTerminating ? 'yes' : ''} | ${kind.attested ? 'yes' : ''} | ${kind.destructive ? 'yes' : ''} | ${code(String(kind.timeout))} | ${kind.payload ? code(kind.payload) : ''} |`,
    ),
  ].join('\n'),
);

files.set(
  `${reference}/modules.mdx`,
  [
    frontmatter({
      title: 'Modules',
      description:
        'What each module registers in a full deployment: API groups, migrations, and the jobs the runtime runs.',
    }),
    generatedNote('the registry of a control plane with every module'),
    '',
    'The built-ins (the node controllers, `inventory`, `capacity`) are always registered; the rest are passed as `betterCompute({ modules })`.',
    '',
    '| Module | API groups | Migrations |',
    '| --- | --- | --- |',
    ...modules.map(
      (module) =>
        `| ${code(module.name)} | ${module.groups.map((group) => `[${code(group)}](/docs/reference/api/${kebab(group)})`).join(', ')} | ${module.migrations.map(code).join(', ')} |`,
    ),
    '',
    '## Jobs',
    '',
    'Each is one reconciler or runtime loop; `compute.jobs[name].tick()` runs one pass.',
    '',
    ...jobs.map((job) => `- ${code(job)}`),
  ].join('\n'),
);

files.set(
  `${reference}/packages.mdx`,
  [
    frontmatter({
      title: 'Packages',
      description: 'Every package of the repository, what it is for and its entry points.',
    }),
    generatedNote('packages/*/package.json'),
    '',
    '| Package | Description | Entry points |',
    '| --- | --- | --- |',
    ...packages.map(
      (entry) =>
        `| ${code(entry.name)} | ${cell(entry.description)} | ${entry.exports.map(code).join(', ')} |`,
    ),
  ].join('\n'),
);

const events = eventCatalog.map((family) => ({ ...family }));
files.set(
  `${reference}/events.mdx`,
  [
    frontmatter({
      title: 'Events',
      description: `The ${events.length} event families the control plane publishes to webhooks, the SSE watch stream and sinks.`,
    }),
    generatedNote("the events module's eventCatalog"),
    '',
    'Every event is `{ id, type, tenantId, subject, data, time }`, delivered at least once in commit order. Subscriptions name a type or a family (`node.*`); a pattern nothing in this catalog can match is refused, and `webhooks.eventTypes` returns the same list.',
    '',
    '| Type | Subject | Module | Description |',
    '| --- | --- | --- | --- |',
    ...events.map(
      (family) =>
        `| ${code(family.type)} | ${code(family.subject)} | ${code(family.module)} | ${cell(family.description)} |`,
    ),
  ].join('\n'),
);

const metrics = metricCatalog().map((family) => ({ ...family, labels: [...family.labels] }));
const metricSources = [...new Set(metrics.map((family) => family.source))];
files.set(
  `${reference}/metrics.mdx`,
  [
    frontmatter({
      title: 'Metrics',
      description: `The ${metrics.length} Prometheus metric families better-compute exposes on /metrics, with their labels.`,
    }),
    generatedNote("the observability package's metricCatalog"),
    '',
    'Every family carries the `better_compute_` prefix and none has a tenant label (series stay bounded by `maxSeries`). Histograms also expose `_bucket`, `_sum` and `_count` series. Families are grouped by the function that registers them: `standardMetrics` on every process, the others where a host wires them.',
    '',
    ...metricSources.flatMap((source) => [
      `## ${source}`,
      '',
      '| Metric | Type | Labels | Description |',
      '| --- | --- | --- | --- |',
      ...metrics
        .filter((family) => family.source === source)
        .map(
          (family) =>
            `| ${code(family.name)} | ${family.kind} | ${family.labels.map(code).join(', ')} | ${cell(family.help)}${
              family.buckets?.length ? `. Buckets (s): ${family.buckets.join(', ')}` : ''
            } |`,
        ),
      '',
    ]),
  ].join('\n'),
);

// The reference section's own meta.json and index are hand-written; the generated pages are listed there.

const data = {
  'generated/api.json': api,
  'generated/errors.json': errors,
  'generated/cli.json': cli,
  'generated/command-kinds.json': commandKinds,
  'generated/events.json': events,
  'generated/metrics.json': metrics,
  'generated/modules.json': { modules, jobs },
  'generated/packages.json': packages,
};
for (const [path, value] of Object.entries(data)) files.set(path, JSON.stringify(value, null, 2));

// ---- Write or check -------------------------------------------------------------------------------

const prettierConfig = (await prettier.resolveConfig(join(docs, 'x.mdx'))) ?? {};
const format = (path, text) =>
  prettier.format(`${text}\n`, {
    ...prettierConfig,
    parser: path.endsWith('.json') ? 'json' : 'mdx',
  });

const generatedDirs = ['generated', `${reference}/api`];
const generatedFiles = new Set([...files.keys()]);
/** Files in the generated directories that this run would not write (stale pages). */
async function stale() {
  const out = [];
  for (const dir of generatedDirs) {
    const full = join(docs, dir);
    if (!existsSync(full)) continue;
    for (const name of await readdir(full)) {
      const path = `${dir}/${name}`;
      if (!generatedFiles.has(path)) out.push(path);
    }
  }
  return out;
}

// A heading that names no method (a typo, a renamed method) would silently drop its text.
const descriptionProblems = await checkDescriptions(docs, { api, errorCodes: core.errorCodes });
if (descriptionProblems.length) {
  for (const line of descriptionProblems) console.error(`apps/docs/${line}`);
  console.error(`${descriptionProblems.length} problem(s) in apps/docs/descriptions.`);
  process.exit(1);
}

const drift = [];
for (const [path, text] of files) {
  const formatted = await format(path, text);
  const full = join(docs, path);
  const current = existsSync(full) ? (await readFile(full, 'utf8')).replace(/\r\n/g, '\n') : undefined;
  if (current === formatted) continue;
  drift.push(path);
  if (!check) {
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, formatted);
  }
}
const leftovers = await stale();
if (check) {
  if (drift.length || leftovers.length) {
    for (const path of drift) console.error(`out of date: apps/docs/${path}`);
    for (const path of leftovers) console.error(`stale: apps/docs/${path}`);
    console.error('Run: node apps/docs/scripts/generate.mjs');
    process.exitCode = 1;
  } else console.log(`apps/docs: ${files.size} generated files are up to date.`);
} else {
  for (const path of leftovers) await rm(join(docs, path));
  console.log(
    `apps/docs: wrote ${drift.length} of ${files.size} files (${api.length} API groups, ${registry.methods.length} registered methods, ${commandKinds.length} command kinds)${leftovers.length ? `; removed ${leftovers.length} stale` : ''}.`,
  );
}
