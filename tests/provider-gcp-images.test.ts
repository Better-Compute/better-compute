import { describe, expect, it } from 'vitest';
import {
  manualClock,
  type CallContext,
  type ManualClock,
  type ProviderImpl,
} from '@better-compute/core';
import {
  allowedImageProjects,
  defaultImageProjects,
  gcpProvider,
  imageCacheMs,
  parseImageRef,
  sourceImageOf,
  sshUserOf,
  type GcpConfig,
  type GcpProviderOptions,
} from '@better-compute/provider-gcp';
import { GceEmulator } from './support/gce-emulator.js';

// U-03: image safety and resolution in provider-gcp. Every image a VM boots comes from a project the
// account allows (sourceImage refuses the rest with INVALID_INPUT, before anything is read or created),
// and image families resolve through getFromFamily with a day's cache that never offers a deprecated
// image.

const secrets = {
  resolve: async (): Promise<string> => {
    throw new Error('this account has no secrets');
  },
};
const log = { debug() {}, info() {}, warn() {}, error() {} };
const platformAccount = { id: 'pacct_platform', tenantId: 'root', platform: true };

function call(clock: ManualClock, key = 'k1'): CallContext {
  return { idempotencyKey: key, signal: new AbortController().signal, clock, secrets, log };
}

const account: GcpConfig = { projectId: 'acme-prod', zones: ['us-central1-a'] };

async function build(
  emu: GceEmulator,
  config: Record<string, unknown> = account as unknown as Record<string, unknown>,
  clock: ManualClock = manualClock(Date.parse('2026-10-19T00:00:00Z')),
  options: GcpProviderOptions = {},
): Promise<ProviderImpl> {
  const provider = gcpProvider({ fetch: emu.fetch, ...options });
  const parsed = await provider.config['~standard'].validate(config);
  if ('issues' in parsed && parsed.issues) throw new Error(parsed.issues[0]!.message);
  return provider.create((parsed as { value: GcpConfig }).value, {
    clock,
    secrets,
    log,
    account: platformAccount,
  });
}

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error as { code: string; details?: Record<string, unknown> };
  }
  throw new Error('not refused');
};

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('resolved');
    },
    (error: { code: string; details?: Record<string, unknown> }) => error,
  );

/** Compute requests the emulator saw (token requests left out). */
const computeRequests = (emu: GceEmulator) =>
  emu.requests.filter((request) => request.url.hostname === 'compute.googleapis.com');

describe('the image project allowlist (sourceImage)', () => {
  it('allows the public OS projects, imageProject and the own project by default', () => {
    const allowed = allowedImageProjects(account);
    for (const project of ['ubuntu-os-cloud', 'debian-cloud', 'rocky-linux-cloud', 'acme-prod'])
      expect(allowed.has(project), project).toBe(true);
    expect(defaultImageProjects).toContain('ubuntu-os-accelerator-images');
    expect(defaultImageProjects).toContain('deeplearning-platform-release');
    expect(allowed.has('legionedge-prod')).toBe(false);

    expect(sourceImageOf(account, 'ubuntu-2404-lts-amd64')).toBe(
      'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64',
    );
    expect(sourceImageOf(account, 'projects/debian-cloud/global/images/family/debian-12')).toBe(
      'projects/debian-cloud/global/images/family/debian-12',
    );
    expect(sourceImageOf(account, 'projects/debian-cloud/global/images/debian-12-v20261001')).toBe(
      'projects/debian-cloud/global/images/debian-12-v20261001',
    );
    expect(sourceImageOf(account, 'global/images/golden-1')).toBe('global/images/golden-1');
    expect(sourceImageOf(account, 'projects/acme-prod/global/images/family/golden')).toBe(
      'projects/acme-prod/global/images/family/golden',
    );
  });

  it("refuses another project's image with INVALID_INPUT naming the allowed projects", () => {
    const error = refusal(() =>
      sourceImageOf(account, 'projects/legionedge-prod/global/images/backdoor'),
    );
    expect(error).toMatchObject({
      code: 'INVALID_INPUT',
      details: {
        provider: 'gcp',
        reason: 'imageProjectNotAllowed',
        project: 'legionedge-prod',
      },
    });
    expect(error.details!.allowed).toContain('ubuntu-os-cloud');
    expect(error.details!.allowed).toContain('acme-prod');
    expect(
      refusal(() =>
        sourceImageOf(
          account,
          'https://compute.googleapis.com/compute/v1/projects/legionedge-prod/global/images/x',
        ),
      ),
    ).toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'imageProjectNotAllowed' } });
  });

  it('an explicit imageProjects list replaces the defaults; imageProject stays allowed', () => {
    const narrow: GcpConfig = {
      ...account,
      imageProject: 'acme-images',
      imageProjects: ['ubuntu-os-cloud'],
    };
    expect(sourceImageOf(narrow, 'golden')).toBe(
      'projects/acme-images/global/images/family/golden',
    );
    expect(sourceImageOf(narrow, 'projects/ubuntu-os-cloud/global/images/family/x')).toBe(
      'projects/ubuntu-os-cloud/global/images/family/x',
    );
    expect(
      refusal(() => sourceImageOf(narrow, 'projects/debian-cloud/global/images/family/debian-12')),
    ).toMatchObject({ code: 'INVALID_INPUT', details: { project: 'debian-cloud' } });
  });

  it("ownProjectImages: false refuses the account's own project, unless listed", () => {
    const platform: GcpConfig = { ...account, ownProjectImages: false };
    expect(refusal(() => sourceImageOf(platform, 'global/images/golden-1'))).toMatchObject({
      code: 'INVALID_INPUT',
      details: { reason: 'imageProjectNotAllowed', project: 'acme-prod' },
    });
    expect(
      refusal(() => sourceImageOf(platform, 'projects/acme-prod/global/images/family/golden')),
    ).toMatchObject({ code: 'INVALID_INPUT' });
    // Listed explicitly, it is allowed again.
    expect(
      sourceImageOf(
        { ...platform, imageProjects: ['acme-prod'] },
        'projects/acme-prod/global/images/x',
      ),
    ).toBe('projects/acme-prod/global/images/x');
  });

  it('keeps compute URLs of its own universe and refuses other hosts and malformed references', () => {
    const url =
      'https://compute.googleapis.com/compute/v1/projects/debian-cloud/global/images/img-1';
    expect(sourceImageOf(account, url)).toBe(url);
    expect(
      sourceImageOf(
        account,
        'https://www.googleapis.com/compute/v1/projects/debian-cloud/global/images/family/debian-12',
      ),
    ).toMatch(/^https:\/\/www\.googleapis\.com/);
    const tpc = { universeDomain: 'example-tpc.goog' };
    expect(
      sourceImageOf(
        account,
        'https://compute.example-tpc.goog/compute/v1/projects/debian-cloud/global/images/img-1',
        tpc,
      ),
    ).toMatch(/^https:\/\/compute\.example-tpc\.goog\//);
    for (const bad of [
      'https://evil.example.com/compute/v1/projects/debian-cloud/global/images/img-1',
      'http://compute.googleapis.com/compute/v1/projects/debian-cloud/global/images/img-1',
      `${url}?alt=json`,
      `${url}#x`,
      'https://user:pw@compute.googleapis.com/compute/v1/projects/debian-cloud/global/images/img-1',
      // Another universe's host is not this provider's.
      'https://compute.googleapis.com.evil/compute/v1/projects/debian-cloud/global/images/img-1',
      // A URL that normalizes to an allowed project is refused: GCE is given the raw text.
      'https://compute.googleapis.com/compute/v1/projects/legionedge-prod/../debian-cloud/global/images/img-1',
      'https://compute.googleapis.com/compute/v1/projects/legionedge-prod/%2e%2e/debian-cloud/global/images/img-1',
      'HTTPS://COMPUTE.GOOGLEAPIS.COM/compute/v1/projects/debian-cloud/global/images/img-1',
      'https://compute.googleapis.com:443/compute/v1/projects/debian-cloud/global/images/img-1',
      'projects/debian-cloud/global/images/family/x/../../../legionedge-prod',
      'projects/debian-cloud/global/images',
      'projects/debian-cloud/zones/us-central1-a/disks/d',
      'Ubuntu-2404',
      'ubuntu 24.04',
      '../legionedge-prod/global/images/x',
      '',
    ])
      expect(
        refusal(() => sourceImageOf(account, bad)),
        bad,
      ).toMatchObject({
        code: 'INVALID_INPUT',
        details: { provider: 'gcp', reason: 'imageRef' },
      });
    // A short form inside a URL is not taken: a URL names its project.
    expect(
      refusal(() =>
        sourceImageOf(account, 'https://compute.googleapis.com/compute/v1/global/images/x'),
      ),
    ).toMatchObject({ code: 'INVALID_INPUT' });
    expect(parseImageRef(account, 'projects/example.com:shared/global/images/family/f')).toEqual({
      project: 'example.com:shared',
      family: true,
      name: 'f',
    });
  });

  it('the account manifest validates imageProjects and ownProjectImages', async () => {
    const provider = gcpProvider();
    const ok = await provider.config['~standard'].validate({
      ...account,
      imageProjects: ['debian-cloud', 'example.com:shared'],
      ownProjectImages: false,
    });
    expect(ok).toMatchObject({
      value: { imageProjects: ['debian-cloud', 'example.com:shared'], ownProjectImages: false },
    });
    for (const imageProjects of [['Bad Project'], ['ok', '../x'], 'debian-cloud'])
      expect(
        'issues' in (await provider.config['~standard'].validate({ ...account, imageProjects })),
        JSON.stringify(imageProjects),
      ).toBe(true);
  });

  it('create refuses a disallowed image before reading or creating anything', async () => {
    const emu = new GceEmulator();
    const impl = await build(emu);
    const clock = manualClock(1_000_000);
    const error = await failure(
      impl.create(
        {
          offerId: 'us-central1-a/n2-standard-4',
          image: 'projects/legionedge-prod/global/images/golden',
          userData: '',
          name: 'ins_x',
        },
        call(clock),
      ),
    );
    expect(error).toMatchObject({
      code: 'INVALID_INPUT',
      details: { reason: 'imageProjectNotAllowed' },
    });
    expect(computeRequests(emu)).toEqual([]);
    expect(emu.instances.size).toBe(0);

    // An allowed one is created as before.
    await impl.create(
      {
        offerId: 'us-central1-a/n2-standard-4',
        image: 'projects/rocky-linux-cloud/global/images/family/rocky-linux-9',
        userData: '',
        name: 'ins_y',
        sshKeys: ['ssh-ed25519 AAAAC3Nza key'],
      },
      call(clock, 'k2'),
    );
    const vm = emu.instances.get('us-central1-a/bc-ins-y')!;
    expect(vm.disks[0].initializeParams.sourceImage).toBe(
      'projects/rocky-linux-cloud/global/images/family/rocky-linux-9',
    );
    expect(vm.metadata.items).toContainEqual({
      key: 'ssh-keys',
      value: 'rocky:ssh-ed25519 AAAAC3Nza key',
    });
  });
});

describe('image families (images.resolve)', () => {
  function seeded(): GceEmulator {
    const emu = new GceEmulator();
    emu.addImage('ubuntu-os-cloud', {
      name: 'ubuntu-2404-noble-amd64-v20260901',
      family: 'ubuntu-2404-lts-amd64',
      creationTimestamp: '2026-09-01T00:00:00.000-07:00',
    });
    emu.addImage('ubuntu-os-cloud', {
      name: 'ubuntu-2404-noble-amd64-v20261001',
      family: 'ubuntu-2404-lts-amd64',
      creationTimestamp: '2026-10-01T00:00:00.000-07:00',
      diskSizeGb: '10',
      description: 'Canonical, Ubuntu, 24.04 LTS, amd64 noble image',
      guestOsFeatures: [
        { type: 'VIRTIO_SCSI_MULTIQUEUE' },
        { type: 'GVNIC' },
        { type: 'UEFI_COMPATIBLE' },
        { type: 'SEV_CAPABLE' },
      ],
    });
    emu.addImage('debian-cloud', {
      name: 'debian-12-arm64-v20261001',
      family: 'debian-12-arm64',
      architecture: 'ARM64',
      diskSizeGb: '20',
    });
    emu.addImage('deeplearning-platform-release', {
      name: 'common-cu124-v20261001-ubuntu-2204-py310',
      family: 'common-cu124-ubuntu-2204-py310',
      diskSizeGb: '50',
    });
    return emu;
  }

  it('returns the newest image of each family with architecture, minimum disk, features and login user', async () => {
    const emu = seeded();
    const clock = manualClock(Date.parse('2026-10-19T00:00:00Z'));
    const impl = await build(emu, undefined, clock);
    const result = await impl.images!.resolve(
      [
        'ubuntu-2404-lts-amd64',
        'debian-cloud/debian-12-arm64',
        'projects/deeplearning-platform-release/global/images/family/common-cu124-ubuntu-2204-py310',
        'ubuntu-2404-lts-amd64',
      ],
      call(clock),
    );
    expect(result.missing).toEqual([]);
    expect(result.items).toEqual([
      {
        family: 'ubuntu-2404-lts-amd64',
        image: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20261001',
        name: 'ubuntu-2404-noble-amd64-v20261001',
        project: 'ubuntu-os-cloud',
        architecture: 'x86_64',
        minimumDiskGiB: 10,
        guestOsFeatures: ['GVNIC', 'SEV_CAPABLE', 'UEFI_COMPATIBLE', 'VIRTIO_SCSI_MULTIQUEUE'],
        loginUser: 'ubuntu',
        createdAt: '2026-10-01T00:00:00.000-07:00',
        description: 'Canonical, Ubuntu, 24.04 LTS, amd64 noble image',
      },
      expect.objectContaining({
        family: 'debian-cloud/debian-12-arm64',
        image: 'projects/debian-cloud/global/images/debian-12-arm64-v20261001',
        architecture: 'arm64',
        minimumDiskGiB: 20,
        loginUser: 'debian',
      }),
      expect.objectContaining({
        family:
          'projects/deeplearning-platform-release/global/images/family/common-cu124-ubuntu-2204-py310',
        project: 'deeplearning-platform-release',
        minimumDiskGiB: 50,
        loginUser: 'ubuntu',
      }),
    ]);
    // What resolve returns is what create boots: the pinned image passes the allowlist.
    expect(sourceImageOf(account, result.items[0]!.image)).toBe(result.items[0]!.image);
    expect(
      computeRequests(emu).map((request) => request.url.pathname.replace('/compute/v1', '')),
    ).toEqual([
      '/projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64',
      '/projects/debian-cloud/global/images/family/debian-12-arm64',
      '/projects/deeplearning-platform-release/global/images/family/common-cu124-ubuntu-2204-py310',
    ]);
  });

  it('caches each family for a day, and concurrent asks share one read', async () => {
    const emu = seeded();
    const clock = manualClock(Date.parse('2026-10-19T00:00:00Z'));
    const impl = await build(emu, undefined, clock);
    const reads = () => computeRequests(emu).length;
    await Promise.all([
      impl.images!.resolve(['ubuntu-2404-lts-amd64'], call(clock)),
      impl.images!.resolve(['ubuntu-2404-lts-amd64'], call(clock)),
    ]);
    expect(reads()).toBe(1);
    // A newer image published meanwhile is seen after the day.
    emu.addImage('ubuntu-os-cloud', {
      name: 'ubuntu-2404-noble-amd64-v20261015',
      family: 'ubuntu-2404-lts-amd64',
      creationTimestamp: '2026-10-15T00:00:00.000-07:00',
    });
    clock.advance(imageCacheMs - 1);
    const cached = await impl.images!.resolve(['ubuntu-2404-lts-amd64'], call(clock));
    expect(cached.items[0]!.name).toBe('ubuntu-2404-noble-amd64-v20261001');
    expect(reads()).toBe(1);
    clock.advance(1);
    const fresh = await impl.images!.resolve(['ubuntu-2404-lts-amd64'], call(clock));
    expect(fresh.items[0]!.name).toBe('ubuntu-2404-noble-amd64-v20261015');
    expect(reads()).toBe(2);
  });

  it('a family with no image is missing (remembered an hour); a failed read is not remembered', async () => {
    const emu = seeded();
    const clock = manualClock(Date.parse('2026-10-19T00:00:00Z'));
    const impl = await build(emu, undefined, clock);
    expect(await impl.images!.resolve(['nope-family'], call(clock))).toEqual({
      items: [],
      missing: [{ family: 'nope-family', reason: 'notFound' }],
    });
    await impl.images!.resolve(['nope-family'], call(clock));
    expect(computeRequests(emu)).toHaveLength(1);
    clock.advance(3_600_000);
    await impl.images!.resolve(['nope-family'], call(clock));
    expect(computeRequests(emu)).toHaveLength(2);

    emu.failNext = { status: 403, reason: 'forbidden', message: 'denied' };
    expect(
      await failure(impl.images!.resolve(['debian-cloud/debian-12-arm64'], call(clock))),
    ).toMatchObject({ code: 'ACCESS_DENIED' });
    const retried = await impl.images!.resolve(['debian-cloud/debian-12-arm64'], call(clock));
    expect(retried.items).toHaveLength(1);
  });

  it('hides a deprecated image, also one cached before its deprecation time passed', async () => {
    const emu = seeded();
    emu.addImage('debian-cloud', {
      name: 'debian-11-v20260901',
      family: 'debian-11',
      deprecated: {
        state: 'ACTIVE',
        replacement: 'projects/debian-cloud/global/images/family/debian-12',
        deprecated: '2026-10-19T12:00:00Z',
        obsolete: '2026-12-01T00:00:00Z',
      },
    });
    emu.addImage('centos-cloud', {
      name: 'centos-7-v20240611',
      family: 'centos-7',
      deprecated: { state: 'DEPRECATED', replacement: 'rocky-linux-9' },
    });
    // GCE skips deprecated images in getFromFamily; this emulator can answer with one anyway.
    emu.familyServesDeprecated = true;
    const clock = manualClock(Date.parse('2026-10-19T00:00:00Z'));
    const impl = await build(emu, undefined, clock);
    const before = await impl.images!.resolve(
      ['debian-cloud/debian-11', 'centos-cloud/centos-7'],
      call(clock),
    );
    expect(before.items).toEqual([
      expect.objectContaining({
        family: 'debian-cloud/debian-11',
        deprecation: {
          state: 'ACTIVE',
          replacement: 'projects/debian-cloud/global/images/family/debian-12',
          deprecated: '2026-10-19T12:00:00Z',
          obsolete: '2026-12-01T00:00:00Z',
        },
      }),
    ]);
    expect(before.missing).toEqual([{ family: 'centos-cloud/centos-7', reason: 'deprecated' }]);

    // A day later the deprecation time has passed: hidden from the cached answer, with no read.
    const reads = computeRequests(emu).length;
    clock.advance(imageCacheMs - 60_000);
    const after = await impl.images!.resolve(['debian-cloud/debian-11'], call(clock));
    expect(after).toEqual({
      items: [],
      missing: [{ family: 'debian-cloud/debian-11', reason: 'deprecated' }],
    });
    expect(computeRequests(emu).length).toBe(reads);
  });

  it('refuses the whole call for a family outside the allowlist, before reading anything', async () => {
    const emu = seeded();
    const clock = manualClock(Date.parse('2026-10-19T00:00:00Z'));
    const impl = await build(emu, { ...account, ownProjectImages: false }, clock);
    for (const families of [
      ['ubuntu-2404-lts-amd64', 'legionedge-prod/golden'],
      ['projects/legionedge-prod/global/images/family/golden'],
      ['global/images/family/golden'],
    ])
      expect(
        await failure(impl.images!.resolve(families, call(clock))),
        families.join(),
      ).toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'imageProjectNotAllowed' } });
    for (const families of [
      ['projects/debian-cloud/global/images/debian-12-v1'],
      ['Ubuntu'],
      Array.from({ length: 51 }, (_, index) => `f${index}`),
    ])
      expect(await failure(impl.images!.resolve(families, call(clock)))).toMatchObject({
        code: 'INVALID_INPUT',
      });
    expect(computeRequests(emu)).toEqual([]);
  });

  it('sshUserOf names the distribution user', () => {
    expect(sshUserOf('projects/debian-cloud/global/images/family/debian-12')).toBe('debian');
    expect(sshUserOf('projects/rocky-linux-cloud/global/images/family/rocky-linux-9')).toBe(
      'rocky',
    );
    expect(sshUserOf('centos-stream-9')).toBe('centos');
    expect(sshUserOf('ubuntu-2404-lts-amd64')).toBe('ubuntu');
  });
});
