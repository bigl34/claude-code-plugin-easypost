import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { SideEffect } from "@local/cli-utils";
import ts from "typescript";

const SIDE_EFFECTS = new Set<SideEffect>([
  "read",
  "write",
  "destructive",
  "external_send",
]);

export interface CommandMetadata {
  commandFound: boolean;
  sideEffect?: SideEffect;
  error?: string;
}

export interface ParsedCommandMetadata {
  commands: Map<string, CommandMetadata>;
  errors: string[];
}

interface CachedFileMetadata {
  mtimeMs: number;
  size: number;
  parsed: ParsedCommandMetadata;
}

const fileCache = new Map<string, CachedFileMetadata>();

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function isCreateCommandCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createCommand";
}

function extractSideEffect(call: ts.CallExpression, command: string): CommandMetadata {
  const options = call.arguments[3];
  if (!options || !ts.isObjectLiteralExpression(options)) {
    return {
      commandFound: true,
      error: `command "${command}" is missing sideEffect metadata`,
    };
  }

  const sideEffectProperties = options.properties.filter((property) => {
    return ts.isPropertyAssignment(property) && propertyNameText(property.name) === "sideEffect";
  });
  if (sideEffectProperties.length !== 1) {
    return {
      commandFound: true,
      error: sideEffectProperties.length === 0
        ? `command "${command}" is missing sideEffect metadata`
        : `command "${command}" declares sideEffect more than once`,
    };
  }

  const property = sideEffectProperties[0] as ts.PropertyAssignment;
  if (!ts.isStringLiteral(property.initializer) || !SIDE_EFFECTS.has(property.initializer.text as SideEffect)) {
    return {
      commandFound: true,
      error: `command "${command}" has a dynamic or invalid sideEffect value`,
    };
  }

  return {
    commandFound: true,
    sideEffect: property.initializer.text as SideEffect,
  };
}

export function parseCommandMetadataSource(source: string, fileName = "cli.ts"): ParsedCommandMetadata {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    return {
      commands: new Map(),
      errors: parseDiagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")),
    };
  }

  const commands = new Map<string, CommandMetadata>();
  const errors: string[] = [];
  const commandAliases = new Map<string, ts.CallExpression>();
  const referencedAliases = new Set<string>();
  let sawCreateCommandIdentifier = false;
  let sawRunCliIdentifier = false;

  const collectAliases = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && isCreateCommandCall(node.initializer)
      && ts.isVariableDeclarationList(node.parent)
      && (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      commandAliases.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(sourceFile);

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (node.text === "createCommand") sawCreateCommandIdentifier = true;
      if (node.text === "runCli") sawRunCliIdentifier = true;
    }
    if (
      isCreateCommandCall(node)
      && !(ts.isPropertyAssignment(node.parent) && node.parent.initializer === node)
      && !(ts.isVariableDeclaration(node.parent) && node.parent.initializer === node && commandAliases.has(node.parent.name.getText(sourceFile)))
    ) {
      errors.push(`unsupported createCommand construction at offset ${node.pos}`);
    }
    if (ts.isPropertyAssignment(node)) {
      const initializer = isCreateCommandCall(node.initializer)
        ? node.initializer
        : ts.isIdentifier(node.initializer)
          ? commandAliases.get(node.initializer.text)
          : undefined;
      if (!initializer) {
        ts.forEachChild(node, visit);
        return;
      }
      const command = propertyNameText(node.name);
      if (ts.isIdentifier(node.initializer)) referencedAliases.add(node.initializer.text);
      if (!command) {
        errors.push(`unsupported dynamic command name at offset ${node.pos}`);
      } else if (commands.has(command)) {
        commands.set(command, {
          commandFound: true,
          error: `command "${command}" is declared more than once`,
        });
      } else {
        commands.set(command, extractSideEffect(initializer, command));
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  for (const alias of commandAliases.keys()) {
    if (!referencedAliases.has(alias)) errors.push(`unsupported unregistered createCommand alias "${alias}"`);
  }
  if (commands.size === 0 && errors.length === 0 && (sawCreateCommandIdentifier || sawRunCliIdentifier)) {
    errors.push('unsupported dynamic command construction');
  }
  return { commands, errors };
}

function assertConfinedPath(cliPath: string, allowedRoot: string): string {
  const realRoot = realpathSync(allowedRoot);
  const realCliPath = realpathSync(cliPath);
  const relativePath = relative(realRoot, realCliPath);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`CLI path escapes allowed service root: ${resolve(cliPath)}`);
  }
  return realCliPath;
}

export function readCommandMetadataFile(
  cliPath: string,
  command: string,
  allowedRoot: string,
): CommandMetadata {
  let realCliPath: string;
  try {
    realCliPath = assertConfinedPath(cliPath, allowedRoot);
  } catch (error) {
    return { commandFound: true, error: (error as Error).message };
  }

  try {
    const stats = statSync(realCliPath);
    let cached = fileCache.get(realCliPath);
    if (!cached || cached.mtimeMs !== stats.mtimeMs || cached.size !== stats.size) {
      cached = {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        parsed: parseCommandMetadataSource(readFileSync(realCliPath, "utf-8"), realCliPath),
      };
      fileCache.set(realCliPath, cached);
    }

    if (cached.parsed.errors.length > 0) {
      return {
        commandFound: true,
        error: `unable to statically parse command metadata: ${cached.parsed.errors[0]}`,
      };
    }
    const metadata = cached.parsed.commands.get(command);
    if (metadata) return metadata;
    if (cached.parsed.commands.size > 0) {
      return {
        commandFound: true,
        error: `command "${command}" was not found in statically analyzable metadata`,
      };
    }
    return { commandFound: false };
  } catch (error) {
    return {
      commandFound: true,
      error: `unable to read command metadata: ${(error as Error).message}`,
    };
  }
}

export function resetCommandMetadataCacheForTests(): void {
  fileCache.clear();
}

