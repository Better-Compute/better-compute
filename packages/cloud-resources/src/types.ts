import type { JsonSchema, ProviderResourceFamily, SecretRef } from '@better-compute/core';

/** A cloud resource's state, as the `cloud.resources` reconciler converges it. */
export type CloudResourceState =
  | 'pending'
  | 'provisioning'
  | 'ready'
  | 'updating'
  | 'deleting'
  | 'deleted'
  | 'released'
  | 'error';

/** One kind a pool's provider serves, as `cloudResources.kinds` lists it. */
export interface CloudResourceKindView {
  kind: string;
  family: ProviderResourceFamily;
  description?: string;
  /** JSON Schema of the kind's spec (from its manifest), when the manifest describes itself. */
  specSchema: JsonSchema;
  outputs: string[];
  /** Returned as SecretRefs only. */
  secretOutputs: string[];
  regional: boolean;
  updatable: string[];
  meters: { meter: string; unit: string }[];
  preview: boolean;
  /** Whether this account may create it now (a preview kind needs `previews: true` on the account). */
  available: boolean;
  parent?: string;
  /** How many of this kind a tenant may have that are not deleted. */
  quota: number;
}

/** A cloud resource as the API returns it. Secret outputs are SecretRefs, never values. */
export interface CloudResourceView {
  id: string;
  tenantId: string;
  projectId?: string;
  poolId: string;
  providerAccountId: string;
  provider: string;
  kind: string;
  family: ProviderResourceFamily;
  name: string;
  description?: string;
  region?: string;
  parentId?: string;
  spec: Record<string, unknown>;
  /** The provider-side name (`bc-r-…`). */
  providerName: string;
  /** The provider's id, once it accepted the resource. */
  providerId?: string;
  state: CloudResourceState;
  message?: string;
  outputs: Record<string, string>;
  secretOutputs: Record<string, SecretRef>;
  /** Taken over from the account (`cloudResources.adopt`), not created by better-compute. */
  adopted: boolean;
  version: number;
  createdAt: number;
  readyAt?: number;
  deletedAt?: number;
}

export interface KindsInput {
  tenantId: string;
  poolId: string;
}

export interface CreateResourceInput {
  tenantId: string;
  projectId?: string;
  poolId: string;
  kind: string;
  name: string;
  description?: string;
  /** For a kind with a parent: the cloud resource (of the parent kind) it lives in. */
  parentId?: string;
  spec: Record<string, unknown>;
  idempotencyKey: string;
}

export interface ListResourcesInput {
  tenantId: string;
  poolId?: string;
  projectId?: string;
  kind?: string;
  family?: ProviderResourceFamily;
  includeDeleted?: boolean;
}

export interface ResourceRef {
  tenantId: string;
  resourceId: string;
}

export interface UpdateResourceInput extends ResourceRef {
  /** Merged onto the stored spec; only the kind's `updatable` fields may change. */
  spec?: Record<string, unknown>;
  description?: string | null;
}

export interface CatalogInput {
  tenantId: string;
  poolId: string;
  /** Only what installs there. */
  installsOn?: 'instance' | 'kubernetes';
}

/** One installable application of the pool's provider (a 1-Click app): installed through another surface. */
export interface CatalogEntryView {
  slug: string;
  /** `instance`: as the image of an instance create; `kubernetes`: as an add-on of a managed cluster. */
  installsOn: 'instance' | 'kubernetes';
  name?: string;
}

export interface DiscoverInput {
  tenantId: string;
  poolId: string;
  kind: string;
}

export interface DiscoveredResourceView {
  providerId: string;
  name: string;
  region?: string;
  /** `this`: this control plane manages it; `other`: another deployment does; absent: unmanaged. */
  managedBy?: 'this' | 'other';
  /** The cloud resource that already records it, if any. */
  resourceId?: string;
  spec?: Record<string, unknown>;
}

export interface AdoptResourceInput {
  tenantId: string;
  projectId?: string;
  poolId: string;
  kind: string;
  providerId: string;
  name: string;
  description?: string;
  idempotencyKey: string;
}

export interface SignalsInput {
  tenantId: string;
  poolId: string;
  /** Only the signals about this cloud resource. */
  resourceId?: string;
}

/** A read-only signal the pool's provider raises about a resource (a managed agent asking for a human). */
export interface ResourceSignalView {
  /** The provider's id of the signal. */
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail?: string;
  /** When the provider raised it (epoch ms). */
  at: number;
  /** The kind of the resource it is about. */
  kind: string;
  /** The provider's id of that resource. */
  providerId: string;
  /** The cloud resource that records it, if any. */
  resourceId?: string;
}
