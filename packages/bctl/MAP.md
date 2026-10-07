# BCTL / JSRPC map

`tools/bctl` is the sole source owner for the `@deeprush/bctl` package and the
JSRPC wire contract. Consumers such as APanel may use the published client and
types but must not copy the wire schema or create a second executor.

## Boundaries

- `src/jsrpc-types.ts`: wire values, release manifest, operation/status/error contracts.
- `src/jsrpc-release.ts`: pure runtime canonical manifest/source hash and release identity; no fs/path/esbuild.
- `src/jsrpc-build.ts`: Windows/controller-only TS/JS entry graph bundler and `deeprush-jsrpc-iife-v1` builder.
- `src/jsrpc-client.ts`: controller-side v2 HTTP client.
- `src/jsrpc-kernel.ts`: Browser-side in-memory release registry, operation ledger, reverse durable checkpoint ack and v2 handlers.
- `src/remote.ts`: legacy v1 `createRemoteCtl`; its contract remains unchanged during migration.
- `scripts/version.ts`: BCTL-only calendar version writer; it never updates the root application version.

The kernel owns Browser/Context/Page capabilities, release leases and operation
dedupe only. Workflow, database, recovery, account locks and external business
state remain in the controller. Action bundles receive explicit `runtime` and
`input`; they must not import Playwright, access host modules, or persist business
state in the Browser. The entry builder recursively bundles local dependencies,
rejects dynamic/residual imports and emits a sourceURL for diagnostic stacks.
Checkpoint callback envelopes carry operationId, releaseId, action, taskGeneration,
type, payload and a strict sequence; the Browser waits for the matching controller
acknowledgement. A missing callback or invalid/rejected ack fails closed and the
action cannot continue. Failed pending events retain the same sequence and
fingerprint for retry; committedSequence advances only after the matching ack.

## Migration contract

JSRPC v2 is additive beside `/remoteCtl` v1. Route migration is controlled by the
consumer; v1 behavior remains available until every route has an independent
consumer acceptance. Business action releases are registered in Browser memory
and never synchronized as source files to Mac or Windows Browser disks.
