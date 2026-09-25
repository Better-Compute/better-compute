import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// One IAM + compute stack per process, kept across Next.js dev reloads. The configuration and the libraries it
// imports are loaded by Node at runtime (never bundled): better-compute and better-iam run native stores.
// Created at server start by `instrumentation.ts`; pages import it through `stack.ts` (server-only).

export interface ConsoleStack {
  iam: {
    handler(request: Request): Promise<Response>;
    api: any;
    authenticate?(input: unknown): Promise<unknown>;
    require(input: unknown): Promise<void>;
    authorizeMany(input: unknown): Promise<unknown>;
    endpoint?: { origin: string; basePath: string; secure?: boolean };
  };
  compute: { handler(request: Request): Promise<Response>; endpoint: { basePath: string } };
  rootTenantId: string;
  origin: string;
}

const shared = globalThis as typeof globalThis & { __betterComputeConsole?: Promise<ConsoleStack> };

async function create(): Promise<ConsoleStack> {
  const url = pathToFileURL(
    resolve(process.cwd(), process.env.CONSOLE_CONFIG ?? 'console.config.mjs'),
  ).href;
  const { createStack } = (await import(/* webpackIgnore: true */ url)) as {
    createStack(): Promise<ConsoleStack>;
  };
  return createStack();
}

export function getStack(): Promise<ConsoleStack> {
  shared.__betterComputeConsole ??= create().catch((error: unknown) => {
    // A failed start (a locked store, a bad secret) is retried on the next request, not cached forever.
    shared.__betterComputeConsole = undefined;
    throw error;
  });
  return shared.__betterComputeConsole;
}
