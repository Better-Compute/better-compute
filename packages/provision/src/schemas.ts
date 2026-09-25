import { strictObject, type InputSchema } from '@better-compute/core';

// JSON Schema descriptions of provision's method inputs (`validate.jsonSchema`), for the generated
// API reference and tool schemas. `describedBy(schemas.x, parse)` (core) checks the structure first
// (types, required and unknown fields, enums); the parsers in api.ts then apply the domain rules
// (patterns, ranges) and keep their messages.

// --- Fields ------------------------------------------------------------------------------------

const idOf = (prefix: string, description: string): InputSchema => ({
  type: 'string',
  pattern: `^${prefix}_[0-9a-hjkmnp-tv-z]{26,52}$`,
  maxLength: prefix.length + 53,
  description,
});
const tenantId: InputSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description: 'The tenant the call acts in',
};
const imageId = idOf('img', 'The catalog image');
const nodeId = idOf('node', 'The node the workflow runs on');
const workflowId = idOf('wf', 'The workflow');
const profileId: InputSchema = {
  type: 'string',
  pattern: '^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$',
  maxLength: 128,
  description: 'The profile id',
};
const profileVersion: InputSchema = {
  type: 'integer',
  minimum: 1,
  maximum: 1_000_000,
  description: 'The profile version (default: the latest)',
};
const visibility: InputSchema = {
  enum: ['private', 'public'],
  description: 'Who may use the profile',
};
const imageKind: InputSchema = { enum: ['os', 'ramdisk'], description: 'What the image boots as' };
const limit = (max: number, fallback: number): InputSchema => ({
  type: 'integer',
  minimum: 1,
  maximum: max,
  default: fallback,
  description: 'Page size',
});
const cursor: InputSchema = {
  type: 'string',
  maxLength: 256,
  description: 'The cursor of the previous page',
};
const text = (max: number, description: string): InputSchema => ({
  type: 'string',
  minLength: 1,
  maxLength: max,
  description,
});

const imageRef = strictObject({ tenantId, imageId }, ['tenantId', 'imageId']);
const profileRef = strictObject({ tenantId, profileId, profileVersion }, ['tenantId', 'profileId']);
const workflowFields = { tenantId, nodeId, workflowId };
const workflowRequired = ['tenantId', 'nodeId', 'workflowId'];

// --- Methods -----------------------------------------------------------------------------------

export const schemas = {
  registerImage: strictObject(
    {
      tenantId,
      ref: text(200, 'name@version, e.g. ubuntu-24.04@2026.09'),
      kind: { ...imageKind, default: 'os' },
      format: { enum: ['raw', 'qcow2', 'iso'], description: 'The disk format' },
      compression: { enum: ['none', 'zstd', 'gzip'], default: 'none' },
      sha256: {
        type: 'string',
        pattern: '^[0-9A-Fa-f]{64}$',
        minLength: 1,
        maxLength: 64,
        description: 'The digest of the image, 64 hex digits',
      },
      sizeBytes: { type: 'integer', minimum: 0 },
      source: text(2048, 'Where the image is fetched from: an https:// or oci:// URL'),
      signature: text(1024, "Base64 signature over the image's identity (kind, ref, format, compression, sha256)"),
      signerId: text(128, 'The registered signer whose key checks the signature'),
    },
    ['tenantId', 'ref', 'format', 'sha256', 'source'],
  ),
  imageRef,
  listImages: strictObject({ tenantId, kind: imageKind, limit: limit(200, 50), cursor }, ['tenantId']),

  createProfile: strictObject(
    {
      tenantId,
      document: { type: 'object', description: 'The profile document (id, version, target, steps…)' },
      visibility: { ...visibility, default: 'private' },
    },
    ['tenantId', 'document'],
  ),
  profileRef,
  listProfiles: strictObject({ tenantId, limit: limit(200, 50), cursor }, ['tenantId']),
  updateProfile: strictObject(
    {
      tenantId,
      profileId,
      profileVersion: { ...profileVersion, description: 'The version to change' },
      // Not typed: the parser passes it on, and the profile checks refuse a malformed document.
      document: { description: 'A replacement document, with the same id and version' },
      visibility,
      expectedVersion: {
        type: 'integer',
        minimum: 1,
        description: "The row's version you read; a mismatch is a conflict",
      },
    },
    ['tenantId', 'profileId', 'profileVersion'],
  ),
  deleteProfile: strictObject(
    { tenantId, profileId, profileVersion: { ...profileVersion, description: 'The version to delete (default: every version)' } },
    ['tenantId', 'profileId'],
  ),

  workflowRef: strictObject(workflowFields, workflowRequired),
  listWorkflows: strictObject({ tenantId, nodeId, limit: limit(100, 20), cursor }, ['tenantId', 'nodeId']),
  abortWorkflow: strictObject(
    { ...workflowFields, reason: { type: 'string', maxLength: 512, description: 'Recorded on the workflow' } },
    workflowRequired,
  ),
  retryWorkflow: strictObject(
    {
      ...workflowFields,
      fromStep: {
        type: 'string',
        maxLength: 256,
        description: 'The step id to start from (default: the first main step that did not succeed)',
      },
    },
    workflowRequired,
  ),
} satisfies Record<string, InputSchema>;
