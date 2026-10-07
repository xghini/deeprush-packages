import {describe, expect, it, vi} from 'vitest';
import {fileURLToPath} from 'node:url';
import {
  createJsrpcClient,
  createJsrpcKernel,
  JsrpcError,
} from '../src/jsrpc.js';
import {JsrpcBundleError, buildJsrpcBundle} from '../src/jsrpc-build.js';
import {canonicalJson, computeJsrpcReleaseId, createJsrpcRelease} from '../src/jsrpc-release.js';
import type {JsrpcCheckpointEnvelope} from '../src/jsrpc-types.js';

describe('JSRPC v2 release identity and builder', () => {
  it('canonicalizes manifest keys and hashes the canonical manifest plus source', () => {
    const manifest = {kernelAbiRange: '1.x', actions: [{name: 'echo', mutation: 'read' as const}]};
    const release = createJsrpcRelease(manifest, '(runtime, input) => input');
    expect(release.manifest.artifact).toBe('deeprush-jsrpc-iife-v1');
    expect(release.releaseId).toBe(computeJsrpcReleaseId(release.manifest, release.source));
    expect(canonicalJson({b: 1, a: {d: 2, c: 3}})).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('builds a single IIFE and rejects module/host imports', async () => {
    const release = await buildJsrpcBundle({
      manifest: {kernelAbiRange: '1.x', actions: [{name: 'echo', mutation: 'read'}]},
      source: '(runtime, input) => input',
    });
    expect(release.source).toContain('__jsrpcBundle');
    expect(release.source).toContain('sourceURL=jsrpc://');
    expect(release.source).not.toMatch(/(^|\n)\s*(import|export)\s/);
    await expect(buildJsrpcBundle({
      manifest: {kernelAbiRange: '1.x', actions: [{name: 'echo', mutation: 'read'}]},
      source: 'import fs from "node:fs"; (runtime, input) => input',
    })).rejects.toThrow(/imports/);
  });

  it('bundles a TS entry and its transitive local dependency graph', async () => {
    const entryPath = fileURLToPath(new URL('./fixtures/jsrpc-entry.ts', import.meta.url));
    const release = await buildJsrpcBundle({
      entryPath,
      manifest: {kernelAbiRange: '1.x', actions: [{name: 'decorated', mutation: 'read'}]},
    });
    expect(release.source).toContain('__jsrpcBundle');
    const kernel = createJsrpcKernel({kernelAbi: '1.0'});
    kernel.registerRelease(release);
    const result = await kernel.invoke({operationId: 'entry-1', releaseId: release.releaseId, action: 'decorated', input: {value: 'ok'}, waitMs: 100});
    expect(result.operation.result).toBe('decorated:ok');
  });

  it('rejects dynamic and forbidden external imports with readable audit errors', async () => {
    const dynamic = fileURLToPath(new URL('./fixtures/jsrpc-entry-dynamic.js', import.meta.url));
    await expect(buildJsrpcBundle({entryPath: dynamic, manifest: {kernelAbiRange: '1.x', actions: [{name: 'dynamic', mutation: 'read'}]}})).rejects.toMatchObject({name: 'JsrpcBundleError', audit: {dynamicImports: ['<dynamic>']}});
    const forbidden = fileURLToPath(new URL('./fixtures/jsrpc-entry-forbidden.js', import.meta.url));
    await expect(buildJsrpcBundle({entryPath: forbidden, manifest: {kernelAbiRange: '1.x', actions: [{name: 'forbidden', mutation: 'read'}]}})).rejects.toMatchObject({name: 'JsrpcBundleError', audit: {forbiddenImports: ['pg']}});
    expect(JsrpcBundleError).toBeDefined();
  });
});

describe('JSRPC v2 kernel', () => {
  async function fixture(options: Partial<Parameters<typeof createJsrpcKernel>[0]> = {}) {
    const release = await buildJsrpcBundle({
      manifest: {kernelAbiRange: '1.x', actions: [
        {name: 'echo', mutation: 'read'},
        {name: 'slow', mutation: 'idempotent'},
        {name: 'cancel', mutation: 'idempotent'},
      ]},
      source: `({
        echo: (runtime, input) => input,
        slow: (runtime, input) => new Promise(resolve => setTimeout(() => resolve(input.value), input.delay)),
        cancel: (runtime, input) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve('late'), input.delay);
          runtime.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); }, {once: true});
        }),
      })`,
    });
    const kernel = createJsrpcKernel({kernelAbi: '1.2', capabilities: {}, ...options});
    return {release, kernel};
  }

  it('handshakes, registers present release and invokes with dedupe', async () => {
    const {release, kernel} = await fixture();
    expect(kernel.handshake().wireVersion).toBe('jsrpc.v2');
    const first = kernel.registerRelease(release);
    expect(first.status).toBe('registered');
    expect(kernel.registerRelease(release).status).toBe('present');
    expect(() => kernel.registerRelease({...release, releaseId: 'not-a-hash'})).toThrowError(JsrpcError);
    expect(() => kernel.registerRelease({...release, source: `${release.source}\n// tampered`})).toThrowError(/different contents/);
    const one = await kernel.invoke({operationId: 'op-1', releaseId: release.releaseId, action: 'echo', input: {value: 42}, waitMs: 100});
    const two = await kernel.invoke({operationId: 'op-1', releaseId: release.releaseId, action: 'echo', input: {value: 42}, waitMs: 100});
    expect(one.operation.state).toBe('succeeded');
    expect(two.operation.result).toEqual({value: 42});
  });

  it('joins a running operation and rejects a different fingerprint', async () => {
    const {release, kernel} = await fixture();
    kernel.registerRelease(release);
    const running = await kernel.invoke({operationId: 'op-slow', releaseId: release.releaseId, action: 'slow', input: {kind: 'slow', value: 'ok', delay: 40}, waitMs: 0});
    expect(running.operation.state).toBe('running');
    const joined = await kernel.invoke({operationId: 'op-slow', releaseId: release.releaseId, action: 'slow', input: {kind: 'slow', value: 'ok', delay: 40}, waitMs: 200});
    expect(joined.operation.state).toBe('succeeded');
    await expect(kernel.invoke({operationId: 'op-slow', releaseId: release.releaseId, action: 'slow', input: {kind: 'slow', value: 'different', delay: 1}, waitMs: 0})).rejects.toMatchObject({code: 'OPERATION_CONFLICT'});
  });

  it('cancels cooperatively and reaches a terminal state', async () => {
    const {release, kernel} = await fixture();
    kernel.registerRelease(release);
    await kernel.invoke({operationId: 'op-cancel', releaseId: release.releaseId, action: 'cancel', input: {kind: 'cancel', delay: 500}, waitMs: 0});
    const cancelled = await kernel.cancel({operationId: 'op-cancel', waitMs: 200});
    expect(cancelled.state).toBe('cancelled');
    expect(kernel.status('op-cancel').state).toBe('cancelled');
  });

  it('generates strict checkpoint sequences and waits for controller acknowledgements', async () => {
    const received: Array<Record<string, unknown>> = [];
    const release = await buildJsrpcBundle({
      manifest: {kernelAbiRange: '1.x', actions: [{name: 'checkpoint', mutation: 'external-write'}]},
      source: `(runtime, input) => (async () => {
        await runtime.checkpoint({stage: 1}, 'candidate');
        await runtime.checkpoint({stage: 2}, 'verified');
        return 'ok';
      })()`,
    });
    const kernel = createJsrpcKernel({kernelAbi: '1.0', checkpoint: async envelope => {
      received.push(envelope as unknown as Record<string, unknown>);
      return {accepted: true, sequence: envelope.sequence, operationId: envelope.operationId};
    }});
    kernel.registerRelease(release);
    const result = await kernel.invoke({operationId: 'checkpoint-1', releaseId: release.releaseId, action: 'checkpoint', taskGeneration: 'g1', input: null, waitMs: 100});
    expect(result.operation.state).toBe('succeeded');
    expect(received.map(item => item.sequence)).toEqual([1, 2]);
    expect(received[0]).toMatchObject({operationId: 'checkpoint-1', releaseId: release.releaseId, action: 'checkpoint', taskGeneration: 'g1', type: 'candidate'});
  });

  it('fails closed for missing/undefined/fake acknowledgements and retries failed events unchanged', async () => {
    const release = await buildJsrpcBundle({
      manifest: {kernelAbiRange: '1.x', actions: [{name: 'checkpoint', mutation: 'external-write'}]},
      source: `(runtime) => runtime.checkpoint({stage: 1}, 'candidate')`,
    });
    const missing = createJsrpcKernel({kernelAbi: '1.0'});
    missing.registerRelease(release);
    const missingResult = await missing.invoke({operationId: 'checkpoint-missing', releaseId: release.releaseId, action: 'checkpoint', waitMs: 100});
    expect(missingResult.operation.error).toMatchObject({code: 'CHECKPOINT_CALLBACK_MISSING', phase: 'checkpoint', operationId: 'checkpoint-missing'});

    let mode: 'undefined' | 'non-object' | 'wrong-operation' | 'wrong-sequence' | 'valid' = 'undefined';
    const sent: JsrpcCheckpointEnvelope[] = [];
    const kernel = createJsrpcKernel({kernelAbi: '1.0', checkpoint: async envelope => {
      sent.push(envelope);
      if (mode === 'undefined') return undefined;
      if (mode === 'non-object') return 'fake-ack';
      if (mode === 'wrong-operation') return {accepted: true, operationId: 'wrong', sequence: envelope.sequence};
      if (mode === 'wrong-sequence') return {accepted: true, operationId: envelope.operationId, sequence: envelope.sequence + 1};
      return {accepted: true, operationId: envelope.operationId, sequence: envelope.sequence, fingerprint: envelope.fingerprint};
    }});
    kernel.registerRelease(release);
    await kernel.invoke({operationId: 'checkpoint-retry', releaseId: release.releaseId, action: 'checkpoint', waitMs: 0});
    const direct = await buildJsrpcBundle({manifest: {kernelAbiRange: '1.x', actions: [{name: 'read', mutation: 'read'}]}, source: '(runtime, input) => input'});
    kernel.registerRelease(direct);
    await kernel.invoke({operationId: 'checkpoint-direct', releaseId: direct.releaseId, action: 'read', input: null, waitMs: 100});
    await expect(kernel.checkpoint({operationId: 'checkpoint-direct', releaseId: direct.releaseId, action: 'read', sequence: 1, type: 'candidate', payload: {stage: 1}})).rejects.toMatchObject({code: 'CHECKPOINT_ACK_INVALID'});
    expect((kernel as any).operations.get('checkpoint-direct').committedSequence).toBe(0);
    mode = 'valid';
    await kernel.checkpoint({operationId: 'checkpoint-direct', releaseId: direct.releaseId, action: 'read', sequence: 1, type: 'candidate', payload: {stage: 1}});
    expect(sent.at(-1)).toMatchObject({sequence: 1, type: 'candidate', payload: {stage: 1}});
    expect(sent.at(-1)?.fingerprint).toBe(sent.at(-2)?.fingerprint);
    expect((kernel as any).operations.get('checkpoint-direct').committedSequence).toBe(1);
    mode = 'non-object';
    await expect(kernel.checkpoint({operationId: 'checkpoint-direct', releaseId: direct.releaseId, action: 'read', sequence: 2, type: 'verified', payload: {stage: 2}})).rejects.toMatchObject({code: 'CHECKPOINT_ACK_INVALID'});
    mode = 'valid';
    await kernel.checkpoint({operationId: 'checkpoint-direct', releaseId: direct.releaseId, action: 'read', sequence: 2, type: 'verified', payload: {stage: 2}});
    expect((kernel as any).operations.get('checkpoint-direct').committedSequence).toBe(2);
    await expect(kernel.checkpoint({operationId: 'checkpoint-direct', releaseId: direct.releaseId, action: 'read', sequence: 4, type: 'verified', payload: {stage: 3}})).rejects.toMatchObject({code: 'CHECKPOINT_SEQUENCE'});

    mode = 'wrong-operation';
    await expect(kernel.checkpoint({operationId: 'checkpoint-direct', releaseId: direct.releaseId, action: 'read', sequence: 3, type: 'verified', payload: {stage: 3}})).rejects.toMatchObject({code: 'CHECKPOINT_ACK_CONTEXT'});
    mode = 'wrong-sequence';
    await expect(kernel.checkpoint({operationId: 'checkpoint-direct', releaseId: direct.releaseId, action: 'read', sequence: 3, type: 'verified', payload: {stage: 3}})).rejects.toMatchObject({code: 'CHECKPOINT_ACK_SEQUENCE'});
    expect((kernel as any).operations.get('checkpoint-direct').committedSequence).toBe(2);
  });

  it('joins identical concurrent checkpoints and advances only after the shared ack', async () => {
    const received: JsrpcCheckpointEnvelope[] = [];
    const release = await buildJsrpcBundle({
      manifest: {kernelAbiRange: '1.x', actions: [{name: 'checkpoint', mutation: 'external-write'}]},
      source: `(runtime) => Promise.all([runtime.checkpoint({stage: 1}), runtime.checkpoint({stage: 1})]).then(() => runtime.checkpoint({stage: 2}, 'verified'))`,
    });
    const kernel = createJsrpcKernel({kernelAbi: '1.0', checkpoint: async envelope => {
      received.push(envelope);
      return {accepted: true, operationId: envelope.operationId, sequence: envelope.sequence, fingerprint: envelope.fingerprint};
    }});
    kernel.registerRelease(release);
    const result = await kernel.invoke({operationId: 'checkpoint-concurrent', releaseId: release.releaseId, action: 'checkpoint', waitMs: 100});
    expect(result.operation.state).toBe('succeeded');
    expect(received.map(item => item.sequence)).toEqual([1, 2]);
  });

  it('retains action context, phase and stack for execute/checkpoint/serialize errors', async () => {
    const release = await buildJsrpcBundle({
      manifest: {kernelAbiRange: '1.x', actions: [
        {name: 'throws', mutation: 'read'},
        {name: 'checkpointReject', mutation: 'external-write'},
        {name: 'badResult', mutation: 'read'},
      ]},
      source: `({
        throws: () => { throw new Error('action boom'); },
        checkpointReject: runtime => runtime.checkpoint({stage: 1}),
        badResult: () => BigInt(1),
      })`,
    });
    const kernel = createJsrpcKernel({kernelAbi: '1.0', checkpoint: async envelope => ({accepted: false, sequence: envelope.sequence, operationId: envelope.operationId, message: 'controller rejected'})});
    kernel.registerRelease(release);
    const execution = await kernel.invoke({operationId: 'error-execute', releaseId: release.releaseId, action: 'throws', taskGeneration: 'g2', waitMs: 100});
    expect(execution.operation.error).toMatchObject({phase: 'execute', action: 'throws', operationId: 'error-execute', releaseId: release.releaseId, taskGeneration: 'g2'});
    expect(execution.operation.error?.stack).toContain('action boom');
    const checkpoint = await kernel.invoke({operationId: 'error-checkpoint', releaseId: release.releaseId, action: 'checkpointReject', taskGeneration: 'g3', waitMs: 100});
    expect(checkpoint.operation.error).toMatchObject({phase: 'checkpoint', action: 'checkpointReject', operationId: 'error-checkpoint'});
    const serialization = await kernel.invoke({operationId: 'error-serialize', releaseId: release.releaseId, action: 'badResult', waitMs: 100});
    expect(serialization.operation.error).toMatchObject({phase: 'serialize', action: 'badResult', operationId: 'error-serialize'});
  });

  it('validates ABI and capability and keeps active releases leased', async () => {
    const {release, kernel} = await fixture({maxReleases: 1, releaseTtlMs: 0});
    kernel.registerRelease(release);
    const incompatible = createJsrpcRelease({kernelAbiRange: '2.x', actions: [{name: 'echo', mutation: 'read'}]}, release.source);
    try {
      kernel.registerRelease(incompatible);
      throw new Error('expected ABI mismatch');
    } catch (error) {
      expect(error).toMatchObject({name: 'JsrpcError', code: 'ABI_MISMATCH', phase: 'register'});
    }
    const capabilityRelease = createJsrpcRelease({kernelAbiRange: '1.x', actions: [{name: 'echo', mutation: 'read', requiredCapabilities: ['cdp']} ]}, release.source);
    try {
      kernel.registerRelease(capabilityRelease);
      throw new Error('expected capability mismatch');
    } catch (error) {
      expect(error).toMatchObject({code: 'CAPABILITY_MISMATCH'});
    }
  });

  it('does not evict an active release when the registry is at capacity', async () => {
    const {release, kernel} = await fixture({maxReleases: 1, releaseTtlMs: 100_000});
    kernel.registerRelease(release);
    const pending = kernel.invoke({operationId: 'op-active', releaseId: release.releaseId, action: 'slow', input: {kind: 'slow', value: 'done', delay: 50}, waitMs: 0});
    const second = createJsrpcRelease({kernelAbiRange: '1.x', actions: [{name: 'echo', mutation: 'read'}]}, '(runtime, input) => input');
    await expect(pending).resolves.toMatchObject({operation: {state: 'running'}});
    expect(() => kernel.registerRelease(second)).toThrowError(/slot|capacity/i);
    expect((await kernel.status('op-active')).state).toBe('running');
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(kernel.status('op-active').state).toBe('succeeded');
  });

  it('expires terminal operations and reports structured errors', async () => {
    let now = 1000;
    const {release, kernel} = await fixture({now: () => now, operationTtlMs: 10});
    kernel.registerRelease(release);
    await kernel.invoke({operationId: 'op-ttl', releaseId: release.releaseId, action: 'echo', input: null, waitMs: 10});
    now += 11;
    expect(() => kernel.status('op-ttl')).toThrowError(/expired/);
    const response = await kernel.handle('/jsrpc/v2/operations/status', {operationId: 'missing'});
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({code: 'OPERATION_NOT_FOUND', status: 404});
  });
});

describe('JSRPC v2 client', () => {
  it('keeps structured remote errors and calls the expected endpoints', async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({wireVersion: 'jsrpc.v2', bootId: 'boot', kernelAbi: '1.0', identity: {}, capabilities: [], limits: {maxReleaseSourceBytes: 1, maxReleases: 1, operationTtlMs: 1}}), {status: 200, headers: {'content-type': 'application/json'}});
    }) as unknown as typeof globalThis.fetch;
    const client = createJsrpcClient({serverUrl: 'http://test', fetch});
    expect((await client.handshake()).bootId).toBe('boot');
    expect(calls).toEqual(['http://test/jsrpc/v2/handshake']);
  });

  it('does not drop structured error stack, phase or action context', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({code: 'CHECKPOINT_REJECTED', message: 'no', status: 409, phase: 'checkpoint', stack: 'server-stack', operationId: 'op', releaseId: 'rel', action: 'iam', taskGeneration: 'g'}), {status: 409}));
    const client = createJsrpcClient({serverUrl: 'http://test', fetch: fetch as unknown as typeof globalThis.fetch});
    await expect(client.status('op')).rejects.toMatchObject({code: 'CHECKPOINT_REJECTED', phase: 'checkpoint', stack: 'server-stack', action: 'iam', taskGeneration: 'g'});
  });

  it('rejects a handshake from the wrong JSRPC wire generation before accepting bootId', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({wireVersion: 'jsrpc.v1', bootId: 'wrong-generation', kernelAbi: '1.0', identity: {}, capabilities: [], limits: {maxReleaseSourceBytes: 1, maxReleases: 1, operationTtlMs: 1}}), {status: 200}));
    const client = createJsrpcClient({serverUrl: 'http://test', fetch: fetch as unknown as typeof globalThis.fetch});
    await expect(client.handshake()).rejects.toMatchObject({code: 'WIRE_VERSION_MISMATCH', phase: 'register'});
  });

  it('converges invoke through status to terminal and detects boot changes', async () => {
    let statusCalls = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/handshake')) return new Response(JSON.stringify({wireVersion: 'jsrpc.v2', bootId: 'boot-a', kernelAbi: '1.0', identity: {}, capabilities: [], limits: {maxReleaseSourceBytes: 1, maxReleases: 1, operationTtlMs: 86_400_000}}), {status: 200});
      if (url.endsWith('/invoke')) return new Response(JSON.stringify({operation: {operationId: 'wait-1', bootId: 'boot-a', state: 'running', releaseId: 'r', action: 'read', mutation: 'read', startedAt: 1, cancelRequested: false}}), {status: 200});
      statusCalls++;
      return new Response(JSON.stringify({operationId: 'wait-1', bootId: 'boot-a', state: 'succeeded', releaseId: 'r', action: 'read', mutation: 'read', startedAt: 1, finishedAt: 2, cancelRequested: false, result: {ok: true}}), {status: 200});
    }) as unknown as typeof globalThis.fetch;
    const client = createJsrpcClient({serverUrl: 'http://test', fetch, pollIntervalMs: 0});
    const terminalStatus = await client.invokeAndWait({operationId: 'wait-1', releaseId: 'r', action: 'read', input: null}, {pollIntervalMs: 0, timeoutMs: 100});
    expect(terminalStatus.state).toBe('succeeded');
    expect(statusCalls).toBe(1);
  });
});
