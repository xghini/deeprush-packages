import type {Browser, BrowserContext, Page} from 'playwright';

export const JSRPC_WIRE_VERSION = 'jsrpc.v2' as const;
export const JSRPC_ARTIFACT = 'deeprush-jsrpc-iife-v1' as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | {[key: string]: JsonValue};

export type JsrpcMutation = 'read' | 'idempotent' | 'external-write';

export interface JsrpcActionManifest {
  name: string;
  mutation: JsrpcMutation;
  requiredCapabilities?: string[];
}

export interface JsrpcReleaseManifest {
  artifact: typeof JSRPC_ARTIFACT;
  kernelAbiRange: string;
  actions: JsrpcActionManifest[];
  metadata?: Record<string, JsonValue>;
}

export interface JsrpcRelease {
  releaseId: string;
  manifest: JsrpcReleaseManifest;
  source: string;
}

export interface JsrpcBrowserRuntime {
  readonly signal: AbortSignal;
  readonly browser: Browser;
  readonly contexts: readonly BrowserContext[];
  readonly pages: readonly Page[];
  readonly capabilities: Readonly<Record<string, unknown>>;
  checkpoint(payload: JsonValue, type?: string): Promise<JsonValue | undefined>;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, details?: JsonValue): void;
}

export interface JsrpcKernelIdentity {
  name?: string;
  platform?: string;
  host?: string;
}

export interface JsrpcKernelOptions {
  identity?: JsrpcKernelIdentity;
  kernelAbi: string;
  capabilities?: Record<string, unknown>;
  kernelVersion?: string;
  nodeVersion?: string;
  playwrightVersion?: string;
  bctlVersion?: string;
  maxReleaseSourceBytes?: number;
  maxReleases?: number;
  releaseTtlMs?: number;
  operationTtlMs?: number;
  maxJsonBytes?: number;
  now?: () => number;
  bootId?: string;
  browser?: Browser;
  contexts?: () => readonly BrowserContext[];
  pages?: () => readonly Page[];
  checkpoint?: (checkpoint: JsrpcCheckpointEnvelope) => Promise<JsrpcCheckpointAck | JsonValue | undefined>;
}

export type JsrpcOperationState = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JsrpcOperationStatus {
  operationId: string;
  bootId?: string;
  state: JsrpcOperationState;
  releaseId: string;
  action: string;
  taskGeneration?: string;
  mutation: JsrpcMutation;
  startedAt: number;
  finishedAt?: number;
  cancelRequested: boolean;
  result?: JsonValue;
  error?: JsrpcStructuredError;
}

export interface JsrpcHandshakeResponse {
  wireVersion: typeof JSRPC_WIRE_VERSION;
  bootId: string;
  identity: JsrpcKernelIdentity;
  kernelVersion?: string;
  nodeVersion?: string;
  playwrightVersion?: string;
  bctlVersion?: string;
  kernelAbi: string;
  capabilities: string[];
  limits: {
    maxReleaseSourceBytes: number;
    maxReleases: number;
    operationTtlMs: number;
    maxJsonBytes?: number;
  };
}

export interface JsrpcRegisterReleaseRequest {
  release: JsrpcRelease;
}

export interface JsrpcRegisterReleaseResponse {
  releaseId: string;
  status: 'registered' | 'present';
  actions: string[];
}

export interface JsrpcInvokeRequest {
  operationId: string;
  releaseId: string;
  action: string;
  input?: JsonValue;
  taskGeneration?: string;
  deadlineAt?: number;
  waitMs?: number;
}

export interface JsrpcInvokeResponse {
  operation: JsrpcOperationStatus;
}

export interface JsrpcOperationStatusRequest {
  operationId: string;
}

export interface JsrpcOperationCancelRequest {
  operationId: string;
  waitMs?: number;
}

export interface JsrpcCheckpointRequest {
  operationId: string;
  releaseId?: string;
  action?: string;
  taskGeneration?: string;
  sequence: number;
  type?: string;
  payload: JsonValue;
}

export interface JsrpcCheckpointEnvelope {
  operationId: string;
  releaseId: string;
  action: string;
  taskGeneration?: string;
  sequence: number;
  fingerprint: string;
  type: string;
  payload: JsonValue;
}

export interface JsrpcCheckpointAck {
  accepted: boolean;
  sequence: number;
  fingerprint?: string;
  operationId: string;
  message?: string;
  details?: JsonValue;
}

export type JsrpcErrorPhase = 'register' | 'prepare' | 'execute' | 'checkpoint' | 'serialize';

export interface JsrpcStructuredError {
  code: string;
  message: string;
  status: number;
  phase?: JsrpcErrorPhase;
  stack?: string;
  retryable?: boolean;
  operationId?: string;
  releaseId?: string;
  action?: string;
  taskGeneration?: string;
  details?: JsonValue;
}

export interface JsrpcHttpResponse<T = unknown> {
  status: number;
  body: T | JsrpcStructuredError;
}
