// S3 fake: objects, multipart uploads, virtual-hosted and path-style addressing, presigned access
// (checked by the emulator core) and the headers each write carried.
import { createHash } from 'node:crypto';
import { AwsEmulator, EmuError, escapeXml, xmlResponse } from './index.js';

export interface FakeObject {
  body: Buffer;
  headers: Record<string, string>;
  etag: string;
}

export function s3Fake(emu: AwsEmulator, options: { baseHost?: string } = {}) {
  const baseHost = options.baseHost ?? 'emu.local';
  const buckets = new Map<string, Map<string, FakeObject>>();
  const uploads = new Map<string, { bucket: string; key: string; parts: Map<number, { body: Buffer; etag: string }>; headers: Record<string, string> }>();
  const aborted: string[] = [];
  let nextUpload = 1;

  function locate(url: URL): { bucket: string; key: string; style: 'virtual' | 'path' } {
    const segments = url.pathname.split('/').slice(1).map((segment) => decodeURIComponent(segment));
    if (url.hostname !== baseHost && url.hostname.endsWith(`.${baseHost}`))
      return { bucket: url.hostname.slice(0, -baseHost.length - 1), key: segments.join('/'), style: 'virtual' };
    return { bucket: segments[0] ?? '', key: segments.slice(1).join('/'), style: 'path' };
  }

  function bucket(name: string): Map<string, FakeObject> {
    const found = buckets.get(name);
    if (!found) throw new EmuError('NoSuchBucket', 'The specified bucket does not exist', 404);
    return found;
  }

  const etagOf = (body: Buffer) => `"${createHash('md5').update(body).digest('hex')}"`;
  const kept = (headers: Record<string, string>) =>
    Object.fromEntries(Object.entries(headers).filter(([name]) => name === 'content-type' || (name.startsWith('x-amz-') && !['x-amz-date', 'x-amz-content-sha256', 'x-amz-security-token'].includes(name))));

  emu.register('s3', {
    protocol: 'rest-xml',
    operation(request) {
      const q = request.url.searchParams;
      switch (request.method) {
        case 'GET':
          return 'GetObject';
        case 'HEAD':
          return 'HeadObject';
        case 'PUT':
          return q.has('partNumber') ? 'UploadPart' : 'PutObject';
        case 'POST':
          return q.has('uploads') ? 'CreateMultipartUpload' : 'CompleteMultipartUpload';
        case 'DELETE':
          return q.has('uploadId') ? 'AbortMultipartUpload' : 'DeleteObject';
        default:
          return request.method;
      }
    },
    handle(request) {
      const { bucket: name, key } = locate(request.url);
      const objects = bucket(name);
      const q = request.url.searchParams;
      const body = Buffer.from(request.body);
      switch (request.operation) {
        case 'GetObject':
        case 'HeadObject': {
          const object = objects.get(key);
          if (!object) throw new EmuError('NoSuchKey', 'The specified key does not exist.', 404);
          return new Response(request.operation === 'HeadObject' ? null : object.body, {
            status: 200,
            headers: { etag: object.etag, 'content-type': object.headers['content-type'] ?? 'binary/octet-stream' },
          });
        }
        case 'PutObject': {
          const checksum = request.headers['x-amz-checksum-sha256'];
          if (checksum && checksum !== createHash('sha256').update(body).digest('base64'))
            throw new EmuError('BadDigest', 'checksum mismatch');
          const etag = etagOf(body);
          objects.set(key, { body, headers: kept(request.headers), etag });
          return new Response(null, { status: 200, headers: { etag } });
        }
        case 'DeleteObject':
          objects.delete(key);
          return new Response(null, { status: 204 });
        case 'CreateMultipartUpload': {
          const uploadId = `upload-${nextUpload++}`;
          uploads.set(uploadId, { bucket: name, key, parts: new Map(), headers: kept(request.headers) });
          return xmlResponse(`<InitiateMultipartUploadResult><Bucket>${escapeXml(name)}</Bucket><Key>${escapeXml(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
        }
        case 'UploadPart': {
          const upload = uploads.get(q.get('uploadId') ?? '');
          if (!upload) throw new EmuError('NoSuchUpload', 'no upload', 404);
          const etag = etagOf(body);
          upload.parts.set(Number(q.get('partNumber')), { body, etag });
          return new Response(null, { status: 200, headers: { etag } });
        }
        case 'CompleteMultipartUpload': {
          const uploadId = q.get('uploadId') ?? '';
          const upload = uploads.get(uploadId);
          if (!upload) throw new EmuError('NoSuchUpload', 'no upload', 404);
          const listed = [...body.toString('utf8').matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]+)<\/ETag>/g)].map((m) => ({
            number: Number(m[1]),
            etag: m[2]!.replace(/&quot;/g, '"'),
          }));
          let last = 0;
          for (const part of listed) {
            if (part.number <= last) throw new EmuError('InvalidPartOrder', 'parts out of order');
            last = part.number;
            if (upload.parts.get(part.number)?.etag !== part.etag) throw new EmuError('InvalidPart', 'unknown part');
          }
          const assembled = Buffer.concat(listed.map((part) => upload.parts.get(part.number)!.body));
          objects.set(key, { body: assembled, headers: upload.headers, etag: `"multipart-${listed.length}"` });
          uploads.delete(uploadId);
          return xmlResponse(`<CompleteMultipartUploadResult><Key>${escapeXml(key)}</Key><ETag>"multipart"</ETag></CompleteMultipartUploadResult>`);
        }
        case 'AbortMultipartUpload': {
          const uploadId = q.get('uploadId') ?? '';
          if (!uploads.delete(uploadId)) throw new EmuError('NoSuchUpload', 'no upload', 404);
          aborted.push(uploadId);
          return new Response(null, { status: 204 });
        }
        default:
          throw new EmuError('NotImplemented', request.operation, 501);
      }
    },
  });

  return {
    buckets,
    uploads,
    aborted,
    createBucket(name: string) {
      buckets.set(name, new Map());
    },
    object(bucketName: string, key: string): FakeObject | undefined {
      return buckets.get(bucketName)?.get(key);
    },
    locate,
  };
}
