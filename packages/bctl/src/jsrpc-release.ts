import {createHash} from 'node:crypto';
import type {JsrpcActionManifest, JsrpcRelease, JsrpcReleaseManifest} from './jsrpc-types.js';
import {JSRPC_ARTIFACT} from './jsrpc-types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Deterministic JSON used by release hashing. Object keys are sorted recursively. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
}

export function canonicalJson(value: unknown): string { return JSON.stringify(canonicalize(value)); }

export function computeJsrpcReleaseId(manifest: JsrpcReleaseManifest, source: string): string {
  return createHash('sha256').update(canonicalJson(manifest), 'utf8').update('\n', 'utf8').update(source, 'utf8').digest('hex');
}

export function createJsrpcRelease(
  manifest: Omit<JsrpcReleaseManifest, 'artifact'> & {artifact?: typeof JSRPC_ARTIFACT},
  source: string,
): JsrpcRelease {
  const normalized: JsrpcReleaseManifest = {
    artifact: JSRPC_ARTIFACT,
    kernelAbiRange: manifest.kernelAbiRange,
    actions: [...manifest.actions].map(action => ({
      name: action.name,
      mutation: action.mutation,
      ...(action.requiredCapabilities ? {requiredCapabilities: [...action.requiredCapabilities].sort()} : {}),
    } satisfies JsrpcActionManifest)),
    ...(manifest.metadata ? {metadata: manifest.metadata} : {}),
  };
  return {releaseId: computeJsrpcReleaseId(normalized, source), manifest: normalized, source};
}
