import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';
import type {JsrpcRelease, JsrpcReleaseManifest} from './jsrpc-types.js';
import {JSRPC_ARTIFACT} from './jsrpc-types.js';
import {createJsrpcRelease} from './jsrpc-release.js';

export interface JsrpcBundleAudit {
  entryPath?: string;
  inputs: string[];
  externalImports: string[];
  dynamicImports: string[];
  forbiddenImports: string[];
  outputImports: string[];
}

/** Build-time diagnostic with an inspectable esbuild dependency graph. */
export class JsrpcBundleError extends Error {
  readonly phase = 'prepare' as const;
  readonly audit?: JsrpcBundleAudit;
  constructor(message: string, audit?: JsrpcBundleAudit, cause?: unknown) {
    super(message, {cause});
    this.name = 'JsrpcBundleError';
    this.audit = audit;
  }
}

function assertNoForbiddenImports(source: string): void {
  if (/\b(?:import|export)\s+(?:[({*]|["']|[A-Za-z_$])/.test(source)) throw new Error('JSRPC source builder expects a self-contained function/object expression; use entryPath for imports');
  if (/\b(?:require|process|module|__dirname|__filename)\s*\(/.test(source) || /\b(?:require|process|module|__dirname|__filename)\b/.test(source)) throw new Error('JSRPC action source cannot access host modules or process globals');
}

export interface BuildJsrpcSourceBundleOptions {
  manifest: Omit<JsrpcReleaseManifest, 'artifact'> & {artifact?: typeof JSRPC_ARTIFACT};
  source: string;
  sourcefile?: string;
  minify?: boolean;
}

export interface BuildJsrpcEntryBundleOptions {
  /** A TypeScript/JavaScript entry exporting `actions`, a default action, or named actions. */
  entryPath: string;
  manifest: Omit<JsrpcReleaseManifest, 'artifact'> & {artifact?: typeof JSRPC_ARTIFACT};
  minify?: boolean;
}

export type BuildJsrpcBundleOptions = BuildJsrpcSourceBundleOptions | BuildJsrpcEntryBundleOptions;

const FORBIDDEN_IMPORT_RE = /^(?:node:)?(?:fs|fs\/promises|child_process|worker_threads|net|tls|http|https|module|vm|sqlite3|better-sqlite3|pg|mysql2|aws-sdk|@aws-sdk(?:\/|$)|playwright(?:\/|$)|@playwright(?:\/|$)|ghini(?:\/|$))/i;

function asImportName(importPath: string): string { return importPath.replace(/\\/g, '/'); }
function isForbiddenImport(importPath: string): boolean {
  const normalized = asImportName(importPath);
  return FORBIDDEN_IMPORT_RE.test(normalized) || /\/node_modules\/(?:pg|mysql2|aws-sdk|@aws-sdk|playwright|@playwright|ghini)(?:\/|$)/i.test(normalized);
}
function formatAudit(audit: JsrpcBundleAudit): string { return JSON.stringify(audit, null, 2); }
function withSourceUrl(source: string, label: string): string {
  return `${source}\n//# sourceURL=jsrpc://${encodeURIComponent(label.replace(/\\/g, '/'))}`;
}

function resolveLocalImport(from: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, path.join(base, 'index.ts'), path.join(base, 'index.js')];
  return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function scanEntrySource(entryPath: string): void {
  const inputs: string[] = [];
  const visited = new Set<string>();
  const visit = (currentPath: string): void => {
    const resolved = path.resolve(currentPath);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    inputs.push(resolved);
    const source = fs.readFileSync(resolved, 'utf8');
    if (/\bimport\s*\(/.test(source)) throw new JsrpcBundleError(`JSRPC entry graph contains a dynamic import at ${resolved}`, {entryPath, inputs: [...inputs], externalImports: [], dynamicImports: ['<dynamic>'], forbiddenImports: [], outputImports: []});
    const typeOnlyImports = new Set([...source.matchAll(/\bimport\s+type[\s\S]*?\bfrom\s*["']([^"']+)["']/g)].map(match => match[1]));
    for (const match of source.matchAll(/\b(?:from\s*|import\s*)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (!specifier) continue;
      if (isForbiddenImport(specifier) && !typeOnlyImports.has(specifier)) throw new JsrpcBundleError(`JSRPC entry graph imports forbidden dependencies:\n${formatAudit({entryPath, inputs: [...inputs], externalImports: [specifier], dynamicImports: [], forbiddenImports: [specifier], outputImports: []})}`, {entryPath, inputs: [...inputs], externalImports: [specifier], dynamicImports: [], forbiddenImports: [specifier], outputImports: []});
      if (specifier.startsWith('.')) {
        const local = resolveLocalImport(resolved, specifier);
        if (local) visit(local);
      }
    }
  };
  visit(entryPath);
}

function auditMetafile(metafile: esbuild.Metafile, entryPath?: string): JsrpcBundleAudit {
  const inputs = Object.keys(metafile.inputs).sort();
  const externalImports = new Set<string>();
  const dynamicImports = new Set<string>();
  const forbiddenImports = new Set<string>();
  for (const [inputPath, input] of Object.entries(metafile.inputs)) {
    if (isForbiddenImport(inputPath)) forbiddenImports.add(inputPath);
    for (const dependency of input.imports) {
      const name = asImportName(dependency.path);
      if (dependency.external) externalImports.add(name);
      if (dependency.kind === 'dynamic-import') dynamicImports.add(name);
      if (isForbiddenImport(name)) forbiddenImports.add(name);
    }
  }
  const outputImports = Object.values(metafile.outputs).flatMap(output => output.imports.map(item => asImportName(item.path))).sort();
  for (const item of outputImports) {
    externalImports.add(item);
    if (isForbiddenImport(item)) forbiddenImports.add(item);
  }
  return { ...(entryPath ? {entryPath} : {}), inputs, externalImports: [...externalImports].sort(), dynamicImports: [...dynamicImports].sort(), forbiddenImports: [...forbiddenImports].sort(), outputImports };
}

function assertCleanAudit(audit: JsrpcBundleAudit): void {
  if (audit.forbiddenImports.length) throw new JsrpcBundleError(`JSRPC browser action imports forbidden host/business dependencies:\n${formatAudit(audit)}`, audit);
  if (audit.dynamicImports.length) throw new JsrpcBundleError(`JSRPC browser action contains dynamic imports; bundle dependencies must be static:\n${formatAudit(audit)}`, audit);
  if (audit.externalImports.length || audit.outputImports.length) throw new JsrpcBundleError(`JSRPC browser action contains residual external imports; use explicit runtime capabilities instead:\n${formatAudit(audit)}`, audit);
}

function buildOptions(options: {minify?: boolean}): esbuild.BuildOptions {
  return {bundle: true, write: false, format: 'iife', globalName: '__jsrpcBundle', platform: 'neutral', target: 'esnext', minify: options.minify ?? false, sourcemap: false, legalComments: 'none', metafile: true};
}

/** Low-level source-expression builder retained for existing callers. */
export async function buildJsrpcSourceBundle(options: BuildJsrpcSourceBundleOptions): Promise<JsrpcRelease> {
  try {
    assertNoForbiddenImports(options.source);
    const firstAction = options.manifest.actions[0]?.name || 'default';
    const entry = `const __jsrpcExport = (${options.source});\nconst __jsrpcActions = typeof __jsrpcExport === 'function' ? {${JSON.stringify(firstAction)}: __jsrpcExport} : __jsrpcExport;\nmodule.exports = {actions: __jsrpcActions};`;
    const result = await esbuild.build({...buildOptions(options), stdin: {contents: entry, sourcefile: options.sourcefile || 'jsrpc-action.ts', loader: 'ts'}});
    const audit = auditMetafile(result.metafile!, options.sourcefile || 'jsrpc-action.ts');
    assertCleanAudit(audit);
    const output = result.outputFiles?.find(file => !file.path.endsWith('.map'))?.text;
    if (!output) throw new JsrpcBundleError(`JSRPC source builder produced no output:\n${formatAudit(audit)}`, audit);
    if (/\b(?:import|export)\s/.test(output)) throw new JsrpcBundleError(`JSRPC bundle contains residual import/export:\n${formatAudit(audit)}`, audit);
    return createJsrpcRelease(options.manifest, withSourceUrl(output, path.basename(options.sourcefile || 'jsrpc-action.ts')));
  } catch (error) {
    if (error instanceof JsrpcBundleError) throw error;
    throw new JsrpcBundleError(`JSRPC source preparation failed: ${error instanceof Error ? error.message : String(error)}`, undefined, error);
  }
}

/** Canonical controller entry builder: recursively bundles local TS/JS dependencies. */
export async function buildJsrpcBundleFromEntry(options: BuildJsrpcEntryBundleOptions): Promise<JsrpcRelease> {
  const entryPath = path.resolve(options.entryPath);
  if (!fs.existsSync(entryPath) || !fs.statSync(entryPath).isFile()) throw new JsrpcBundleError(`JSRPC entryPath does not exist: ${entryPath}`);
  if (!options.manifest.actions.length) throw new JsrpcBundleError('JSRPC entry manifest must declare at least one action');
  scanEntrySource(entryPath);
  const resolveDir = path.dirname(entryPath);
  const relativeEntry = path.relative(resolveDir, entryPath).replace(/\\/g, '/');
  const importPath = relativeEntry.startsWith('.') ? relativeEntry : `./${relativeEntry}`;
  const firstAction = options.manifest.actions[0]?.name || 'default';
  const wrapper = `import * as __entry from ${JSON.stringify(importPath)};\nconst __read = (key) => __entry[key];\nconst __named = {${options.manifest.actions.map(action => `${JSON.stringify(action.name)}: __read(${JSON.stringify(action.name)})`).join(',')}};\nconst __exported = __read('actions') ?? __read('default') ?? (__read(${JSON.stringify(firstAction)}) ? __named : __entry);\nconst __jsrpcActions = typeof __exported === 'function' ? {${JSON.stringify(firstAction)}: __exported} : __exported;\nmodule.exports = {actions: __jsrpcActions};`;
  try {
    const result = await esbuild.build({...buildOptions(options), stdin: {contents: wrapper, sourcefile: `${path.basename(entryPath)}.jsrpc-wrapper.ts`, resolveDir, loader: 'ts'}});
    const audit = auditMetafile(result.metafile!, entryPath);
    assertCleanAudit(audit);
    const output = result.outputFiles?.find(file => !file.path.endsWith('.map'))?.text;
    if (!output) throw new JsrpcBundleError(`JSRPC entry builder produced no output:\n${formatAudit(audit)}`, audit);
    if (/\b(?:import|export)\s|\bimport\s*\(/.test(output)) throw new JsrpcBundleError(`JSRPC entry bundle contains residual module syntax:\n${formatAudit(audit)}`, audit);
    // Keep release identity independent of the controller's absolute Windows path.
    return createJsrpcRelease(options.manifest, withSourceUrl(output, path.basename(entryPath)));
  } catch (error) {
    if (error instanceof JsrpcBundleError) throw error;
    throw new JsrpcBundleError(`JSRPC entry preparation failed for ${entryPath}: ${error instanceof Error ? error.message : String(error)}`, undefined, error);
  }
}

/** Compatibility facade: source callers keep the old API; entry callers use the canonical graph builder. */
export async function buildJsrpcBundle(options: BuildJsrpcBundleOptions): Promise<JsrpcRelease> {
  return 'entryPath' in options ? buildJsrpcBundleFromEntry(options) : buildJsrpcSourceBundle(options);
}

export {
  canonicalize,
  canonicalJson,
  computeJsrpcReleaseId,
  createJsrpcRelease,
} from './jsrpc-release.js';
