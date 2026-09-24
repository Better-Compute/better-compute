import { createStore, type Store } from './store.js';
import type { ComputeRequester } from './resources.js';

// The instance form (PLAN.md §3.6, v0.3 vps): the pool's flavors loaded when a pool is chosen,
// validation that mirrors `instances.create` (the server still validates), and submission with one
// idempotency key per attempt, kept through CONFIRMATION_REQUIRED so an approved retry never creates
// two machines.

export interface InstanceFormValues {
  poolId: string;
  /** A flavor name the pool offers (`g1.small`). */
  flavor: string;
  /** An image the tenant may use (`ubuntu-24.04`). */
  imageId: string;
  sshKeys?: string[];
  userData?: string;
  desiredState?: 'running' | 'stopped';
  projectId?: string;
}

export type InstanceFormErrors = Partial<Record<keyof InstanceFormValues, string>>;

export interface FlavorOption {
  name: string;
  vcpu: number;
  memoryGiB: number;
  diskGiB: number;
  gpus?: number;
}

export interface InstanceFormState {
  values: Partial<InstanceFormValues>;
  errors: InstanceFormErrors;
  /** The chosen pool's flavors (loaded on pool change). */
  flavors: FlavorOption[];
  flavorsStatus: 'idle' | 'loading' | 'ready' | 'error';
  status: 'editing' | 'submitting' | 'awaiting-confirmation' | 'done' | 'error';
  idempotencyKey: string;
  confirmationId?: string;
  instance?: Record<string, unknown>;
  error?: unknown;
}

export interface InstanceForm extends Store<InstanceFormState> {
  change(values: Partial<InstanceFormValues>): void;
  submit(): Promise<InstanceFormState>;
  reset(values?: Partial<InstanceFormValues>): void;
}

const sshKeyPattern =
  /^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]+( .*)?$/;

export function validateInstance(
  values: Partial<InstanceFormValues>,
  flavors?: readonly FlavorOption[],
): InstanceFormErrors {
  const errors: InstanceFormErrors = {};
  if (!values.poolId || !/^pool_[0-9a-z]{26,52}$/.test(values.poolId))
    errors.poolId = 'Choose a pool';
  if (!values.flavor || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(values.flavor))
    errors.flavor = 'Choose a size';
  else if (flavors?.length && !flavors.some((flavor) => flavor.name === values.flavor))
    errors.flavor = 'This pool does not offer that size';
  if (!values.imageId || !/^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,199}$/.test(values.imageId))
    errors.imageId = 'Choose an image';
  if (values.sshKeys) {
    if (values.sshKeys.length > 32) errors.sshKeys = 'At most 32 keys';
    else if (
      values.sshKeys.some(
        (key) => key.length > 8192 || /[\r\n]/.test(key) || !sshKeyPattern.test(key),
      )
    )
      errors.sshKeys = 'Each key must be one OpenSSH public key line';
  }
  if (values.userData !== undefined && values.userData.length > 32_768)
    errors.userData = 'User data is limited to 32 KiB';
  return errors;
}

const newKey = () => `console-${globalThis.crypto.randomUUID()}`;

export function createInstanceForm(
  api: ComputeRequester,
  options: { tenantId: string; initial?: Partial<InstanceFormValues>; newKey?: () => string },
): InstanceForm {
  const key = options.newKey ?? newKey;
  const initial = options.initial ?? {};
  const store = createStore<InstanceFormState>({
    values: initial,
    errors: validateInstance(initial),
    flavors: [],
    flavorsStatus: 'idle',
    status: 'editing',
    idempotencyKey: key(),
  });
  let flavorGeneration = 0;

  const loadFlavors = async (poolId: string) => {
    const mine = ++flavorGeneration;
    store.set((state) => ({ ...state, flavors: [], flavorsStatus: 'loading' }));
    try {
      const { items } = await api.$request<{ items: FlavorOption[] }>('flavors/list', {
        tenantId: options.tenantId,
        poolId,
      });
      if (mine !== flavorGeneration) return;
      store.set((state) => ({
        ...state,
        flavors: items,
        flavorsStatus: 'ready',
        errors: validateInstance(state.values, items),
      }));
    } catch {
      if (mine !== flavorGeneration) return;
      store.set((state) => ({ ...state, flavorsStatus: 'error' }));
    }
  };

  return {
    get: store.get,
    subscribe: store.subscribe,
    change(values) {
      const before = store.get().values.poolId;
      store.set((state) => {
        const next = { ...state.values, ...values };
        return { ...state, values: next, errors: validateInstance(next, state.flavors) };
      });
      const poolId = store.get().values.poolId;
      if (poolId && poolId !== before && /^pool_[0-9a-z]{26,52}$/.test(poolId))
        void loadFlavors(poolId);
    },
    async submit() {
      const state = store.get();
      if (Object.keys(state.errors).length) return state;
      if (state.status === 'submitting' || state.status === 'done') return state;
      const values = state.values as InstanceFormValues;
      store.set((current) => ({ ...current, status: 'submitting' }));
      try {
        const instance = await api.$request<Record<string, unknown>>('instances/create', {
          tenantId: options.tenantId,
          poolId: values.poolId,
          flavor: values.flavor,
          imageId: values.imageId,
          ...(values.sshKeys?.length ? { sshKeys: values.sshKeys } : {}),
          ...(values.userData !== undefined ? { userData: values.userData } : {}),
          ...(values.desiredState ? { desiredState: values.desiredState } : {}),
          ...(values.projectId ? { projectId: values.projectId } : {}),
          idempotencyKey: state.idempotencyKey,
        });
        store.set(({ confirmationId: _c, error: _e, ...current }) => ({
          ...current,
          status: 'done',
          instance,
        }));
      } catch (error) {
        const failure = error as { code?: unknown; details?: { confirmationId?: unknown } };
        if (failure?.code === 'CONFIRMATION_REQUIRED')
          store.set((current) => ({
            ...current,
            status: 'awaiting-confirmation',
            ...(typeof failure.details?.confirmationId === 'string'
              ? { confirmationId: failure.details.confirmationId }
              : {}),
          }));
        else store.set((current) => ({ ...current, status: 'error', error }));
      }
      return store.get();
    },
    reset(values = initial) {
      flavorGeneration++;
      store.set({
        values,
        errors: validateInstance(values),
        flavors: [],
        flavorsStatus: 'idle',
        status: 'editing',
        idempotencyKey: key(),
      });
      if (values.poolId) void loadFlavors(values.poolId);
    },
  };
}
