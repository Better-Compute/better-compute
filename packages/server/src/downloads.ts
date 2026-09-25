import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { BlobStore } from '@better-compute/core';

// The daemon downloads route (PLAN.md §6 "Release artifacts", §9.1 GET routes): the install script
// fetches the bare `bcd` binary from `GET {basePath}/downloads/bcd/{version}/{os}-{arch}` and checks
// it against the sha256 of the verified release manifest it has baked in, so the route itself is
// public and needs no signature. Served from `downloads.blob` (key `{product}/{version}/{file}`) or
// `downloads.dir` (`{dir}/{file}`), where `{file}` is goreleaser's name: the bare binary
// `bcd_{version}_{os}_{arch}`, or a plugin archive such as `bcx-ipmi_{version}_{os}_{arch}.tar.gz`
// (`GET …/downloads/bcx-ipmi/{version}/{os}-{arch}`).

export interface DownloadsOptions {
  /** A directory holding goreleaser's bare binaries. */
  dir?: string;
  /** A blob store holding them under `bcd/{version}/bcd_{version}_{os}_{arch}`. */
  blob?: BlobStore;
}

/**
 * The products the route serves, by name (never a free-form one), and each one's goreleaser file:
 * bcd as a bare binary, the bcx plugins bcd's release ships (bcx-ipmi, the site agent's ipmitool BMC
 * driver) as archives. Their digests are in the same signed release manifest.
 */
const products: Readonly<Record<string, (version: string, os: string, arch: string) => string>> = {
  bcd: (version, os, arch) => `bcd_${version}_${os}_${arch}`,
  'bcx-ipmi': (version, os, arch) => `bcx-ipmi_${version}_${os}_${arch}.tar.gz`,
};

/** A product, a semantic version (an optional leading `v` is ignored), the one OS and two arches. */
const downloadPath =
  /^downloads\/([a-z][a-z0-9-]{0,31})\/v?(\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.]{1,40})?)\/(linux)-(amd64|arm64)$/;

/** The artifact for a download path (product, version, file name), or undefined when there is none. */
export function downloadArtifact(
  path: string,
): { product: string; version: string; file: string } | undefined {
  const match = downloadPath.exec(path);
  if (!match) return undefined;
  const [, product, version, os, arch] = match as unknown as [string, string, string, string, string];
  const file = Object.hasOwn(products, product) ? products[product]!(version, os, arch) : undefined;
  return file ? { product, version, file } : undefined;
}

/** bcd's artifact for a download path, or undefined when the path is not one. */
export function bcdArtifact(path: string): { version: string; file: string } | undefined {
  const artifact = downloadArtifact(path);
  return artifact?.product === 'bcd' ? { version: artifact.version, file: artifact.file } : undefined;
}

/**
 * Answers `downloads/...` paths: the binary, or `undefined` for a path that is no artifact or an
 * artifact the deployment does not have (the caller answers 404 either way).
 */
export async function serveDownload(
  downloads: DownloadsOptions | undefined,
  path: string,
  headers: Record<string, string>,
): Promise<Response | undefined> {
  const artifact = downloadArtifact(path);
  if (!artifact || !downloads) return undefined;
  const answer = (body: ReadableStream<Uint8Array>, size?: number) =>
    new Response(body, {
      headers: {
        ...headers,
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${artifact.file}"`,
        // Versioned and verified by digest: safe to cache for good.
        'cache-control': 'public, max-age=31536000, immutable',
        ...(size !== undefined ? { 'content-length': String(size) } : {}),
      },
    });
  if (downloads.blob) {
    const body = await downloads.blob.get(`${artifact.product}/${artifact.version}/${artifact.file}`);
    if (body) return answer(body);
  }
  if (downloads.dir) {
    const file = join(downloads.dir, artifact.file);
    try {
      const info = await stat(file);
      if (info.isFile())
        return answer(
          Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>,
          info.size,
        );
    } catch {
      // Absent: 404.
    }
  }
  return undefined;
}
