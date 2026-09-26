import { createStore, type Store } from './store.js';
import type { ComputeRequester } from './resources.js';

// The reservation form (PLAN.md §3.4, §10.3): field validation that mirrors the server's
// `reservations.create` checks (the server still validates), a live "would it fit now" preview
// through `capacity.preview`, and submission with one idempotency key per attempt, so a retry, a
// double click or a person approving a held-back request (CONFIRMATION_REQUIRED, §3.4 step 7)
// never books twice.

export interface ReservationFormValues {
  poolId: string;
  gpus: number;
  /** `30m`, `8h`, `3d`. */
  duration: string;
  gpuModel?: string;
  gpuProduct?: string;
  nvlink?: boolean;
  /** Extra device constraints: `[{ key, op, values }]`. */
  selector?: { key: string; op: string; values?: unknown[] }[];
  projectId?: string;
  /** Epoch ms; absent: now. */
  start?: number;
  /** A renewable lease in seconds. */
  leaseSeconds?: number;
  /** (v1.1) Host CPUs to book with the GPUs; absent: the pool's per-GPU share (the floor). */
  vcpu?: number;
  /** (v1.1) Host memory in GiB to book with the GPUs; absent: the pool's per-GPU share. */
  memoryGiB?: number;
  /** (v1.1) Give the GPUs to the node's kubelet (pools that join a Kubernetes cluster). */
  kubernetes?: boolean;
}

export type ReservationFormErrors = Partial<Record<keyof ReservationFormValues, string>>;

export interface ReservationFormState {
  values: Partial<ReservationFormValues>;
  errors: ReservationFormErrors;
  preview?: { fits: boolean; reason?: string; candidates: number };
  previewing: boolean;
  status: 'editing' | 'submitting' | 'awaiting-confirmation' | 'done' | 'error';
  /** The key this attempt uses; kept across retries, renewed by `reset`. */
  idempotencyKey: string;
  confirmationId?: string;
  reservation?: Record<string, unknown>;
  error?: unknown;
}

export interface ReservationForm extends Store<ReservationFormState> {
  /** Updates fields, re-validates, and schedules a preview when the form is valid. */
  change(values: Partial<ReservationFormValues>): void;
  /** Creates the reservation (or retries the same attempt, e.g. after a person approved it). */
  submit(): Promise<ReservationFormState>;
  /** Starts a new attempt with a new idempotency key. */
  reset(values?: Partial<ReservationFormValues>): void;
}

const durationPattern = /^(\d+(ms|s|m|h|d))+$/;
const selectorOps = ['In', 'NotIn', 'Exists', 'DoesNotExist', 'Gt', 'Gte', 'Lt', 'Lte'];

/** The server's `reservations.create` field rules, for immediate feedback. */
export function validateReservation(values: Partial<ReservationFormValues>): ReservationFormErrors {
  const errors: ReservationFormErrors = {};
  if (!values.poolId) errors.poolId = 'Choose a pool';
  if (!Number.isInteger(values.gpus) || values.gpus! < 1 || values.gpus! > 64)
    errors.gpus = 'Whole GPUs, 1 to 64';
  if (!values.duration || !durationPattern.test(values.duration))
    errors.duration = 'A duration such as 30m, 8h or 3d';
  if (values.gpuModel !== undefined && !/^[A-Za-z0-9-]{1,64}$/.test(values.gpuModel))
    errors.gpuModel = 'A GPU model such as H100';
  if (values.gpuProduct !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(values.gpuProduct))
    errors.gpuProduct = 'A GPU product such as H100-SXM5-80GB';
  if (
    values.selector?.some(
      (entry) =>
        !/^[A-Za-z][A-Za-z0-9._/-]{0,127}$/.test(entry.key) || !selectorOps.includes(entry.op),
    )
  )
    errors.selector = `Each constraint needs a key and one of ${selectorOps.join(', ')}`;
  if (values.start !== undefined && (!Number.isFinite(values.start) || values.start < 0))
    errors.start = 'A start time';
  if (
    values.leaseSeconds !== undefined &&
    (!Number.isInteger(values.leaseSeconds) ||
      values.leaseSeconds < 30 ||
      values.leaseSeconds > 86_400)
  )
    errors.leaseSeconds = 'A lease of 30 s to 24 h';
  if (values.vcpu !== undefined && (!Number.isInteger(values.vcpu) || values.vcpu < 0 || values.vcpu > 4096))
    errors.vcpu = 'Host CPUs, 0 to 4096';
  if (
    values.memoryGiB !== undefined &&
    (!Number.isInteger(values.memoryGiB) || values.memoryGiB < 0 || values.memoryGiB > 65_536)
  )
    errors.memoryGiB = 'Host memory in GiB, 0 to 65536';
  return errors;
}

/** The host resources and binding a request carries (§3.8): only what the form sets. */
function hostFields(values: ReservationFormValues) {
  const resources: Record<string, number> = {};
  if (values.vcpu !== undefined) resources.vcpu = values.vcpu;
  if (values.memoryGiB !== undefined) resources.memoryGiB = values.memoryGiB;
  return {
    binding: values.kubernetes ? 'kubernetes' : 'hold',
    ...(Object.keys(resources).length ? { resources } : {}),
  };
}

/** The device request `reservations.create` and `capacity.preview` take. */
export function deviceRequest(values: ReservationFormValues) {
  const expressions: { key: string; op: string; values?: unknown[] }[] = [
    ...(values.selector ?? []),
  ];
  if (values.gpuModel) expressions.push({ key: 'gpuModel', op: 'In', values: [values.gpuModel] });
  if (values.gpuProduct)
    expressions.push({ key: 'gpuProduct', op: 'In', values: [values.gpuProduct] });
  return {
    class: 'gpu',
    count: values.gpus,
    ...(expressions.length ? { selector: { matchExpressions: expressions } } : {}),
    ...(values.nvlink ? { topology: 'nvlink-all' } : {}),
  };
}

const newKey = () => `console-${globalThis.crypto.randomUUID()}`;

export function createReservationForm(
  api: ComputeRequester,
  options: {
    tenantId: string;
    initial?: Partial<ReservationFormValues>;
    /** How long to wait after the last change before previewing (default 400 ms). */
    previewDelayMs?: number;
    setTimer?(callback: () => void, ms: number): unknown;
    clearTimer?(handle: unknown): void;
    newKey?: () => string;
  },
): ReservationForm {
  const key = options.newKey ?? newKey;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const initialValues = options.initial ?? {};
  const store = createStore<ReservationFormState>({
    values: initialValues,
    errors: validateReservation(initialValues),
    previewing: false,
    status: 'editing',
    idempotencyKey: key(),
  });
  let timer: unknown;
  let previewGeneration = 0;

  const body = (values: ReservationFormValues, idempotencyKey: string) => ({
    tenantId: options.tenantId,
    poolId: values.poolId,
    devices: [deviceRequest(values)],
    duration: values.duration,
    ...hostFields(values),
    idempotencyKey,
    ...(values.projectId ? { projectId: values.projectId } : {}),
    ...(values.start !== undefined ? { start: values.start } : {}),
    ...(values.leaseSeconds !== undefined ? { leaseSeconds: values.leaseSeconds } : {}),
  });

  const preview = async () => {
    const state = store.get();
    if (Object.keys(state.errors).length) return;
    const mine = ++previewGeneration;
    store.set((current) => ({ ...current, previewing: true }));
    try {
      const values = state.values as ReservationFormValues;
      // The preview takes the placement fields only (as `better-compute capacity --preview`),
      // host resources included: they decide where it fits.
      const result = await api.$request<{ fits: boolean; reason?: string; candidates?: unknown[] }>(
        'capacity/preview',
        {
          tenantId: options.tenantId,
          poolId: values.poolId,
          devices: [deviceRequest(values)],
          duration: values.duration,
          ...hostFields(values),
          idempotencyKey: key(),
        },
      );
      if (mine !== previewGeneration) return;
      store.set((current) => ({
        ...current,
        previewing: false,
        preview: {
          fits: result.fits,
          candidates: result.candidates?.length ?? 0,
          ...(result.reason ? { reason: result.reason } : {}),
        },
      }));
    } catch {
      if (mine !== previewGeneration) return;
      // A preview is advisory: a failure only hides it.
      store.set(({ preview: _old, ...current }) => ({ ...current, previewing: false }));
    }
  };

  return {
    get: store.get,
    subscribe: store.subscribe,
    change(values) {
      store.set((state) => {
        const next = { ...state.values, ...values };
        const { preview: _old, ...rest } = state;
        return { ...rest, values: next, errors: validateReservation(next) };
      });
      if (timer !== undefined) clearTimer(timer);
      timer = setTimer(() => {
        timer = undefined;
        void preview();
      }, options.previewDelayMs ?? 400);
    },
    async submit() {
      const state = store.get();
      if (Object.keys(state.errors).length) return state;
      if (state.status === 'submitting' || state.status === 'done') return state;
      store.set((current) => ({ ...current, status: 'submitting' }));
      try {
        const reservation = await api.$request<Record<string, unknown>>(
          'reservations/create',
          body(state.values as ReservationFormValues, state.idempotencyKey),
        );
        store.set(({ confirmationId: _c, error: _e, ...current }) => ({
          ...current,
          status: 'done',
          reservation,
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
    reset(values = initialValues) {
      if (timer !== undefined) clearTimer(timer);
      previewGeneration++;
      store.set({
        values,
        errors: validateReservation(values),
        previewing: false,
        status: 'editing',
        idempotencyKey: key(),
      });
    },
  };
}
