import type {
  JsrpcCheckpointRequest,
  JsrpcHandshakeResponse,
  JsrpcInvokeRequest,
  JsrpcInvokeResponse,
  JsrpcOperationCancelRequest,
  JsrpcOperationStatus,
  JsrpcRelease,
  JsrpcRegisterReleaseResponse,
  JsrpcStructuredError,
  JsonValue,
} from './jsrpc-types.js';
import {JsrpcError, structuredError, toStructuredError} from './jsrpc-errors.js';

export interface JsrpcClientOptions {
  serverUrl?: string;
  timeout?: number;
  pollIntervalMs?: number;
  maxJsonBytes?: number;
  fetch?: typeof globalThis.fetch;
}

export interface JsrpcWaitOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onStatus?: (status: JsrpcOperationStatus) => void;
}

export interface JsrpcClient {
  handshake(signal?: AbortSignal): Promise<JsrpcHandshakeResponse>;
  registerRelease(release: JsrpcRelease, signal?: AbortSignal): Promise<JsrpcRegisterReleaseResponse>;
  invoke(request: JsrpcInvokeRequest, signal?: AbortSignal): Promise<JsrpcInvokeResponse>;
  /** Invoke once, then status-poll until a terminal operation is observed. */
  invokeAndWait(request: JsrpcInvokeRequest, options?: JsrpcWaitOptions): Promise<JsrpcOperationStatus>;
  status(operationId: string, signal?: AbortSignal): Promise<JsrpcOperationStatus>;
  cancel(request: JsrpcOperationCancelRequest, signal?: AbortSignal): Promise<JsrpcOperationStatus>;
  checkpoint(request: JsrpcCheckpointRequest, signal?: AbortSignal): Promise<JsonValue | undefined>;
}

const DEFAULT_SERVER_URL = 'http://127.0.0.1:3175';
const DEFAULT_TIMEOUT = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_JSON_BYTES = 2 * 1024 * 1024;

function assertJson(value: unknown, maxBytes: number, label: string): void {
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
      else Object.values(item as Record<string, unknown>).forEach(visit);
      seen.delete(item);
    }
  };
  visit(value);
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > maxBytes) throw new Error(`${label} exceeds JSON size limit (${maxBytes} bytes)`);
}

function terminal(state: JsrpcOperationStatus['state']): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

export function createJsrpcClient(options: JsrpcClientOptions = {}): JsrpcClient {
  const baseUrl = (options.serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, '');
  const fetchImpl = options.fetch || globalThis.fetch;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const maxJsonBytes = options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
  const defaultPollInterval = options.pollIntervalMs ?? 250;
  let lastBootId: string | undefined;

  async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let encodedBody: string | undefined;
    try {
      if (body !== undefined) {
        assertJson(body, maxJsonBytes, 'JSRPC request');
        encodedBody = JSON.stringify(body);
      }
    } catch (error) {
      throw new JsrpcError(structuredError('REQUEST_NOT_SERIALIZABLE', error instanceof Error ? error.message : String(error), 422, {phase: 'serialize', stack: error instanceof Error ? error.stack : undefined}));
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error('JSRPC request timeout')), timeout);
    const abort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, {once: true});
    }
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        ...(encodedBody === undefined ? {} : {body: encodedBody}),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown;
      try { parsed = text ? JSON.parse(text) : undefined; }
      catch (error) {
        throw new JsrpcError(structuredError('RESPONSE_NOT_SERIALIZABLE', 'JSRPC response is not valid JSON', 502, {phase: 'serialize', stack: error instanceof Error ? error.stack : undefined}));
      }
      if (!response.ok) throw new JsrpcError(toStructuredError(parsed || new Error(text || `JSRPC request failed (${response.status})`), 'REMOTE_ERROR'));
      return parsed as T;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function handshake(signal?: AbortSignal): Promise<JsrpcHandshakeResponse> {
    const result = await request<JsrpcHandshakeResponse>('/jsrpc/v2/handshake', undefined, signal);
    if (result.wireVersion !== 'jsrpc.v2') throw new JsrpcError(structuredError('WIRE_VERSION_MISMATCH', `Unsupported JSRPC wire version: ${String(result.wireVersion)}`, 409, {phase: 'register', retryable: false, details: {expected: 'jsrpc.v2', received: result.wireVersion}}));
    if (!result.bootId) throw new JsrpcError(structuredError('BOOT_ID_MISSING', 'Handshake did not provide a Browser bootId', 502, {phase: 'register', retryable: true}));
    lastBootId = result.bootId;
    return result;
  }

  const invokeRequest = (body: JsrpcInvokeRequest, signal?: AbortSignal) => request<JsrpcInvokeResponse>('/jsrpc/v2/invoke', body, signal);
  const statusRequest = (operationId: string, signal?: AbortSignal) => request<JsrpcOperationStatus>('/jsrpc/v2/operations/status', {operationId}, signal);

  async function invokeAndWait(requestBody: JsrpcInvokeRequest, waitOptions: JsrpcWaitOptions = {}): Promise<JsrpcOperationStatus> {
    const before = await handshake(waitOptions.signal);
    const initial = (await invokeRequest(requestBody, waitOptions.signal)).operation;
    if (initial.bootId && initial.bootId !== before.bootId) throw new JsrpcError(structuredError('BOOT_ID_CHANGED', 'Browser bootId changed during invoke', 409, {phase: 'execute', operationId: requestBody.operationId, releaseId: requestBody.releaseId, action: requestBody.action, retryable: true}));
    let current = initial;
    if (terminal(current.state)) return current;
    const deadline = Date.now() + (waitOptions.timeoutMs ?? timeout);
    const pollInterval = waitOptions.pollIntervalMs ?? defaultPollInterval;
    while (!terminal(current.state)) {
      if (waitOptions.signal?.aborted) throw new JsrpcError(structuredError('ABORTED', 'JSRPC wait was aborted', 499, {phase: 'execute', operationId: requestBody.operationId, releaseId: requestBody.releaseId, action: requestBody.action, retryable: true}));
      if (Date.now() >= deadline) throw new JsrpcError(structuredError('WAIT_TIMEOUT', 'JSRPC operation did not reach terminal state before timeout', 408, {phase: 'execute', operationId: requestBody.operationId, releaseId: requestBody.releaseId, action: requestBody.action, retryable: true}));
      await new Promise(resolve => setTimeout(resolve, Math.min(pollInterval, Math.max(1, deadline - Date.now()))));
      try { current = await statusRequest(requestBody.operationId, waitOptions.signal); }
      catch (error) {
        if (error instanceof JsrpcError && error.code === 'OPERATION_NOT_FOUND') throw new JsrpcError(structuredError('OPERATION_NOT_FOUND', 'Operation disappeared while waiting; do not replay an external write', 404, {phase: 'execute', operationId: requestBody.operationId, releaseId: requestBody.releaseId, action: requestBody.action, retryable: false, stack: error.stack}));
        throw error;
      }
      if (current.bootId && current.bootId !== before.bootId || lastBootId && current.bootId && current.bootId !== lastBootId) throw new JsrpcError(structuredError('BOOT_ID_CHANGED', 'Browser bootId changed while waiting for operation', 409, {phase: 'execute', operationId: requestBody.operationId, releaseId: requestBody.releaseId, action: requestBody.action, retryable: true, details: {before: before.bootId, after: current.bootId}}));
      lastBootId = current.bootId || lastBootId;
      waitOptions.onStatus?.(current);
    }
    return current;
  }

  return {
    handshake,
    registerRelease: (release, signal) => request<JsrpcRegisterReleaseResponse>('/jsrpc/v2/releases/register', {release}, signal),
    invoke: invokeRequest,
    invokeAndWait,
    status: statusRequest,
    cancel: (body, signal) => request<JsrpcOperationStatus>('/jsrpc/v2/operations/cancel', body, signal),
    checkpoint: (body, signal) => request<JsonValue | undefined>('/jsrpc/v2/checkpoints', body, signal),
  };
}
