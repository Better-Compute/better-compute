import type { ProfileDocument } from '@better-compute/core';
import {
  checkDottedId,
  checkJsonObject,
  checkName,
  checkOneOf,
  checkRetries,
  checkRunsOn,
  checkText,
  checkTimeout,
  deepFreeze,
  failFor,
  isPlainObject,
  join,
  onlyKeys,
  type Fail,
} from './check.js';

const stepKeys = [
  'use',
  'on',
  'with',
  'timeout',
  'retries',
  'await',
  'onFailure',
  'fallback',
  'when',
] as const;
const failureModes = ['fail', 'rescue', 'continue'] as const;
const maxSteps = 256;

/**
 * Checks one `ProfileStep`. An `onFailure` step is itself checked, one level deep: it cannot carry
 * its own `onFailure` step.
 */
export function checkProfileStep(value: unknown, path: string, fail: Fail, nested = false): void {
  if (!isPlainObject(value)) fail(path, 'must be an object');
  onlyKeys(value, stepKeys, path, fail);
  checkDottedId(value.use, join(path, 'use'), fail);
  if (value.on !== undefined) checkRunsOn(value.on, join(path, 'on'), fail);
  if (value.with !== undefined) checkJsonObject(value.with, join(path, 'with'), fail);
  if (value.timeout !== undefined) checkTimeout(value.timeout, join(path, 'timeout'), fail);
  if (value.retries !== undefined) checkRetries(value.retries, join(path, 'retries'), fail);
  if (value.await !== undefined) {
    if (value.await !== 'rejoin') fail(join(path, 'await'), "must be 'rejoin'");
    if (value.on === 'control-plane')
      fail(join(path, 'await'), 'needs a step that runs on an agent, which is what rejoins');
  }
  if (value.onFailure !== undefined) {
    const onFailure = join(path, 'onFailure');
    if (typeof value.onFailure === 'string')
      checkOneOf(value.onFailure, failureModes, onFailure, fail);
    else if (nested) fail(onFailure, 'cannot be a step inside an onFailure step');
    else checkProfileStep(value.onFailure, onFailure, fail, true);
  }
  if (value.fallback !== undefined) checkDottedId(value.fallback, join(path, 'fallback'), fail);
  if (value.when !== undefined) checkText(value.when, 256, join(path, 'when'), fail);
}

export function checkProfileSteps(value: unknown, path: string, fail: Fail): void {
  if (!Array.isArray(value) || value.length > maxSteps)
    fail(path, `must be a list of at most ${maxSteps} steps`);
  value.forEach((step, index) => checkProfileStep(step, join(path, index), fail));
}

const profileKeys = [
  'id',
  'version',
  'target',
  'description',
  'entry',
  'role',
  'drivers',
  'image',
  'userData',
  'hostConfig',
  'steps',
  'acceptance',
  'cleanup',
  'runtime',
  'flavors',
  'network',
] as const;
const metalOnly = ['entry', 'role', 'hostConfig'] as const;
const vpsOnly = ['runtime', 'flavors', 'network'] as const;
const profileIdPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const imageRefPattern = /^[^\s@]{1,128}@[^\s@]{1,64}$/;
const flavorNamePattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;

const positiveInt = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;

function checkDrivers(value: unknown, fail: Fail): void {
  if (!isPlainObject(value)) fail('drivers', 'must map driver concerns to driver ids');
  for (const [concern, binding] of Object.entries(value)) {
    const path = join('drivers', concern);
    checkName(concern, path, fail);
    if (typeof binding === 'string') {
      checkName(binding, path, fail);
      continue;
    }
    if (!isPlainObject(binding)) fail(path, 'must be a driver id or { driver, config }');
    onlyKeys(binding, ['driver', 'config'], path, fail);
    checkName(binding.driver, join(path, 'driver'), fail);
    if (binding.config !== undefined) checkJsonObject(binding.config, join(path, 'config'), fail);
  }
}

function checkImage(value: unknown, fail: Fail): void {
  if (!isPlainObject(value)) fail('image', 'must be an object');
  onlyKeys(value, ['ref', 'format', 'compression'], 'image', fail);
  if (typeof value.ref !== 'string' || !imageRefPattern.test(value.ref))
    fail('image.ref', 'must be a catalog reference name@version');
  if (value.format !== undefined)
    checkOneOf(value.format, ['raw', 'qcow2', 'iso'], 'image.format', fail);
  if (value.compression !== undefined)
    checkOneOf(value.compression, ['none', 'zstd', 'gzip'], 'image.compression', fail);
}

function checkUserData(value: unknown, fail: Fail): void {
  if (!isPlainObject(value)) fail('userData', 'must be an object');
  onlyKeys(value, ['kind', 'template'], 'userData', fail);
  checkOneOf(value.kind, ['cloud-init', 'ignition', 'talos'], 'userData.kind', fail);
  checkText(value.template, 256, 'userData.template', fail);
}

function checkHostConfig(value: unknown, fail: Fail): void {
  if (!isPlainObject(value)) fail('hostConfig', 'must map config units to their settings');
  for (const [unit, settings] of Object.entries(value)) {
    checkName(unit, join('hostConfig', unit), fail);
    checkJsonObject(settings, join('hostConfig', unit), fail);
  }
}

function checkFlavors(value: unknown, fail: Fail): void {
  if (!isPlainObject(value)) fail('flavors', 'must map flavor names to flavors');
  for (const [name, flavor] of Object.entries(value)) {
    const path = join('flavors', name);
    if (!flavorNamePattern.test(name))
      fail(path, 'must be named with lower-case letters, digits, dots and hyphens');
    if (!isPlainObject(flavor)) fail(path, 'must be { vcpu, memoryGiB, diskGiB, gpus? }');
    onlyKeys(flavor, ['vcpu', 'memoryGiB', 'diskGiB', 'gpus'], path, fail);
    if (!positiveInt(flavor.vcpu)) fail(join(path, 'vcpu'), 'must be a positive whole number');
    if (
      typeof flavor.memoryGiB !== 'number' ||
      !(flavor.memoryGiB > 0) ||
      !Number.isFinite(flavor.memoryGiB)
    )
      fail(join(path, 'memoryGiB'), 'must be a positive number');
    if (!positiveInt(flavor.diskGiB))
      fail(join(path, 'diskGiB'), 'must be a positive whole number');
    if (
      flavor.gpus !== undefined &&
      !(Number.isSafeInteger(flavor.gpus) && (flavor.gpus as number) >= 0)
    )
      fail(join(path, 'gpus'), 'must be a whole number');
  }
}

function checkNetwork(value: unknown, fail: Fail): void {
  if (!isPlainObject(value)) fail('network', 'must be an object');
  onlyKeys(value, ['mode', 'ipam'], 'network', fail);
  checkName(value.mode, 'network.mode', fail);
  if (value.ipam !== undefined) checkName(value.ipam, 'network.ipam', fail);
}

function subjectOf(value: unknown): string {
  if (!isPlainObject(value) || typeof value.id !== 'string') return 'Profile';
  const id = value.id.slice(0, 128);
  return typeof value.version === 'number' ? `Profile ${id}@${value.version}` : `Profile ${id}`;
}

function checkProfile(value: unknown): asserts value is ProfileDocument {
  const fail: Fail = failFor(subjectOf(value));
  if (!isPlainObject(value)) fail('', 'must be an object');
  onlyKeys(value, profileKeys, '', fail);
  if (typeof value.id !== 'string' || !profileIdPattern.test(value.id))
    fail('id', 'must be lower-case letters, digits, dots, underscores and hyphens');
  if (!positiveInt(value.version)) fail('version', 'must be a positive whole number');
  checkOneOf(value.target, ['metal', 'vps'], 'target', fail);
  const other = value.target === 'metal' ? vpsOnly : metalOnly;
  for (const key of other)
    if (value[key] !== undefined) fail(key, `is not available on ${value.target} profiles`);
  if (value.description !== undefined) checkText(value.description, 1024, 'description', fail);
  if (value.entry !== undefined) checkOneOf(value.entry, ['adopt', 'deploy'], 'entry', fail);
  if (value.entry === 'adopt')
    for (const key of ['image', 'userData', 'steps'] as const)
      if (value[key] !== undefined)
        fail(key, 'is not available on an adopt profile, which keeps the installed OS');
  if (value.role !== undefined) checkOneOf(value.role, ['host', 'dedicated'], 'role', fail);
  if (value.drivers !== undefined) checkDrivers(value.drivers, fail);
  if (value.image !== undefined) checkImage(value.image, fail);
  if (value.userData !== undefined) checkUserData(value.userData, fail);
  if (value.hostConfig !== undefined) checkHostConfig(value.hostConfig, fail);
  for (const key of ['steps', 'acceptance', 'cleanup'] as const)
    if (value[key] !== undefined) checkProfileSteps(value[key], key, fail);
  if (value.target === 'vps') checkName(value.runtime, 'runtime', fail);
  if (value.flavors !== undefined) checkFlavors(value.flavors, fail);
  if (value.network !== undefined) checkNetwork(value.network, fail);
}

/**
 * Declares a provisioning profile (§11.4): a versioned template, immutable once a workflow uses it.
 * The document is checked (unknown fields, step shapes, durations, JSON-only values, fields that
 * belong to the other target) and returned as a deeply frozen copy; errors are `INVALID_CONFIG`
 * naming the first offending path. Whether each `use:` resolves to a registered step is checked
 * against the registry by `profiles.validate` (v0.2).
 *
 * ```ts
 * const adopt = defineProfile({ id: 'adopt-existing', version: 1, target: 'metal', entry: 'adopt',
 *   acceptance: [{ use: 'diag.dcgm', with: { level: 1 }, fallback: 'diag.nvml' }] });
 * ```
 */
export function defineProfile(profile: ProfileDocument): ProfileDocument {
  checkProfile(profile);
  return deepFreeze(structuredClone(profile));
}
