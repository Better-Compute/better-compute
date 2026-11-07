import type { DoEmulator } from './index.js';
import type { Json } from './state.js';

// The billing endpoints under `/v2/customers/my` (DigitalOcean P9): balance, billing history, invoices with the
// month-to-date `invoice_preview`, and each invoice's items (paged). Shapes follow the OpenAPI `billing` resource
// (spec); the values are illustrative. A test fills `billingOf(emulator)` directly.

export interface EmulatedBilling {
  balance: Json;
  history: Json[];
  /** Final invoices, newest first, as the list answers them. */
  invoices: Json[];
  /** The month-to-date invoice; absent answers no `invoice_preview`. */
  preview?: Json;
  /** Invoice items by invoice uuid (the preview's too). */
  items: Map<string, Json[]>;
}

const billings = new WeakMap<DoEmulator, EmulatedBilling>();

/** The emulator's billing state. */
export function billingOf(emulator: DoEmulator): EmulatedBilling {
  let billing = billings.get(emulator);
  if (!billing) {
    billing = {
      balance: {
        month_to_date_balance: '23.44',
        account_balance: '12.23',
        month_to_date_usage: '11.21',
        generated_at: '2026-10-05T12:00:00Z',
      },
      history: [],
      invoices: [],
      items: new Map(),
    };
    billings.set(emulator, billing);
  }
  return billing;
}

/** An invoice item shaped like the spec's example. */
export function invoiceItem(over: Json = {}): Json {
  return {
    product: 'Droplets',
    resource_id: '100001',
    resource_uuid: '',
    group_description: '',
    description: 's-1vcpu-1gb',
    amount: '5.00',
    duration: '744',
    duration_unit: 'Hours',
    start_time: '2026-10-01T00:00:00Z',
    end_time: '2026-11-01T00:00:00Z',
    project_name: 'default',
    category: 'iaas',
    ...over,
  };
}

export function registerBilling(emulator: DoEmulator): void {
  emulator.route('GET', /^\/customers\/my\/balance$/, () => ({
    status: 200,
    body: structuredClone(billingOf(emulator).balance),
  }));
  emulator.route('GET', /^\/customers\/my\/billing_history$/, (context) =>
    emulator.paged(context, 'billing_history', billingOf(emulator).history),
  );
  emulator.route('GET', /^\/customers\/my\/invoices$/, (context) => {
    const billing = billingOf(emulator);
    const page = emulator.paged(context, 'invoices', billing.invoices);
    return {
      ...page,
      body: {
        ...(page.body as Json),
        ...(billing.preview ? { invoice_preview: structuredClone(billing.preview) } : {}),
      },
    };
  });
  emulator.route('GET', /^\/customers\/my\/invoices\/([^/]+)$/, (context) => {
    const items = billingOf(emulator).items.get(decodeURIComponent(context.match[1]!));
    if (!items) return emulator.error('not-found');
    return emulator.paged(context, 'invoice_items', items);
  });
}
