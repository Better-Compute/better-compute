import { open, rm, type FileHandle } from 'node:fs/promises';
import { CliError } from './errors.js';

// One-time secrets written to a file (--out, --secret-out): a join token, a site token, a webhook's
// signing secret. The server shows each once, and rotating one retires the old value, so the file
// must be ours before the call that mints it: a path that exists or cannot be created is refused
// while nothing has changed yet, and a call that fails leaves no file behind.

/**
 * Reserves `file` (created exclusively, mode 0600; never over an existing file), runs `produce`, and
 * writes `contentOf(result)` into it. `ALREADY_EXISTS` or `FILE_NOT_WRITABLE` before `produce` runs;
 * if `produce`, `contentOf` or the write fails, the reserved file is removed and the error passed on.
 * Returns what `produce` returned.
 */
export async function writeReserved<T>(file: string, produce: () => Promise<T>, contentOf: (result: T) => string): Promise<T> {
  let handle: FileHandle;
  try {
    handle = await open(file, 'wx', 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST')
      throw new CliError('ALREADY_EXISTS', `${file} exists; it is never written over`, 'Nothing was created or changed. Pass a path that does not exist yet.');
    throw new CliError(
      'FILE_NOT_WRITABLE',
      `${file} cannot be created (${code ?? (error instanceof Error ? error.message : String(error))})`,
      'Nothing was created or changed. Check the directory exists and is writable.',
    );
  }
  try {
    const result = await produce();
    await handle.writeFile(contentOf(result));
    await handle.close();
    return result;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(file, { force: true }).catch(() => undefined);
    throw error;
  }
}
