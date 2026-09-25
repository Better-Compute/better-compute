import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The console's deployment (PLAN.md §9.3, v0.5): better-iam and better-compute in one process, on one origin
// (`/api/iam` and `/api/compute`), so the host-only IAM session cookie authenticates both. The compute IAM bridge
// installs the §12.3 catalog on better-iam and serves compute's decisions from its projection.
//
// Development defaults: better-iam on libSQL and compute on PGlite under `.console-data/`, a generated secret, and a
// root administrator bootstrapped on first start (CONSOLE_ADMIN_EMAIL / CONSOLE_ADMIN_PASSWORD, printed once when
// generated). Production sets BETTER_COMPUTE_DATABASE_URL (postgres://…), CONSOLE_SECRET and CONSOLE_ORIGIN.

const env = process.env;

async function secretFor(dataDir) {
  if (env.CONSOLE_SECRET) return env.CONSOLE_SECRET;
  if (env.NODE_ENV === 'production')
    throw new Error('Set CONSOLE_SECRET (at least 32 random characters).');
  const file = join(dataDir, 'secret');
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    const secret = randomBytes(32).toString('base64url');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${secret}\n`, { mode: 0o600, flag: 'wx' }).catch(() => undefined);
    return (await readFile(file, 'utf8')).trim();
  }
}

/**
 * better-iam's store: PostgreSQL when CONSOLE_IAM_DATABASE_URL is set, otherwise a local libSQL file (N-API, so it
 * loads on any Node version without a rebuild, unlike better-sqlite3).
 */
async function iamDatabase(dataDir) {
  if (env.CONSOLE_IAM_DATABASE_URL) {
    const { postgresAdapter } = await import('better-iam/adapter-postgres');
    return postgresAdapter({ connectionString: env.CONSOLE_IAM_DATABASE_URL });
  }
  const { libsqlAdapter } = await import('better-iam/adapter-libsql');
  return libsqlAdapter({ url: pathToFileURL(env.CONSOLE_IAM_DB ?? join(dataDir, 'iam.db')).href });
}

/**
 * A PKCS#8 PEM private key: the file `env[variable]` names, or in development one generated once under the data
 * directory. Undefined in production without the variable (the feature stays off).
 */
async function keyFile(dataDir, variable, name, generate) {
  const file = env[variable] ?? (env.NODE_ENV === 'production' ? undefined : join(dataDir, name));
  if (!file) return undefined;
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (env[variable]) throw error;
    const pem = generate().export({ type: 'pkcs8', format: 'pem' });
    await writeFile(file, pem, { mode: 0o600, flag: 'wx' }).catch(() => undefined);
    return readFile(file, 'utf8');
  }
}

/**
 * Tunnels (browser terminals, node consoles) and break-glass SSH (PLAN.md §7.6, §13): the exec ticket issuer and
 * the compute SSH CA, from CONSOLE_EXEC_TICKET_KEY_FILE / CONSOLE_SSH_CA_KEY_FILE (every replica and the gateways
 * must share them; nodes pin their public keys). Development generates both under the data directory.
 */
async function tunnelsFor(dataDir, origin) {
  const ticketKey = await keyFile(
    dataDir,
    'CONSOLE_EXEC_TICKET_KEY_FILE',
    'exec-ticket.pem',
    () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey,
  );
  if (!ticketKey) return undefined;
  const { createExecTicketIssuer, createSshCertificateAuthority } = await import(
    'better-compute/pki'
  );
  const sshKey = await keyFile(
    dataDir,
    'CONSOLE_SSH_CA_KEY_FILE',
    'ssh-ca.pem',
    () => generateKeyPairSync('ed25519').privateKey,
  );
  return {
    issuer: createExecTicketIssuer({ issuer: origin, privateKey: ticketKey }),
    ...(sshKey
      ? {
          ssh: createSshCertificateAuthority({
            privateKey: sshKey,
            comment: 'better-compute console',
          }),
        }
      : {}),
  };
}

/** The api → gateway mTLS client identity for tunnel relays (CONSOLE_GATEWAY_TLS_{CERT,KEY,CA} files). */
async function gatewayTls() {
  const files = {
    cert: env.CONSOLE_GATEWAY_TLS_CERT,
    key: env.CONSOLE_GATEWAY_TLS_KEY,
    ca: env.CONSOLE_GATEWAY_TLS_CA,
  };
  const entries = await Promise.all(
    Object.entries(files)
      .filter(([, file]) => file)
      .map(async ([name, file]) => [name, await readFile(file, 'utf8')]),
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Creates the stack. Imported at runtime by `src/lib/stack.ts` (never bundled). */
export async function createStack() {
  const dataDir = resolve(process.cwd(), env.CONSOLE_DATA_DIR ?? '.console-data');
  await mkdir(dataDir, { recursive: true });
  const origin = (env.CONSOLE_ORIGIN ?? 'http://localhost:3100').replace(/\/+$/, '');
  const secret = await secretFor(dataDir);

  const { betterIam } = await import('better-iam/server');
  const { betterCompute } = await import('better-compute/server');
  const { createComputeIamBridge } = await import('better-compute/iam');
  const { vps } = await import('better-compute/vps');
  const { fleetModule } = await import('better-compute/fleet');

  const modules = [vps(), fleetModule()];
  // Daemon rollouts need the offline release keys' pins (comma-separated `sha256/…`) and where binaries are served.
  if (env.CONSOLE_RELEASE_PINS && env.CONSOLE_DOWNLOADS_URL) {
    const { rolloutModule } = await import('better-compute/rollout');
    modules.push(
      rolloutModule({
        release: {
          pins: env.CONSOLE_RELEASE_PINS.split(',')
            .map((pin) => pin.trim())
            .filter(Boolean),
          ...(env.CONSOLE_RELEASE_THRESHOLD
            ? { threshold: Number(env.CONSOLE_RELEASE_THRESHOLD) }
            : {}),
        },
        downloadsUrl: env.CONSOLE_DOWNLOADS_URL,
      }),
    );
  }
  const bridge = createComputeIamBridge({ modules });
  const iam = betterIam({
    database: await iamDatabase(dataDir),
    secret,
    baseURL: origin,
    plugins: [bridge.plugin()],
    resolveResource: bridge.resolveResource(),
    authentication: {
      // Development: sign-in links and codes go to the server log. Production wires a delivery provider.
      sendEmail: async (message) => console.info('[console] email', message.to, message.template),
      sendSms: async (message) => console.info('[console] sms', message.to, message.template),
    },
  });
  await iam.initialize();
  const rootTenantId = await bootstrapRoot(iam, dataDir);

  let database;
  if (env.BETTER_COMPUTE_DATABASE_URL?.startsWith('postgres')) {
    const { postgres } = await import('better-compute/postgres');
    database = postgres({ url: env.BETTER_COMPUTE_DATABASE_URL });
  } else {
    const { pglite } = await import('better-compute/pglite');
    database = pglite({ dataDir: join(dataDir, 'compute') });
  }
  const tunnels = await tunnelsFor(dataDir, origin);
  const compute = betterCompute({
    database,
    secret,
    baseURL: origin,
    acceptIamCookie: true,
    modules: [...modules, ...bridge.modules],
    iam: bridge.embedded(iam, { rootTenantId, runIamJobs: true }),
    ...(tunnels ? { tunnels } : {}),
  });
  await compute.initialize();
  await compute.start();

  // What `server.mjs` needs to serve `GET /api/compute/tunnels/{ticket}` upgrades (Next route handlers cannot).
  let tunnelHost;
  if (tunnels) {
    const { gatewayTunnelRelay } = await import('better-compute/gateway');
    const { tunnelAuthorizer } = await import('better-compute/iam');
    const tls = await gatewayTls();
    tunnelHost = {
      sql: compute.context.sql,
      issuer: tunnels.issuer,
      issuerName: origin,
      relay: gatewayTunnelRelay({ sql: compute.context.sql, ...(tls ? { tls } : {}) }),
      authorize: tunnelAuthorizer(compute.context.iam),
      basePath: '/api/compute',
    };
  }
  return { iam, compute, rootTenantId, origin, tunnels: tunnelHost };
}

/** The root tenant: bootstrapped once, then read back from `.console-data/root.json`. */
async function bootstrapRoot(iam, dataDir) {
  const file = join(dataDir, 'root.json');
  try {
    return JSON.parse(await readFile(file, 'utf8')).rootTenantId;
  } catch {
    // First start.
  }
  const email = env.CONSOLE_ADMIN_EMAIL ?? 'admin@console.local';
  const generated = !env.CONSOLE_ADMIN_PASSWORD;
  const password = env.CONSOLE_ADMIN_PASSWORD ?? randomBytes(12).toString('base64url');
  const root = await iam.bootstrap({ email, name: 'Administrator', password });
  await writeFile(file, `${JSON.stringify({ rootTenantId: root.tenant.id, email })}\n`, {
    mode: 0o600,
  });
  console.info(
    `[console] Root administrator ${email} created${generated ? ` with password ${password} (shown once)` : ''}; sign in at /login.`,
  );
  return root.tenant.id;
}
