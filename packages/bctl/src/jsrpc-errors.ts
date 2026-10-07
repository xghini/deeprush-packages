import type {JsrpcStructuredError, JsonValue} from './jsrpc-types.js';

export class JsrpcError extends Error {
  readonly code: string;
  readonly status: number;
  readonly phase?: JsrpcStructuredError['phase'];
  readonly stack?: string;
  readonly retryable: boolean;
  readonly operationId?: string;
  readonly releaseId?: string;
  readonly action?: string;
  readonly taskGeneration?: string;
  readonly details?: JsonValue;

  constructor(error: JsrpcStructuredError) {
    super(error.message);
    this.name = 'JsrpcError';
    this.code = error.code;
    this.status = error.status;
    this.phase = error.phase;
    if (error.stack) this.stack = error.stack;
    this.retryable = error.retryable ?? false;
    this.operationId = error.operationId;
    this.releaseId = error.releaseId;
    this.action = error.action;
    this.taskGeneration = error.taskGeneration;
    this.details = error.details;
  }

  toJSON(): JsrpcStructuredError {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      ...(this.phase ? {phase: this.phase} : {}),
      ...(this.stack ? {stack: this.stack} : {}),
      retryable: this.retryable,
      ...(this.operationId ? {operationId: this.operationId} : {}),
      ...(this.releaseId ? {releaseId: this.releaseId} : {}),
      ...(this.action ? {action: this.action} : {}),
      ...(this.taskGeneration ? {taskGeneration: this.taskGeneration} : {}),
      ...(this.details !== undefined ? {details: this.details} : {}),
    };
  }
}

export function structuredError(
  code: string,
  message: string,
  status = 400,
  extras: Omit<Partial<JsrpcStructuredError>, 'code' | 'message' | 'status'> = {},
): JsrpcStructuredError {
  return {code, message, status, ...extras};
}

export function toStructuredError(error: unknown, fallbackCode = 'EXECUTION_ERROR'): JsrpcStructuredError {
  if (error instanceof JsrpcError) return error.toJSON();
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const candidate = error as Partial<JsrpcStructuredError>;
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      return structuredError(candidate.code, candidate.message, typeof candidate.status === 'number' ? candidate.status : 500, {
        retryable: candidate.retryable,
        phase: candidate.phase,
        stack: candidate.stack,
        operationId: candidate.operationId,
        releaseId: candidate.releaseId,
        action: candidate.action,
        taskGeneration: candidate.taskGeneration,
        details: candidate.details,
      });
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return structuredError(fallbackCode, message || 'JSRPC action failed', 500, {
    retryable: false,
    stack: error instanceof Error ? error.stack : undefined,
  });
}

export function asJsrpcError(error: unknown): JsrpcError {
  return error instanceof JsrpcError ? error : new JsrpcError(toStructuredError(error));
}
