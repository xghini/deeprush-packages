import {randomUUID} from 'node:crypto';
import type {
  JsrpcActionManifest,
  JsrpcBrowserRuntime,
  JsrpcCheckpointAck,
  JsrpcCheckpointEnvelope,
  JsrpcCheckpointRequest,
  JsrpcHandshakeResponse,
  JsrpcHttpResponse,
  JsrpcInvokeRequest,
  JsrpcInvokeResponse,
  JsrpcKernelOptions,
  JsrpcOperationCancelRequest,
  JsrpcOperationStatus,
  JsrpcRegisterReleaseResponse,
  JsrpcRelease,
  JsrpcStructuredError,
  JsonValue,
} from './jsrpc-types.js';
import {JSRPC_ARTIFACT, JSRPC_WIRE_VERSION} from './jsrpc-types.js';
import {computeJsrpcReleaseId} from './jsrpc-release.js';
import {JsrpcError, structuredError, toStructuredError} from './jsrpc-errors.js';

type Action = (runtime: JsrpcBrowserRuntime, input: JsonValue) => Promise<JsonValue> | JsonValue;

interface RegisteredRelease {
  release: JsrpcRelease;
  actions: Map<string, Action>;
  registeredAt: number;
  lastUsedAt: number;
  activeLeases: number;
}

interface OperationRecord {
  operationId: string;
  fingerprint: string;
  releaseId: string;
  action: string;
  mutation: JsrpcActionManifest['mutation'];
  taskGeneration?: string;
  startedAt: number;
  finishedAt?: number;
  state: JsrpcOperationStatus['state'];
  cancelRequested: boolean;
  controller: AbortController;
  promise: Promise<void>;
  committedSequence: number;
  pendingCheckpoint?: PendingCheckpoint;
  checkpointFailure?: JsrpcStructuredError;
  result?: JsonValue;
  error?: JsrpcStructuredError;
}

interface PendingCheckpoint {
  sequence: number;
  fingerprint: string;
  envelope: JsrpcCheckpointEnvelope;
  inFlight?: Promise<JsonValue | undefined>;
}

const DEFAULT_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RELEASES = 32;
const DEFAULT_RELEASE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_OPERATION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_JSON_BYTES = 2 * 1024 * 1024;

function jsonFingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]]));
    }
    return item;
  });
}

function matchesAbi(range: string, abi: string): boolean {
  // ABI ranges are intentionally small and explicit: `1`, `1.x`, or `1.2.x`.
  const requested = range.trim();
  if (requested === '*' || requested === abi) return true;
  const parts = requested.split('.');
  const actual = abi.split('.');
  return parts.every((part, index) => part === 'x' || part === '*' || part === actual[index]);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /aborted|cancelled/i.test(error.message));
}

function assertJsonValue(value: unknown, maxBytes: number, label: string): JsonValue {
  const seen = new WeakSet<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error(`${label} contains a non-finite number`);
      return;
    }
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') throw new Error(`${label} is not JSON-serializable`);
    if (typeof item === 'object') {
      if (seen.has(item)) throw new Error(`${label} contains a circular reference`);
      seen.add(item);
      if (Array.isArray(item)) item.forEach(visit);
      else Object.entries(item as Record<string, unknown>).forEach(([, child]) => visit(child));
      seen.delete(item);
    }
  };
  visit(value);
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch (error) { throw new Error(`${label} serialization failed: ${error instanceof Error ? error.message : String(error)}`); }
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > maxBytes) throw new Error(`${label} exceeds JSON size limit (${maxBytes} bytes)`);
  return JSON.parse(encoded) as JsonValue;
}

function withOperationContext<T extends Partial<JsrpcStructuredError>>(error: T, operation: OperationRecord): T & Pick<JsrpcStructuredError, 'operationId' | 'releaseId' | 'action'> {
  return {
    ...error,
    operationId: operation.operationId,
    releaseId: operation.releaseId,
    action: operation.action,
    ...(operation.taskGeneration ? {taskGeneration: operation.taskGeneration} : {}),
  } as T & Pick<JsrpcStructuredError, 'operationId' | 'releaseId' | 'action'>;
}

export class JsrpcKernel {
  readonly bootId: string;
  private readonly releases = new Map<string, RegisteredRelease>();
  private readonly operations = new Map<string, OperationRecord>();
  private readonly opts: Required<Pick<JsrpcKernelOptions, 'kernelAbi' | 'maxReleaseSourceBytes' | 'maxReleases' | 'releaseTtlMs' | 'operationTtlMs' | 'maxJsonBytes'>> & JsrpcKernelOptions;

  constructor(options: JsrpcKernelOptions) {
    this.opts = {
      ...options,
      kernelAbi: options.kernelAbi,
      maxReleaseSourceBytes: options.maxReleaseSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
      maxReleases: options.maxReleases ?? DEFAULT_MAX_RELEASES,
      releaseTtlMs: options.releaseTtlMs ?? DEFAULT_RELEASE_TTL_MS,
      operationTtlMs: options.operationTtlMs ?? DEFAULT_OPERATION_TTL_MS,
      maxJsonBytes: options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES,
    };
    this.bootId = options.bootId || randomUUID();
  }

  private now(): number { return this.opts.now?.() ?? Date.now(); }

  handshake(): JsrpcHandshakeResponse {
    return {
      wireVersion: JSRPC_WIRE_VERSION,
      bootId: this.bootId,
      identity: this.opts.identity || {},
      kernelVersion: this.opts.kernelVersion,
      nodeVersion: this.opts.nodeVersion || process.version,
      playwrightVersion: this.opts.playwrightVersion,
      bctlVersion: this.opts.bctlVersion,
      kernelAbi: this.opts.kernelAbi,
      capabilities: Object.keys(this.opts.capabilities || {}).sort(),
      limits: {
        maxReleaseSourceBytes: this.opts.maxReleaseSourceBytes,
        maxReleases: this.opts.maxReleases,
        operationTtlMs: this.opts.operationTtlMs,
        maxJsonBytes: this.opts.maxJsonBytes,
      },
    };
  }

  private sweep(evictForCapacity = false): void {
    const now = this.now();
    for (const [id, operation] of this.operations) {
      if (operation.state !== 'running' && operation.finishedAt !== undefined && now - operation.finishedAt > this.opts.operationTtlMs) this.operations.delete(id);
    }
    for (const [id, release] of this.releases) {
      if (release.activeLeases === 0 && now - release.lastUsedAt > this.opts.releaseTtlMs) this.releases.delete(id);
    }
    if (evictForCapacity && this.releases.size >= this.opts.maxReleases) {
      const candidates = [...this.releases.values()].filter(item => item.activeLeases === 0).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      while (this.releases.size >= this.opts.maxReleases && candidates.length) this.releases.delete(candidates.shift()!.release.releaseId);
    }
  }

  private evaluateRelease(release: JsrpcRelease): Map<string, Action> {
    try {
      const factory = new Function(`${release.source}\n;return typeof __jsrpcBundle !== 'undefined' ? __jsrpcBundle : undefined;`)() as {actions?: Record<string, Action>} | undefined;
      if (!factory?.actions || typeof factory.actions !== 'object') throw new Error('bundle factory did not return actions');
      return new Map(Object.entries(factory.actions));
    } catch (error) {
      throw new JsrpcError(structuredError('RELEASE_COMPILE_ERROR', `Unable to compile release: ${error instanceof Error ? error.message : String(error)}`, 422, {phase: 'prepare', releaseId: release.releaseId, stack: error instanceof Error ? error.stack : undefined}));
    }
  }

  registerRelease(release: JsrpcRelease): JsrpcRegisterReleaseResponse {
    this.sweep();
    if (!release || release.manifest?.artifact !== JSRPC_ARTIFACT) throw new JsrpcError(structuredError('INVALID_RELEASE', 'Unsupported JSRPC artifact', 400, {phase: 'register'}));
    if (!release.releaseId || !release.source || !release.manifest.kernelAbiRange) throw new JsrpcError(structuredError('INVALID_RELEASE', 'releaseId, source and kernelAbiRange are required', 400, {phase: 'register'}));
    if (Buffer.byteLength(release.source, 'utf8') > this.opts.maxReleaseSourceBytes) throw new JsrpcError(structuredError('RELEASE_TOO_LARGE', 'Release source exceeds kernel limit', 413, {phase: 'register', details: {maxBytes: this.opts.maxReleaseSourceBytes}}));
    const current = this.releases.get(release.releaseId);
    if (current) {
      if (current.release.source !== release.source || jsonFingerprint(current.release.manifest) !== jsonFingerprint(release.manifest)) throw new JsrpcError(structuredError('RELEASE_CONFLICT', 'releaseId is already registered with different contents', 409, {phase: 'register', releaseId: release.releaseId}));
      current.lastUsedAt = this.now();
      return {releaseId: release.releaseId, status: 'present', actions: [...current.actions.keys()]};
    }
    const expected = computeJsrpcReleaseId(release.manifest, release.source);
    if (expected !== release.releaseId) throw new JsrpcError(structuredError('RELEASE_HASH_MISMATCH', 'releaseId does not match canonical manifest and source', 422, {phase: 'register', releaseId: release.releaseId}));
    if (!matchesAbi(release.manifest.kernelAbiRange, this.opts.kernelAbi)) throw new JsrpcError(structuredError('ABI_MISMATCH', 'Release is not compatible with this kernel ABI', 409, {phase: 'register', releaseId: release.releaseId, details: {required: release.manifest.kernelAbiRange, actual: this.opts.kernelAbi}}));
    const missing = [...new Set(release.manifest.actions.flatMap(action => action.requiredCapabilities || []))].filter(name => !(name in (this.opts.capabilities || {})));
    if (missing.length) throw new JsrpcError(structuredError('CAPABILITY_MISMATCH', 'Release requires unavailable capabilities', 409, {phase: 'register', releaseId: release.releaseId, details: {missing}}));
    if (this.releases.size >= this.opts.maxReleases) this.sweep(true);
    if (this.releases.size >= this.opts.maxReleases) throw new JsrpcError(structuredError('RELEASE_CAPACITY', 'No inactive release slot is available', 429, {phase: 'register', retryable: true}));
    const actions = this.evaluateRelease(release);
    const names = new Set(release.manifest.actions.map(action => action.name));
    if ([...names].some(name => !actions.has(name))) throw new JsrpcError(structuredError('RELEASE_ACTION_MISMATCH', 'Bundle actions do not match manifest', 422, {phase: 'register', releaseId: release.releaseId}));
    this.releases.set(release.releaseId, {release, actions, registeredAt: this.now(), lastUsedAt: this.now(), activeLeases: 0});
    return {releaseId: release.releaseId, status: 'registered', actions: [...actions.keys()]};
  }

  private operationStatus(operation: OperationRecord): JsrpcOperationStatus {
    return {
      operationId: operation.operationId,
      bootId: this.bootId,
      state: operation.state,
      releaseId: operation.releaseId,
      action: operation.action,
      ...(operation.taskGeneration ? {taskGeneration: operation.taskGeneration} : {}),
      mutation: operation.mutation,
      startedAt: operation.startedAt,
      ...(operation.finishedAt !== undefined ? {finishedAt: operation.finishedAt} : {}),
      cancelRequested: operation.cancelRequested,
      ...(operation.result !== undefined ? {result: operation.result} : {}),
      ...(operation.error ? {error: operation.error} : {}),
    };
  }

  private async waitFor(operation: OperationRecord, waitMs: number): Promise<void> {
    if (operation.state !== 'running' || waitMs <= 0) return;
    await Promise.race([operation.promise, new Promise<void>(resolve => setTimeout(resolve, waitMs))]);
  }

  private checkpointError(operation: OperationRecord, code: string, message: string, details?: JsonValue, cause?: unknown): JsrpcError {
    const error = new JsrpcError(structuredError(code, message, 409, {
      phase: 'checkpoint',
      stack: cause instanceof Error ? cause.stack : undefined,
      ...withOperationContext({}, operation),
      ...(details !== undefined ? {details} : {}),
    }));
    operation.checkpointFailure = error.toJSON();
    operation.controller.abort(error);
    return error;
  }

  private async sendCheckpoint(operation: OperationRecord, pending: PendingCheckpoint): Promise<JsonValue | undefined> {
    if (pending.inFlight) return pending.inFlight;
    pending.inFlight = (async () => {
      if (!this.opts.checkpoint) throw this.checkpointError(operation, 'CHECKPOINT_CALLBACK_MISSING', 'Controller checkpoint callback is required; external-write action is blocked');
      let response: JsrpcCheckpointAck | JsonValue | undefined;
      try {
        response = await this.opts.checkpoint(pending.envelope);
      } catch (error) {
        const failure = new JsrpcError(structuredError('CHECKPOINT_CALLBACK_ERROR', error instanceof Error ? error.message : String(error), 502, {
          phase: 'checkpoint',
          stack: error instanceof Error ? error.stack : undefined,
          ...withOperationContext({}, operation),
        }));
        operation.checkpointFailure = failure.toJSON();
        operation.controller.abort(failure);
        throw failure;
      }
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw this.checkpointError(operation, 'CHECKPOINT_ACK_INVALID', 'Controller must return an object checkpoint acknowledgement', {sequence: pending.sequence, received: response === undefined ? 'undefined' : Array.isArray(response) ? 'array' : typeof response});
      const ack = response as JsrpcCheckpointAck;
      if (ack.accepted !== true) throw this.checkpointError(operation, 'CHECKPOINT_REJECTED', ack.message || `Controller rejected checkpoint sequence ${pending.sequence}`, ack.details);
      if (ack.operationId !== operation.operationId) throw this.checkpointError(operation, 'CHECKPOINT_ACK_CONTEXT', 'Controller checkpoint acknowledgement operationId does not match', {expected: operation.operationId, received: ack.operationId});
      if (ack.sequence !== pending.sequence) throw this.checkpointError(operation, 'CHECKPOINT_ACK_SEQUENCE', `Controller acknowledged sequence ${ack.sequence}, expected ${pending.sequence}`, {expected: pending.sequence, received: ack.sequence});
      if (ack.fingerprint !== undefined && ack.fingerprint !== pending.fingerprint) throw this.checkpointError(operation, 'CHECKPOINT_ACK_FINGERPRINT', 'Controller checkpoint acknowledgement fingerprint does not match', {expected: pending.fingerprint, received: ack.fingerprint});
      operation.committedSequence = pending.sequence;
      operation.pendingCheckpoint = undefined;
      operation.checkpointFailure = undefined;
      return response as JsonValue;
    })();
    try {
      return await pending.inFlight;
    } finally {
      pending.inFlight = undefined;
    }
  }

  private enqueueCheckpoint(operation: OperationRecord, payload: JsonValue, type: string, requestedSequence?: number): Promise<JsonValue | undefined> {
    let normalizedPayload: JsonValue;
    try {
      normalizedPayload = assertJsonValue(payload, this.opts.maxJsonBytes, 'checkpoint payload');
    } catch (error) {
      const failure = new JsrpcError(structuredError('CHECKPOINT_PAYLOAD_NOT_SERIALIZABLE', error instanceof Error ? error.message : String(error), 422, {
        phase: 'serialize',
        stack: error instanceof Error ? error.stack : undefined,
        ...withOperationContext({}, operation),
      }));
      operation.checkpointFailure = failure.toJSON();
      operation.controller.abort(failure);
      throw failure;
    }
    const fingerprint = jsonFingerprint({type, payload: normalizedPayload});
    const existing = operation.pendingCheckpoint;
    if (existing) {
      if (requestedSequence !== undefined && requestedSequence !== existing.sequence || existing.fingerprint !== fingerprint) throw this.checkpointError(operation, 'CHECKPOINT_PENDING_CONFLICT', 'A different checkpoint is already pending; retry the exact same event', {expectedSequence: existing.sequence, ...(requestedSequence !== undefined ? {receivedSequence: requestedSequence} : {}), expectedFingerprint: existing.fingerprint, receivedFingerprint: fingerprint});
      return this.sendCheckpoint(operation, existing);
    }
    const sequence = requestedSequence ?? operation.committedSequence + 1;
    if (sequence !== operation.committedSequence + 1) throw this.checkpointError(operation, 'CHECKPOINT_SEQUENCE', `Checkpoint sequence must be ${operation.committedSequence + 1}`, {expected: operation.committedSequence + 1, received: sequence});
    const envelope: JsrpcCheckpointEnvelope = {
      operationId: operation.operationId,
      releaseId: operation.releaseId,
      action: operation.action,
      ...(operation.taskGeneration ? {taskGeneration: operation.taskGeneration} : {}),
      sequence,
      fingerprint,
      type,
      payload: normalizedPayload,
    };
    const pending: PendingCheckpoint = {sequence, fingerprint, envelope};
    operation.pendingCheckpoint = pending;
    return this.sendCheckpoint(operation, pending);
  }

  private runtimeFor(operation: OperationRecord): JsrpcBrowserRuntime {
    const capabilities = this.opts.capabilities || {};
    return {
      signal: operation.controller.signal,
      browser: this.opts.browser as any,
      contexts: this.opts.contexts?.() || [],
      pages: this.opts.pages?.() || [],
      capabilities,
      checkpoint: (payload, type = 'checkpoint') => this.enqueueCheckpoint(operation, payload, type),
      log: (level, message, details) => {
        const logger = (capabilities.logger as ((level: string, message: string, details?: JsonValue) => void) | undefined);
        if (logger) logger(level, message, details);
      },
    };
  }

  async invoke(request: JsrpcInvokeRequest): Promise<JsrpcInvokeResponse> {
    this.sweep();
    if (!request.operationId || !request.releaseId || !request.action) throw new JsrpcError(structuredError('INVALID_REQUEST', 'operationId, releaseId and action are required', 400, {phase: 'register'}));
    let input: JsonValue;
    try {
      input = assertJsonValue(request.input ?? null, this.opts.maxJsonBytes, 'operation input');
    } catch (error) {
      throw new JsrpcError(structuredError('INPUT_NOT_SERIALIZABLE', error instanceof Error ? error.message : String(error), 422, {
        phase: 'serialize',
        operationId: request.operationId,
        releaseId: request.releaseId,
        action: request.action,
        ...(request.taskGeneration ? {taskGeneration: request.taskGeneration} : {}),
        stack: error instanceof Error ? error.stack : undefined,
      }));
    }
    const fingerprint = jsonFingerprint({releaseId: request.releaseId, action: request.action, input, taskGeneration: request.taskGeneration});
    const existing = this.operations.get(request.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new JsrpcError(structuredError('OPERATION_CONFLICT', 'operationId is already associated with a different invocation', 409, {phase: 'register', ...withOperationContext({}, existing)}));
      await this.waitFor(existing, Math.max(0, request.waitMs ?? 0));
      return {operation: this.operationStatus(existing)};
    }
    const registered = this.releases.get(request.releaseId);
    if (!registered) throw new JsrpcError(structuredError('RELEASE_NOT_FOUND', 'Release has not been registered', 404, {phase: 'register', releaseId: request.releaseId, retryable: true}));
    const action = registered.actions.get(request.action);
    const definition = registered.release.manifest.actions.find(item => item.name === request.action);
    if (!action || !definition) throw new JsrpcError(structuredError('ACTION_NOT_FOUND', 'Action is not present in release', 404, {phase: 'register', releaseId: request.releaseId, action: request.action}));
    const now = this.now();
    const operation: OperationRecord = {
      operationId: request.operationId,
      fingerprint,
      releaseId: request.releaseId,
      action: request.action,
      mutation: definition.mutation,
      ...(request.taskGeneration ? {taskGeneration: request.taskGeneration} : {}),
      startedAt: now,
      state: 'running',
      cancelRequested: false,
      controller: new AbortController(),
      promise: Promise.resolve(),
      committedSequence: 0,
    };
    this.operations.set(operation.operationId, operation);
    registered.activeLeases++;
    registered.lastUsedAt = now;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    if (request.deadlineAt !== undefined) {
      const delay = Math.max(0, request.deadlineAt - now);
      deadlineTimer = setTimeout(() => operation.controller.abort(new Error('deadline exceeded')), delay);
    }
    operation.promise = (async () => {
      try {
        const result = await action(this.runtimeFor(operation), input);
        if (operation.cancelRequested) {
          operation.state = 'cancelled';
        } else {
          try {
            operation.result = assertJsonValue(result, this.opts.maxJsonBytes, 'operation result');
          } catch (error) {
            throw new JsrpcError(structuredError('RESULT_NOT_SERIALIZABLE', error instanceof Error ? error.message : String(error), 500, {
              phase: 'serialize',
              stack: error instanceof Error ? error.stack : undefined,
            }));
          }
          operation.state = 'succeeded';
        }
      } catch (error) {
        if (operation.checkpointFailure) {
          operation.state = 'failed';
          operation.error = operation.checkpointFailure;
        } else if (operation.cancelRequested || isAbortError(error) || operation.controller.signal.aborted) {
          operation.state = 'cancelled';
          operation.error = withOperationContext(structuredError('CANCELLED', 'Operation was cancelled', 499, {phase: 'execute', retryable: false}), operation);
        } else {
          operation.state = 'failed';
          operation.error = withOperationContext(toStructuredError(error, 'EXECUTION_ERROR'), operation);
          operation.error.phase ||= 'execute';
        }
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        operation.finishedAt = this.now();
        registered.activeLeases = Math.max(0, registered.activeLeases - 1);
        registered.lastUsedAt = this.now();
      }
    })();
    await this.waitFor(operation, Math.max(0, request.waitMs ?? 0));
    return {operation: this.operationStatus(operation)};
  }

  status(operationId: string): JsrpcOperationStatus {
    this.sweep();
    const operation = this.operations.get(operationId);
    if (!operation) throw new JsrpcError(structuredError('OPERATION_NOT_FOUND', 'Operation does not exist or has expired', 404, {phase: 'register', operationId}));
    return this.operationStatus(operation);
  }

  async cancel(request: JsrpcOperationCancelRequest): Promise<JsrpcOperationStatus> {
    const operation = this.operations.get(request.operationId);
    if (!operation) throw new JsrpcError(structuredError('OPERATION_NOT_FOUND', 'Operation does not exist or has expired', 404, {phase: 'register', operationId: request.operationId}));
    if (operation.state === 'running') {
      operation.cancelRequested = true;
      operation.controller.abort(new Error('cancelled'));
      await this.waitFor(operation, Math.max(0, request.waitMs ?? 0));
    }
    return this.operationStatus(operation);
  }

  async checkpoint(request: JsrpcCheckpointRequest): Promise<JsonValue | undefined> {
    const operation = this.operations.get(request.operationId);
    if (!operation) throw new JsrpcError(structuredError('OPERATION_NOT_FOUND', 'Operation does not exist or has expired', 404, {phase: 'checkpoint', operationId: request.operationId}));
    if (request.releaseId && request.releaseId !== operation.releaseId || request.action && request.action !== operation.action || request.taskGeneration && request.taskGeneration !== operation.taskGeneration) {
      throw new JsrpcError(structuredError('CHECKPOINT_CONTEXT_MISMATCH', 'Checkpoint context does not match operation', 409, {phase: 'checkpoint', ...withOperationContext({}, operation)}));
    }
    return this.enqueueCheckpoint(operation, request.payload, request.type || 'checkpoint', request.sequence);
  }

  async handle(path: string, body: any): Promise<JsrpcHttpResponse> {
    try {
      switch (path.replace(/\/+$/, '')) {
        case '/jsrpc/v2/handshake': return {status: 200, body: this.handshake()};
        case '/jsrpc/v2/releases/register': return {status: 200, body: this.registerRelease(body?.release)};
        case '/jsrpc/v2/invoke': return {status: 200, body: await this.invoke(body)};
        case '/jsrpc/v2/operations/status': return {status: 200, body: this.status(body?.operationId)};
        case '/jsrpc/v2/operations/cancel': return {status: 200, body: await this.cancel(body)};
        case '/jsrpc/v2/checkpoints': return {status: 200, body: await this.checkpoint(body)};
        default: return {status: 404, body: structuredError('NOT_FOUND', 'Unknown JSRPC endpoint', 404)};
      }
    } catch (error) {
      const structured = toStructuredError(error);
      return {status: structured.status, body: structured};
    }
  }
}

export function createJsrpcKernel(options: JsrpcKernelOptions): JsrpcKernel {
  return new JsrpcKernel(options);
}
