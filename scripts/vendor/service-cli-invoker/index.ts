import { spawn } from "node:child_process";
import { openSync, closeSync, mkdtempSync, readFileSync, rmSync, existsSync, readFileSync as fsReadFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import type { SideEffect } from "@local/cli-utils";
import {
  readCommandMetadataFile,
  resetCommandMetadataCacheForTests,
} from "./command-metadata.js";

export {
  parseCommandMetadataSource,
  readCommandMetadataFile,
} from "./command-metadata.js";

const DEFAULT_TIMEOUT_MS = 120_000;

const BIZ_ROOT = process.env.BIZ_ROOT?.trim() || join(homedir(), "biz");
const SERVICES_DIR = join(BIZ_ROOT, "scripts");


let cachedAllowlist: Set<string> | null = null;

function getAllowedServices(): Set<string> {
  if (cachedAllowlist) return cachedAllowlist;
  try {
    const pkgPath = join(BIZ_ROOT, "package.json");
    const pkg = JSON.parse(fsReadFileSync(pkgPath, "utf-8")) as {
      workspaces?: string[];
    };
    const set = new Set<string>();
    for (const ws of pkg.workspaces ?? []) {
      if (ws.startsWith("scripts/")) {
        const name = ws.slice("scripts/".length).replace(/\/$/, "");
        if (name && !name.includes("/")) set.add(name);
      }
    }
    cachedAllowlist = set;
    return set;
  } catch {
    cachedAllowlist = new Set();
    return cachedAllowlist;
  }
}


export interface InvokeOptions {
  timeoutMs?: number;
  ignoreErrors?: boolean;
  commandSideEffect?: SideEffect;
  confirm?: boolean;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
}

export interface InvokeResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  exitCode: number;
  durationMs: number;
  ignored?: boolean;
  envelope?: boolean;
}

export interface PaginatedInvokeOptions<TData = unknown, TItem = unknown> extends InvokeOptions {
  tokenArg?: string;
  initialToken?: string;
  maxPages?: number;
  maxItems?: number;
  extractItems?: (data: TData) => TItem[];
  extractNextToken?: (data: TData) => string | null | undefined;
}


interface CliInvocation {
  executable: string;
  args: string[];
  cwd: string;
}

function resolveTsxBin(serviceDir: string): string | null {
  const serviceLocal = join(serviceDir, "node_modules", ".bin", "tsx");
  if (existsSync(serviceLocal)) return serviceLocal;
  const repoRoot = join(BIZ_ROOT, "node_modules", ".bin", "tsx");
  if (existsSync(repoRoot)) return repoRoot;
  return null;
}

function resolveCliInvocation(
  service: string,
  command: string,
  argList: string[],
): { invocation: CliInvocation; error?: never } | { invocation?: never; error: string } {
  const serviceDir = join(SERVICES_DIR, service);
  const cliPath = join(serviceDir, "cli.ts");
  if (!existsSync(cliPath)) {
    return {
      error: `Service CLI missing for ${service} at ~/biz/scripts/${service}/cli.ts`,
    };
  }

  const tsxBin = resolveTsxBin(serviceDir);
  if (!tsxBin) {
    return {
      error:
        `No tsx runtime found for ${service}. Looked in ` +
        `~/biz/scripts/${service}/node_modules/.bin/tsx and ~/biz/node_modules/.bin/tsx. ` +
        `Install deps with: cd ~/biz && npm install`,
    };
  }

  return {
    invocation: {
      executable: tsxBin,
      args: [cliPath, command, ...argList],
      cwd: serviceDir,
    },
  };
}


function flattenArgs(args: Record<string, string | number | boolean | undefined> | undefined): string[] {
  if (!args) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const flag = `--${key}`;
    if (typeof value === "boolean") {
      if (value) out.push(flag, "true");
    } else {
      out.push(flag, String(value));
    }
  }
  return out;
}

export function readDeclaredCommandMetadata(service: string, command: string) {
  const cliPath = join(SERVICES_DIR, service, "cli.ts");
  if (!existsSync(cliPath)) {
    return { commandFound: true, error: `Service CLI missing: ${cliPath}` };
  }
  return readCommandMetadataFile(cliPath, command, SERVICES_DIR);
}

function looksLikeEnvelope(parsed: unknown): boolean {
  return (
    parsed !== null &&
    typeof parsed === "object" &&
    "_contentSafety" in (parsed as Record<string, unknown>) &&
    "content" in (parsed as Record<string, unknown>)
  );
}

function parseJsonStdout<T>(stdoutText: string): T {
  const starts = new Set<number>([0]);
  for (let index = 0; index < stdoutText.length; index += 1) {
    if (index > 0 && stdoutText[index - 1] !== "\n") continue;
    let candidate = index;
    while (candidate < stdoutText.length && (stdoutText[candidate] === " " || stdoutText[candidate] === "\t" || stdoutText[candidate] === "\r")) {
      candidate += 1;
    }
    if (stdoutText[candidate] === "{" || stdoutText[candidate] === "[" || stdoutText[candidate] === '"') {
      starts.add(candidate);
    }
  }

  let lastError: unknown = new SyntaxError("stdout did not contain a JSON value at a line boundary");
  for (const start of starts) {
    try {
      return JSON.parse(stdoutText.slice(start).trim()) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function invokeServiceCli<T = unknown>(
  service: string,
  command: string,
  args: Record<string, string | number | boolean | undefined> = {},
  opts: InvokeOptions = {},
): Promise<InvokeResult<T>> {
  const startedAt = Date.now();

  if (!getAllowedServices().has(service)) {
    return {
      ok: false,
      error: `Unknown service: ${service} (not a workspace member under ~/biz/scripts/)`,
      exitCode: -1,
      durationMs: 0,
    };
  }

  const declaredMetadata = readDeclaredCommandMetadata(service, command);
  if (declaredMetadata.error) {
    return {
      ok: false,
      error: `Refusing ${service} ${command}: ${declaredMetadata.error}`,
      exitCode: -1,
      durationMs: 0,
    };
  }
  if (!declaredMetadata.commandFound || !declaredMetadata.sideEffect) {
    return {
      ok: false,
      error: `Refusing ${service} ${command}: target command has no statically verified sideEffect metadata`,
      exitCode: -1,
      durationMs: 0,
    };
  }

  const effectiveSideEffect = declaredMetadata.sideEffect;
  if (
    (effectiveSideEffect === "destructive" || effectiveSideEffect === "external_send") &&
    opts.confirm !== true
  ) {
    return {
      ok: false,
      error: `Refusing ${service} ${command}: sideEffect="${effectiveSideEffect}" requires confirm:true`,
      exitCode: -1,
      durationMs: 0,
    };
  }

  const migrationLock = join(BIZ_ROOT, "var", "workspace-migration-lock");
  if (existsSync(migrationLock)) {
    return {
      ok: false,
      error: `Workspace migration in progress — service CLIs are frozen. Lock: ${migrationLock}`,
      exitCode: -1,
      durationMs: 0,
    };
  }

  const argList = flattenArgs(args);
  if (opts.confirm === true && args.confirm === undefined) {
    argList.push("--confirm", "true");
  }
  const resolvedInvocation = resolveCliInvocation(service, command, argList);
  if (resolvedInvocation.error) {
    return {
      ok: false,
      error: resolvedInvocation.error,
      exitCode: -1,
      durationMs: 0,
    };
  }
  const invocation = resolvedInvocation.invocation;
  if (!invocation) {
    return {
      ok: false,
      error: `No CLI invocation resolved for ${service} ${command}`,
      exitCode: -1,
      durationMs: 0,
    };
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "service-cli-invoker-"));
  const outPath = join(tmpDir, "out.json");
  const errPath = join(tmpDir, "err.txt");

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const outFd = openSync(outPath, "w");
  const errFd = openSync(errPath, "w");

  let resolved = false;
  return new Promise<InvokeResult<T>>((resolve) => {
    const finish = (result: InvokeResult<T>): void => {
      if (resolved) return;
      resolved = true;
      try { closeSync(outFd); } catch {   }
      try { closeSync(errFd); } catch {   }
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {   }
      resolve(result);
    };

    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", outFd, errFd],
    });

    if (child.stdin) {
      if (opts.stdin !== undefined) {
        child.stdin.write(opts.stdin);
      }
      child.stdin.end();
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const exitCode = code ?? -1;

      if (timedOut) {
        finish({
          ok: false,
          error: `Command timed out after ${timeoutMs}ms: ${service} ${command}`,
          exitCode: -1,
          durationMs,
          ignored: opts.ignoreErrors,
        });
        return;
      }

      let stdoutText = "";
      let stderrText = "";
      try { stdoutText = readFileSync(outPath, "utf-8"); } catch {   }
      try { stderrText = readFileSync(errPath, "utf-8"); } catch {   }

      if (exitCode === 0) {
        try {
          const parsed = parseJsonStdout<T>(stdoutText);
          finish({
            ok: true,
            data: parsed,
            exitCode,
            durationMs,
            envelope: looksLikeEnvelope(parsed),
          });
        } catch (parseErr) {
          finish({
            ok: false,
            error: `Failed to parse JSON stdout from ${service} ${command}: ${(parseErr as Error).message}. First 200 chars: ${stdoutText.slice(0, 200)}`,
            exitCode,
            durationMs,
            ignored: opts.ignoreErrors,
          });
        }
        return;
      }

      let errorMessage = stderrText.trim() || `Exit code ${exitCode}`;
      try {
        const parsed = JSON.parse(stderrText) as { message?: string };
        if (parsed.message) errorMessage = parsed.message;
      } catch {   }

      finish({
        ok: false,
        error: errorMessage,
        exitCode,
        durationMs,
        ignored: opts.ignoreErrors,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      finish({
        ok: false,
        error: `Spawn failed for ${service} ${command}: ${err.message}`,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        ignored: opts.ignoreErrors,
      });
    });
  });
}

export async function invokeOrThrow<T = unknown>(
  service: string,
  command: string,
  args: Record<string, string | number | boolean | undefined> = {},
  opts: InvokeOptions = {},
): Promise<T> {
  const result = await invokeServiceCli<T>(service, command, args, opts);
  if (!result.ok) {
    throw new Error(`${service} ${command} failed: ${result.error}`);
  }
  return result.data as T;
}

function firstArray(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["records", "items", "tasks", "rows", "results", "data"]) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function defaultItems(data: unknown): unknown[] {
  if (looksLikeEnvelope(data)) {
    return firstArray((data as { content?: unknown }).content);
  }
  return firstArray(data);
}

function firstString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

function defaultNextToken(data: unknown): string | undefined {
  const keys = ["next_page_token", "nextPageToken", "next_cursor", "nextCursor", "offset"];
  if (looksLikeEnvelope(data)) {
    const envelope = data as { metadata?: unknown; content?: unknown };
    return firstString(envelope.metadata, keys) ?? firstString(envelope.content, keys);
  }
  const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
  return firstString(record.metadata, keys) ?? firstString(record.content, keys) ?? firstString(data, keys);
}

export async function invokeServiceCliPaginated<TItem = unknown, TData = unknown>(
  service: string,
  command: string,
  args: Record<string, string | number | boolean | undefined> = {},
  opts: PaginatedInvokeOptions<TData, TItem> = {},
): Promise<InvokeResult<TItem[]>> {
  const startedAt = Date.now();
  const tokenArg = opts.tokenArg ?? "pageToken";
  const maxPages = opts.maxPages ?? 100;
  const maxItems = opts.maxItems ?? Number.POSITIVE_INFINITY;
  const seenTokens = new Set<string>();
  const items: TItem[] = [];
  let token = opts.initialToken;
  let lastEnvelope = false;

  for (let page = 0; page < maxPages; page += 1) {
    const pageArgs = { ...args };
    if (token) {
      pageArgs[tokenArg] = token;
    }
    const result = await invokeServiceCli<TData>(service, command, pageArgs, opts);
    if (!result.ok || result.data === undefined) {
      return {
        ok: false,
        error: result.error,
        exitCode: result.exitCode,
        durationMs: Date.now() - startedAt,
        ignored: result.ignored,
        data: items,
        envelope: lastEnvelope,
      };
    }
    lastEnvelope = Boolean(result.envelope);

    const pageItems = opts.extractItems
      ? opts.extractItems(result.data)
      : (defaultItems(result.data) as TItem[]);
    for (const item of pageItems) {
      if (items.length >= maxItems) break;
      items.push(item);
    }
    if (items.length >= maxItems) break;

    const nextToken = opts.extractNextToken
      ? opts.extractNextToken(result.data)
      : defaultNextToken(result.data);
    if (!nextToken) break;
    if (seenTokens.has(nextToken)) {
      return {
        ok: false,
        error: `Repeated pagination token from ${service} ${command}: ${nextToken}`,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        data: items,
        envelope: lastEnvelope,
      };
    }
    if (page === maxPages - 1) {
      return {
        ok: false,
        error: `Pagination page limit reached for ${service} ${command} before cursor exhaustion`,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        data: items,
        envelope: lastEnvelope,
      };
    }
    seenTokens.add(nextToken);
    token = nextToken;
  }

  return {
    ok: true,
    data: items,
    exitCode: 0,
    durationMs: Date.now() - startedAt,
    envelope: lastEnvelope,
  };
}


export function _resetAllowlistForTests(): void {
  cachedAllowlist = null;
  resetCommandMetadataCacheForTests();
}
