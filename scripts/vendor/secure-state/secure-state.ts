import {
  existsSync,
  mkdirSync,
  statSync,
  lstatSync,
  chmodSync,
  fchmodSync,
  openSync,
  writeSync,
  readFileSync,
  closeSync,
  accessSync,
  renameSync,
  rmSync,
  rmdirSync,
  constants,
} from 'fs';
import { randomUUID } from 'crypto';
import { basename, dirname, join } from 'path';
import { homedir } from 'os';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_LOCK_STALE_MS = 45 * 60 * 1000;
const LOCK_RECLAIM_GUARD_STALE_MS = 30_000;

function candidateBases(): string[] {
  const bases: string[] = [];
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && xdg.trim().length > 0) {
    bases.push(join(xdg, 'biz-secure-state'));
  }
  const home = homedir();
  const hasUsableHome = typeof home === 'string' && home.trim().length > 0 && home !== '/';
  if (hasUsableHome) {
    bases.push(join(home, '.cache', 'biz-secure-state'));
  }
  const repoRoot = process.env.BIZ_ROOT || (hasUsableHome ? join(home, 'biz') : '');
  if (repoRoot) {
    bases.push(join(repoRoot, 'var', 'secure-state'));
  }
  return bases;
}

function ensureSecureDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const linkStat = lstatSync(dir);
    if (linkStat.isSymbolicLink()) return false;
    const stat = statSync(dir);
    if (!stat.isDirectory()) return false;
    if ((stat.mode & 0o777) !== DIR_MODE) {
      chmodSync(dir, DIR_MODE);
    }
    const tightened = statSync(dir);
    if ((tightened.mode & 0o077) !== 0) return false;
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function sanitizeSegment(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9._-]/g, '_');
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    throw new Error(`secure-state: invalid path segment ${JSON.stringify(segment)}`);
  }
  return cleaned;
}

function resolveBase(): string {
  const candidates = candidateBases();
  for (const base of candidates) {
    if (ensureSecureDir(base)) {
      return base;
    }
  }
  throw new Error(
    'secure-state: no writable owner-private base directory found (tried: ' +
      `${candidates.join(', ')}). Set XDG_RUNTIME_DIR, or make $HOME/.cache or ` +
      '<repo>/var writable, before running this browser-automation command.',
  );
}

export function secureStateDir(service: string): string {
  const dir = join(resolveBase(), sanitizeSegment(service));
  if (!ensureSecureDir(dir)) {
    throw new Error(
      `secure-state: could not create an owner-private (0700) directory for ` +
        `service ${JSON.stringify(service)} at ${dir}.`,
    );
  }
  return dir;
}

export function secureStatePath(service: string, name: string): string {
  return join(secureStateDir(service), sanitizeSegment(name));
}

export function secureWrite(path: string, data: string | Buffer): void {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
  let fd: number;
  try {
    fd = openSync(path, flags, FILE_MODE);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      throw new Error(`secure-state: refusing to write through a symlink at ${path}`);
    }
    throw err;
  }
  try {
    fchmodSync(fd, FILE_MODE);
    writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
  } finally {
    closeSync(fd);
  }
}

function jsonString(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function corruptSuffix(): string {
  return new Date().toISOString().replace(/[^0-9A-Za-z.-]/g, '-');
}

export function secureReadJson<T>(path: string): T | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    const quarantinePath = `${path}.corrupt-${corruptSuffix()}`;
    try {
      renameSync(path, quarantinePath);
    } catch {
    }
    throw new Error(
      `secure-state: failed to parse JSON at ${path}; quarantined as ${quarantinePath}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function secureWriteJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!ensureSecureDir(dir)) {
    throw new Error(`secure-state: parent directory for ${path} is not owner-private`);
  }
  const tempPath = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    secureWrite(tempPath, jsonString(value));
    renameSync(tempPath, path);
    chmodSync(path, FILE_MODE);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export interface SecureStateLock {
  path: string;
  fd: number;
}

interface LockMetadata {
  pid?: number;
  createdAt?: string;
  owner?: string;
}

export interface SecureStateLockOptions {
  staleMs?: number;
  owner?: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockMetadata(path: string): LockMetadata | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockMetadata;
  } catch {
    return null;
  }
}

function isValidLockMetadata(
  metadata: LockMetadata | null,
): metadata is Required<Pick<LockMetadata, 'pid' | 'createdAt'>> & LockMetadata {
  return (
    metadata !== null &&
    Number.isInteger(metadata.pid) &&
    (metadata.pid ?? 0) > 0 &&
    typeof metadata.createdAt === 'string' &&
    Number.isFinite(new Date(metadata.createdAt).getTime())
  );
}

function withLockReclaimGuard<T>(path: string, operation: () => T): T {
  const guardPath = `${path}.reclaiming`;
  let acquired = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(guardPath, { mode: DIR_MODE });
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(guardPath).mtimeMs > LOCK_RECLAIM_GUARD_STALE_MS) {
          rmdirSync(guardPath);
          continue;
        }
      } catch (guardError) {
        if ((guardError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw guardError;
      }
      throw new Error(`secure-state: lock arbitration already in progress at ${path}`);
    }
  }

  if (!acquired) {
    throw new Error(`secure-state: could not arbitrate lock acquisition at ${path}`);
  }
  try {
    return operation();
  } finally {
    try { rmdirSync(guardPath); } catch {   }
  }
}

function quarantineStaleLock(path: string): void {
  const quarantinePath = `${path}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  rmSync(quarantinePath, { force: true });
}

export function acquireSecureStateLock(
  service: string,
  name: string,
  options: SecureStateLockOptions = {},
): SecureStateLock {
  const path = secureStatePath(service, `${name}.lock`);
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;

  return withLockReclaimGuard(path, () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let fd: number | undefined;
      try {
        fd = openSync(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          FILE_MODE,
        );
        const payload: LockMetadata = {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          owner: options.owner,
        };
        writeSync(fd, Buffer.from(jsonString(payload)));
        fchmodSync(fd, FILE_MODE);
        return { path, fd };
      } catch (error) {
        if (fd !== undefined) {
          try { closeSync(fd); } catch {   }
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          throw error;
        }

        const metadata = readLockMetadata(path);
        if (!isValidLockMetadata(metadata)) {
          let lockAgeMs: number;
          try {
            lockAgeMs = Date.now() - statSync(path).mtimeMs;
          } catch (statError) {
            if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
              continue;
            }
            throw statError;
          }
          if (lockAgeMs > staleMs) {
            quarantineStaleLock(path);
            continue;
          }
          throw new Error(
            `secure-state: lock already held at ${path}; metadata is invalid but the lock file is not stale`,
          );
        }

        const createdAtMs = new Date(metadata.createdAt).getTime();
        const tooOld = Date.now() - createdAtMs > staleMs;
        const processDead = !isProcessAlive(metadata.pid);
        if (processDead) {
          quarantineStaleLock(path);
          continue;
        }
        if (tooOld) {
          throw new Error(
            `secure-state: lock ${path} is stale by age but still owned by live pid ${metadata.pid}; ` +
              'refusing to steal active lock',
          );
        }
        throw new Error(`secure-state: lock already held at ${path}`);
      }
    }

    throw new Error(`secure-state: could not acquire lock at ${path}`);
  });
}

export function releaseSecureStateLock(lock: SecureStateLock | null | undefined): void {
  if (!lock) {
    return;
  }
  try {
    closeSync(lock.fd);
  } catch {
  }
  try {
    const metadata = readLockMetadata(lock.path);
    if (metadata?.pid === process.pid) {
      rmSync(lock.path, { force: true });
    }
  } catch {
  }
}

export async function withSecureStateLock<T>(
  service: string,
  name: string,
  fn: () => T | Promise<T>,
  options: SecureStateLockOptions = {},
): Promise<T> {
  const lock = acquireSecureStateLock(service, name, options);
  try {
    return await fn();
  } finally {
    releaseSecureStateLock(lock);
  }
}
