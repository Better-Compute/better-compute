import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

// The transport to a DOKS cluster's own Kubernetes API: `node:https`, trusting only the cluster's
// CA (no public roots). The bearer token is only ever put in the authorization header; it is never
// logged and never put in an error message.

/** One request to a cluster's Kubernetes API. */
export interface KubeRequest {
  /** `https://<endpoint host>/<path>`. */
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** JSON-encoded when present. */
  body?: unknown;
  /** The cluster's CA certificate (PEM): the only CA the connection trusts. */
  caPem: string;
  /** The bearer token. */
  token: string;
  signal: AbortSignal;
}

/** The answer: the HTTP status and the parsed JSON body (undefined when it was not JSON). */
export interface KubeResponse {
  status: number;
  body: unknown;
}

/**
 * Sends one request to a cluster's Kubernetes API. Rejects only when no HTTP answer came back (the
 * network, TLS, a timeout or the signal); any HTTP status resolves.
 */
export type KubeTransport = (request: KubeRequest) => Promise<KubeResponse>;

const maxResponseBytes = 1 << 20;
const timeoutMs = 30_000;

/** The default transport: `node:https` with `ca` set to the cluster's CA only. */
export const httpsKubeTransport: KubeTransport = (req) =>
  new Promise<KubeResponse>((resolve, reject) => {
    const url = new URL(req.url);
    if (url.protocol !== 'https:') {
      reject(new Error('The Kubernetes API is only reached over https'));
      return;
    }
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
    const payload = req.body !== undefined ? JSON.stringify(req.body) : undefined;
    const call = httpsRequest(
      {
        protocol: 'https:',
        hostname: host,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: req.method,
        ca: req.caPem,
        // SNI takes a host name only (RFC 6066); an IP endpoint is checked against the IP SANs.
        ...(isIP(host) ? {} : { servername: host }),
        rejectUnauthorized: true,
        agent: false,
        signal: req.signal,
        timeout: timeoutMs,
        headers: {
          authorization: `Bearer ${req.token}`,
          accept: 'application/json',
          ...(payload !== undefined
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxResponseBytes) {
            response.destroy(new Error('The Kubernetes API answer is too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown;
          try {
            body = text ? JSON.parse(text) : {};
          } catch {
            body = undefined;
          }
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    call.on('timeout', () => call.destroy(new Error('The Kubernetes API did not answer in time')));
    call.on('error', reject);
    call.end(payload);
  });
