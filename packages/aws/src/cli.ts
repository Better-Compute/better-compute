import { writeFile } from 'node:fs/promises';
import { ComputeError, type Clock } from '@better-compute/core';
import type { AwsCommandContext, CredentialSource } from './common.js';
import { toPem } from '@better-compute/pki';
import { kmsCaCsr } from './kms-ca.js';
import { generateKmsSealingKey } from './kms-sealing.js';

/** Host hooks for the `aws …` commands (tests pass an emulator). */
export interface AwsCommandOptions {
  credentials?: CredentialSource;
  fetch?: typeof fetch;
  endpoint?: string;
  clock?: Clock;
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN. The commands' default until
 * aws-core's ambient chain lands; a host can pass any `CredentialSource`.
 */
export function envCredentialSource(env: Readonly<Record<string, string | undefined>> = process.env): CredentialSource {
  return {
    kind: 'env',
    async credentials() {
      const accessKeyId = env.AWS_ACCESS_KEY_ID;
      const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
      if (!accessKeyId || !secretAccessKey)
        throw new ComputeError('UNAUTHENTICATED', 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set');
      return { accessKeyId, secretAccessKey, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) };
    },
  };
}

function stringFlag(context: AwsCommandContext, name: string): string | undefined {
  const value = context.flags[name];
  return value === undefined || value === false ? undefined : String(value);
}

export function regionFlag(context: AwsCommandContext, options: AwsCommandOptions): string {
  const region = stringFlag(context, 'region') ?? (options.env ?? process.env).AWS_REGION;
  if (!region) throw new ComputeError('INVALID_INPUT', '--region (or AWS_REGION) is required');
  return region;
}

export async function writeNewFile(path: string, text: string): Promise<void> {
  try {
    await writeFile(path, text, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new ComputeError('CONFLICT', `${path} exists; the command writes only a new file`);
    throw error;
  }
}

const regionFlagSpec = {
  type: 'string' as const,
  value: 'REGION',
  env: 'AWS_REGION',
  description: 'The AWS region of the key',
};

/** `better-compute aws kms-sealing-key --key-id <arn> [--out file]`: prints the wrapped key, never the plaintext. */
export function awsKmsSealingKeyCommand(options: AwsCommandOptions = {}) {
  return {
    name: 'aws kms-sealing-key' as const,
    group: 'Security' as const,
    summary: 'Generate a KMS-wrapped sealing key for the local-sealed secret store',
    description:
      'aws kms-sealing-key asks KMS for a new AES-256 data key under --key-id (GenerateDataKeyWithoutPlaintext, encryption context purpose=better-compute-sealing) and prints its ciphertext, base64, or writes it to --out (a new 0600 file). The plaintext never leaves KMS here: the host unwraps it at start with kmsSealingKeys and hands it to localSealedSecretStore. Add the new id to the wrapped set and make it current to rotate.',
    flags: {
      'key-id': { type: 'string' as const, value: 'ARN', required: true, description: 'The KMS key (id, ARN or alias) that wraps the sealing key' },
      region: regionFlagSpec,
      out: { type: 'string' as const, value: 'PATH', description: 'Write the wrapped key to this new file instead of the output' },
    },
    async run(context: AwsCommandContext): Promise<void> {
      const keyId = stringFlag(context, 'key-id');
      if (!keyId) throw new ComputeError('INVALID_INPUT', '--key-id is required');
      const wrapped = await generateKmsSealingKey({
        region: regionFlag(context, options),
        credentials: options.credentials ?? envCredentialSource(options.env),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        ...(options.clock ? { clock: options.clock } : {}),
        keyId,
      });
      const out = stringFlag(context, 'out');
      if (out) {
        await writeNewFile(context.path(out), `${wrapped}\n`);
        context.note(`Wrote the wrapped sealing key to ${out}.`);
      } else context.io.out(wrapped);
      context.note('Pass it to kmsSealingKeys({ wrapped: { <id>: … }, current: <id> }) at host start.');
    },
  };
}

/** `better-compute aws kms-ca-csr --key-id <arn> --common-name <cn>`: a CSR for a KMS-held CA key, signed by KMS. */
export function awsKmsCaCsrCommand(options: AwsCommandOptions = {}) {
  return {
    name: 'aws kms-ca-csr' as const,
    group: 'Security' as const,
    summary: 'Create a certificate request for a CA key held in KMS',
    description:
      'aws kms-ca-csr reads the public key of --key-id (an ECC_NIST_P256 SIGN_VERIFY KMS key), builds a PKCS#10 request for it with subject CN=--common-name (O=--organization, default better-compute), has KMS sign it, and prints it as PEM or writes it to --out (a new file). Certify it as a CA with the operator root (pki), then pass the certificate to kmsCertificateAuthority. The private key never leaves KMS.',
    flags: {
      'key-id': { type: 'string' as const, value: 'ARN', required: true, description: 'The KMS signing key (id, ARN or alias)' },
      'common-name': { type: 'string' as const, value: 'NAME', required: true, description: "The CA certificate's common name" },
      organization: { type: 'string' as const, value: 'NAME', description: 'The subject organization (default better-compute)' },
      region: regionFlagSpec,
      out: { type: 'string' as const, value: 'PATH', description: 'Write the PEM request to this new file instead of the output' },
    },
    async run(context: AwsCommandContext): Promise<void> {
      const keyId = stringFlag(context, 'key-id');
      const commonName = stringFlag(context, 'common-name');
      if (!keyId || !commonName) throw new ComputeError('INVALID_INPUT', '--key-id and --common-name are required');
      const organization = stringFlag(context, 'organization');
      const csr = await kmsCaCsr({
        region: regionFlag(context, options),
        credentials: options.credentials ?? envCredentialSource(options.env),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        ...(options.clock ? { clock: options.clock } : {}),
        keyId,
        subject: { commonName, ...(organization ? { organization } : {}) },
      });
      const pem = toPem(csr, 'CERTIFICATE REQUEST');
      const out = stringFlag(context, 'out');
      if (out) {
        await writeNewFile(context.path(out), pem);
        context.note(`Wrote the certificate request to ${out}.`);
      } else context.io.out(pem.trimEnd());
    },
  };
}
