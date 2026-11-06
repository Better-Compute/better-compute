import type { AwsEmulator, EmulatorRequest } from './index.js';
import { jsonError } from './xml.js';

/** One product of the Price List (AmazonEC2), with one on-demand price. */
export interface PriceProduct {
  sku: string;
  productFamily: string;
  attributes: Readonly<Record<string, string>>;
  /** Decimal text per `unit`. */
  price: string;
  unit: string;
  currency?: string;
}

/** A Compute Instance product in Linux, shared tenancy, on demand, no preinstalled software. */
export function instanceProduct(
  sku: string,
  instanceType: string,
  shape: { vcpu: number; memoryGiB: number; gpu?: number },
  price: string,
  region = 'us-east-1',
  extra: Record<string, string> = {},
): PriceProduct {
  return {
    sku,
    productFamily: 'Compute Instance',
    attributes: {
      instanceType,
      vcpu: String(shape.vcpu),
      memory: `${shape.memoryGiB} GiB`,
      ...(shape.gpu ? { gpu: String(shape.gpu) } : {}),
      regionCode: region,
      operatingSystem: 'Linux',
      tenancy: 'Shared',
      preInstalledSw: 'NA',
      capacitystatus: 'Used',
      licenseModel: 'No License required',
      marketoption: 'OnDemand',
      usagetype: `BoxUsage:${instanceType}`,
      ...extra,
    },
    price,
    unit: 'Hrs',
  };
}

/**
 * The Price List Query API (`AWSPriceListService`, JSON 1.1): GetProducts over `products` with TERM_MATCH filters
 * on attributes (and productFamily), paged by `pageSize`; each PriceList entry is a JSON string, as AWS sends it.
 */
export class PricingEmulator {
  readonly products: PriceProduct[] = [];
  pageSize = 100;
  /** Answer this body instead (malformed-response tests). */
  rawNext: string | undefined;
  /** Every GetProducts request body. */
  readonly queries: Record<string, unknown>[] = [];

  constructor(private readonly emu: AwsEmulator) {
    emu.register(/^api\.pricing\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/, {
      service: 'pricing',
      protocol: 'json',
      handle: (request) => this.#handle(request),
    });
  }

  #handle(request: EmulatorRequest): Response {
    if (!request.headers.get('x-amz-target')?.startsWith('AWSPriceListService.'))
      return jsonError('UnknownOperationException', 'wrong target prefix');
    if (request.operation !== 'GetProducts')
      return jsonError('UnknownOperationException', `no operation ${request.operation}`);
    if (this.rawNext !== undefined) {
      const body = this.rawNext;
      this.rawNext = undefined;
      return new Response(body, { status: 200 });
    }
    const body = JSON.parse(request.body || '{}') as {
      ServiceCode?: string;
      Filters?: { Type: string; Field: string; Value: string }[];
      MaxResults?: number;
      NextToken?: string;
      FormatVersion?: string;
    };
    this.queries.push(body as Record<string, unknown>);
    if (body.ServiceCode !== 'AmazonEC2') return jsonError('InvalidParameterException', 'service');
    if ((body.MaxResults ?? 100) > 100)
      return jsonError('InvalidParameterException', 'MaxResults is at most 100');
    const matching = this.products.filter((product) =>
      (body.Filters ?? []).every((filter) => {
        if (filter.Type !== 'TERM_MATCH') return false;
        const value =
          filter.Field === 'productFamily'
            ? product.productFamily
            : product.attributes[filter.Field];
        return value === filter.Value;
      }),
    );
    const size = Math.min(this.pageSize, body.MaxResults ?? 100);
    const start = Number(body.NextToken ?? '0');
    const page = matching.slice(start, start + size);
    const next = start + size < matching.length ? String(start + size) : undefined;
    return new Response(
      JSON.stringify({
        FormatVersion: 'aws_v1',
        PriceList: page.map((product) =>
          JSON.stringify({
            product: {
              productFamily: product.productFamily,
              attributes: product.attributes,
              sku: product.sku,
            },
            serviceCode: 'AmazonEC2',
            terms: {
              OnDemand: {
                [`${product.sku}.JRTCKXETXF`]: {
                  offerTermCode: 'JRTCKXETXF',
                  sku: product.sku,
                  priceDimensions: {
                    [`${product.sku}.JRTCKXETXF.6YS6EN2CT7`]: {
                      unit: product.unit,
                      beginRange: '0',
                      endRange: 'Inf',
                      pricePerUnit: { [product.currency ?? 'USD']: product.price },
                    },
                  },
                },
              },
              Reserved: {
                [`${product.sku}.4NA7Y494T4`]: {
                  priceDimensions: {
                    x: { unit: 'Hrs', pricePerUnit: { USD: '0.0000000001' } },
                  },
                },
              },
            },
          }),
        ),
        ...(next ? { NextToken: next } : {}),
      }),
      { status: 200, headers: { 'content-type': 'application/x-amz-json-1.1' } },
    );
  }
}
