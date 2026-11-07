import { createHash, createHmac } from 'node:crypto';

// An in-memory emulator of DigitalOcean Spaces' S3 API, path-style
// (`https://<region>.digitaloceanspaces.com/<bucket>/<key>`). Plug `emulator.fetch` into
// `spacesClient`/`spacesBlobStore`. It checks every request's SigV4 signature (header or presigned
// query) with its own canonicalization, independent of the provider's signer, so a header the
// client sends without signing, or a body that does not match its hash, is refused as Spaces would.

export interface SpacesObject {
  body: Uint8Array;
  contentType?: string;
}

export interface SpacesBucket {
  name: string;
  region: string;
  /** The access key id whose account owns it. */
  owner: string;
  acl: 'private' | 'public-read';
  versioning?: 'Enabled' | 'Suspended';
  objects: Map<string, SpacesObject>;
  /** Noncurrent versions and delete markers of a versioned bucket: version id → key. */
  noncurrent: Map<string, { key: string; deleteMarker: boolean }>;
}

export interface SpacesRecorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  bodyBytes: number;
}

interface Upload {
  bucket: string;
  key: string;
  contentType?: string;
  parts: Map<number, Uint8Array>;
}

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;
const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Uint8Array | string, data: string) =>
  createHmac('sha256', key).update(data).digest();
const enc = (v: string) =>
  encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export class SpacesEmulator {
  /** Access key id → secret key: the keys Spaces accepts. */
  keys = new Map<string, string>([['SPACESKEY', 'spaces-secret']]);
  /** Every bucket in every region, by name (Spaces names are global). */
  buckets = new Map<string, SpacesBucket>();
  uploads = new Map<string, Upload>();
  requests: SpacesRecorded[] = [];
  /** Statuses for the next matching requests (`'PUT bucket/key'`-style prefix match on `METHOD path`). */
  #failures: { match: string; status: number; code: string }[] = [];
  #uploadId = 0;
  now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * The next request whose `METHOD /bucket/key` starts with `match` (or equals it, when `match`
   * ends with a dollar sign) fails with this S3 error.
   */
  failNext(match: string, status: number, code: string): void {
    this.#failures.push({ match, status, code });
  }

  /** A bucket that already exists, owned by `owner` (default: the default key's account). */
  seedBucket(name: string, options: Partial<Omit<SpacesBucket, 'name' | 'objects'>> = {}) {
    const bucket: SpacesBucket = {
      name,
      region: options.region ?? 'nyc3',
      owner: options.owner ?? 'SPACESKEY',
      acl: options.acl ?? 'private',
      ...(options.versioning ? { versioning: options.versioning } : {}),
      objects: new Map(),
      noncurrent: new Map(),
    };
    this.buckets.set(name, bucket);
    return bucket;
  }

  #error(status: number, code: string, message = code): Response {
    return new Response(
      xml(
        `<Error><Code>${code}</Code><Message>${esc(message)}</Message><RequestId>req-1</RequestId></Error>`,
      ),
      { status, headers: { 'content-type': 'application/xml', 'x-amz-request-id': 'req-1' } },
    );
  }

  #canonicalQuery(url: URL, drop?: string): string {
    const pairs: [string, string][] = [];
    for (const [k, v] of url.searchParams) if (k !== drop) pairs.push([enc(k), enc(v)]);
    pairs.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
    return pairs.map(([k, v]) => `${k}=${v}`).join('&');
  }

  #sign(secret: string, date: string, region: string, toSign: string): string {
    const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), 's3'), 'aws4_request');
    return createHmac('sha256', key).update(toSign).digest('hex');
  }

  /** The access key id of a correctly signed request, or an error response. */
  #authenticate(
    method: string,
    url: URL,
    headers: Headers,
    body: Uint8Array,
  ): string | Response {
    const presigned = url.searchParams.get('X-Amz-Signature');
    if (presigned) {
      const credential = url.searchParams.get('X-Amz-Credential') ?? '';
      const [accessKey, date, region] = credential.split('/');
      const secret = this.keys.get(accessKey ?? '');
      if (!secret) return this.#error(403, 'InvalidAccessKeyId');
      const amzDate = url.searchParams.get('X-Amz-Date') ?? '';
      const expires = Number(url.searchParams.get('X-Amz-Expires'));
      const signedAt = Date.parse(
        `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
      );
      if (!(signedAt + expires * 1000 > this.now()))
        return this.#error(403, 'AccessDenied', 'Request has expired');
      const canonical = [
        method,
        url.pathname,
        this.#canonicalQuery(url, 'X-Amz-Signature'),
        `host:${url.host}\n`,
        'host',
        'UNSIGNED-PAYLOAD',
      ].join('\n');
      const toSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        `${date}/${region}/s3/aws4_request`,
        sha256(canonical),
      ].join('\n');
      if (this.#sign(secret, date!, region!, toSign) !== presigned)
        return this.#error(403, 'SignatureDoesNotMatch');
      return accessKey!;
    }
    const auth =
      /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
        headers.get('authorization') ?? '',
      );
    if (!auth) return this.#error(403, 'AccessDenied', 'Missing or malformed authorization');
    const [, accessKey, date, region, signedList, sig] = auth;
    const secret = this.keys.get(accessKey!);
    if (!secret) return this.#error(403, 'InvalidAccessKeyId');
    const signedNames = signedList!.split(';');
    // Every x-amz-* and content-type header that is sent must be signed.
    for (const [name] of headers)
      if ((name.startsWith('x-amz-') || name === 'content-type') && !signedNames.includes(name))
        return this.#error(403, 'AccessDenied', `header ${name} is not signed`);
    const payloadHash = headers.get('x-amz-content-sha256');
    if (!payloadHash) return this.#error(400, 'InvalidRequest', 'missing x-amz-content-sha256');
    if (payloadHash !== 'UNSIGNED-PAYLOAD' && payloadHash !== sha256(body))
      return this.#error(400, 'XAmzContentSHA256Mismatch');
    const value = (name: string) =>
      name === 'host' ? url.host : (headers.get(name) ?? '').trim().replace(/\s+/g, ' ');
    const canonical = [
      method,
      url.pathname,
      this.#canonicalQuery(url),
      signedNames.map((n) => `${n}:${value(n)}\n`).join(''),
      signedList,
      payloadHash,
    ].join('\n');
    const toSign = [
      'AWS4-HMAC-SHA256',
      headers.get('x-amz-date') ?? '',
      `${date}/${region}/s3/aws4_request`,
      sha256(canonical),
    ].join('\n');
    if (this.#sign(secret, date!, region!, toSign) !== sig)
      return this.#error(403, 'SignatureDoesNotMatch');
    return accessKey!;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body =
      init?.body instanceof Uint8Array
        ? init.body
        : typeof init?.body === 'string'
          ? new TextEncoder().encode(init.body)
          : new Uint8Array();
    this.requests.push({
      method,
      url,
      headers: Object.fromEntries(headers.entries()),
      bodyBytes: body.length,
    });
    const region = /^([a-z]{3}\d)\.digitaloceanspaces\.com$/.exec(url.hostname)?.[1];
    if (!region) return this.#error(400, 'InvalidRequest', 'unknown host');
    const owner = this.#authenticate(method, url, headers, body);
    if (owner instanceof Response) return owner;

    const [, bucketName = '', ...rest] = url.pathname.split('/');
    const key = rest.length ? rest.map(decodeURIComponent).join('/') : undefined;
    const line = `${method} ${decodeURIComponent(url.pathname)}`;
    const failure = this.#failures.findIndex((f) =>
      f.match.endsWith('$') ? line === f.match.slice(0, -1) : line.startsWith(f.match),
    );
    if (failure >= 0) {
      const [f] = this.#failures.splice(failure, 1);
      return this.#error(f!.status, f!.code);
    }
    const q = url.searchParams;
    const bucket = this.buckets.get(bucketName);

    if (key === undefined || key === '') {
      if (method === 'PUT' && !q.has('acl') && !q.has('versioning')) {
        if (bucket)
          return bucket.owner === owner
            ? this.#error(409, 'BucketAlreadyOwnedByYou')
            : this.#error(409, 'BucketAlreadyExists');
        this.seedBucket(bucketName, {
          region,
          owner,
          acl: headers.get('x-amz-acl') === 'public-read' ? 'public-read' : 'private',
        });
        return new Response(null, { status: 200 });
      }
      if (!bucket) return this.#error(404, 'NoSuchBucket');
      if (bucket.owner !== owner) return this.#error(403, 'AccessDenied');
      if (bucket.region !== region)
        return this.#error(301, 'PermanentRedirect', 'bucket is in another region');
      if (method === 'HEAD') return new Response(null, { status: 200 });
      if (method === 'DELETE') {
        if (bucket.objects.size || bucket.noncurrent.size)
          return this.#error(409, 'BucketNotEmpty');
        this.buckets.delete(bucketName);
        return new Response(null, { status: 204 });
      }
      if (method === 'PUT' && q.has('acl')) {
        bucket.acl = headers.get('x-amz-acl') === 'public-read' ? 'public-read' : 'private';
        return new Response(null, { status: 200 });
      }
      if (method === 'PUT' && q.has('versioning')) {
        const status = /<Status>(Enabled|Suspended)<\/Status>/.exec(
          new TextDecoder().decode(body),
        )?.[1];
        if (!status) return this.#error(400, 'MalformedXML');
        bucket.versioning = status as 'Enabled' | 'Suspended';
        return new Response(null, { status: 200 });
      }
      if (method === 'GET' && q.has('versioning'))
        return new Response(
          xml(
            `<VersioningConfiguration>${bucket.versioning ? `<Status>${bucket.versioning}</Status>` : ''}</VersioningConfiguration>`,
          ),
          { status: 200 },
        );
      if (method === 'GET' && q.has('acl'))
        return new Response(
          xml(
            `<AccessControlPolicy><AccessControlList>${bucket.acl === 'public-read' ? '<Grant><Grantee><URI>http://acs.amazonaws.com/groups/global/AllUsers</URI></Grantee><Permission>READ</Permission></Grant>' : ''}<Grant><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>`,
          ),
          { status: 200 },
        );
      if (method === 'GET' && q.has('versions')) {
        const prefix = q.get('prefix') ?? '';
        const entries = [
          ...[...bucket.objects.keys()]
            .filter((k) => k.startsWith(prefix))
            .map(
              (k) =>
                `<Version><Key>${esc(k)}</Key><VersionId>cur-${esc(k)}</VersionId><IsLatest>true</IsLatest></Version>`,
            ),
          ...[...bucket.noncurrent]
            .filter(([, v]) => v.key.startsWith(prefix))
            .map(([id, v]) =>
              v.deleteMarker
                ? `<DeleteMarker><Key>${esc(v.key)}</Key><VersionId>${id}</VersionId></DeleteMarker>`
                : `<Version><Key>${esc(v.key)}</Key><VersionId>${id}</VersionId></Version>`,
            ),
        ];
        return new Response(xml(`<ListVersionsResult>${entries.join('')}</ListVersionsResult>`), {
          status: 200,
        });
      }
      if (method === 'GET' && q.get('list-type') === '2') {
        const prefix = q.get('prefix') ?? '';
        const max = Math.min(1000, Number(q.get('max-keys') ?? 1000));
        const keys = [...bucket.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const page = keys.slice(0, max);
        return new Response(
          xml(
            `<ListBucketResult><Name>${bucketName}</Name><KeyCount>${page.length}</KeyCount><IsTruncated>${keys.length > max}</IsTruncated>${page
              .map((k) => `<Contents><Key>${esc(k)}</Key></Contents>`)
              .join('')}</ListBucketResult>`,
          ),
          { status: 200 },
        );
      }
      return this.#error(400, 'InvalidRequest', `${method} on a bucket is not emulated`);
    }

    if (!bucket) return this.#error(404, 'NoSuchBucket');
    if (bucket.owner !== owner) return this.#error(403, 'AccessDenied');
    if (method === 'POST' && q.has('uploads')) {
      const id = `up-${++this.#uploadId}`;
      this.uploads.set(id, {
        bucket: bucketName,
        key,
        ...(headers.get('content-type') ? { contentType: headers.get('content-type')! } : {}),
        parts: new Map(),
      });
      return new Response(
        xml(
          `<InitiateMultipartUploadResult><Bucket>${bucketName}</Bucket><Key>${esc(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        ),
        { status: 200 },
      );
    }
    const uploadId = q.get('uploadId');
    if (uploadId) {
      const upload = this.uploads.get(uploadId);
      if (!upload || upload.bucket !== bucketName || upload.key !== key)
        return this.#error(404, 'NoSuchUpload');
      if (method === 'PUT') {
        const part = Number(q.get('partNumber'));
        upload.parts.set(part, body);
        return new Response(null, { status: 200, headers: { etag: `"${sha256(body).slice(0, 32)}"` } });
      }
      if (method === 'DELETE') {
        this.uploads.delete(uploadId);
        return new Response(null, { status: 204 });
      }
      if (method === 'POST') {
        const listed = [
          ...new TextDecoder().decode(body).matchAll(
            /<Part><PartNumber>(\d+)<\/PartNumber><ETag>([^<]+)<\/ETag><\/Part>/g,
          ),
        ];
        const chunks: Uint8Array[] = [];
        for (const [, n, etag] of listed) {
          const part = upload.parts.get(Number(n));
          if (!part || `"${sha256(part).slice(0, 32)}"` !== etag?.replace(/&quot;/g, '"'))
            return this.#error(400, 'InvalidPart');
          chunks.push(part);
        }
        const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const c of chunks) {
          all.set(c, at);
          at += c.length;
        }
        bucket.objects.set(key, {
          body: all,
          ...(upload.contentType ? { contentType: upload.contentType } : {}),
        });
        this.uploads.delete(uploadId);
        return new Response(xml('<CompleteMultipartUploadResult/>'), { status: 200 });
      }
    }
    if (method === 'PUT') {
      if (bucket.versioning && bucket.objects.has(key))
        bucket.noncurrent.set(`v-${++this.#uploadId}`, { key, deleteMarker: false });
      bucket.objects.set(key, {
        body,
        ...(headers.get('content-type') ? { contentType: headers.get('content-type')! } : {}),
      });
      return new Response(null, { status: 200, headers: { etag: `"${sha256(body).slice(0, 32)}"` } });
    }
    const object = bucket.objects.get(key);
    if (method === 'GET' || method === 'HEAD') {
      if (!object) return this.#error(404, 'NoSuchKey');
      return new Response(method === 'HEAD' ? null : (object.body as BodyInit), {
        status: 200,
        headers: {
          'content-length': String(object.body.length),
          ...(object.contentType ? { 'content-type': object.contentType } : {}),
        },
      });
    }
    if (method === 'DELETE') {
      const versionId = q.get('versionId');
      if (versionId) {
        if (versionId === `cur-${key}`) bucket.objects.delete(key);
        else bucket.noncurrent.delete(versionId);
        return new Response(null, { status: 204 });
      }
      if (bucket.versioning && bucket.objects.has(key)) {
        bucket.noncurrent.set(`v-${++this.#uploadId}`, { key, deleteMarker: false });
        bucket.noncurrent.set(`dm-${++this.#uploadId}`, { key, deleteMarker: true });
      }
      bucket.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return this.#error(400, 'InvalidRequest');
  };

  /** A clock-consistent amz date for tests that build requests by hand. */
  amzDate(): string {
    return stamp(this.now());
  }
}
