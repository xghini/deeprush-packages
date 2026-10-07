import fs from 'node:fs';
import {describe, expect, it} from 'vitest';

describe('JSRPC runtime/build package boundary', () => {
  it('keeps runtime entry free of builder/fs/path/esbuild imports', () => {
    const runtimeSource = fs.readFileSync(new URL('../src/jsrpc.ts', import.meta.url), 'utf8');
    const releaseSource = fs.readFileSync(new URL('../src/jsrpc-release.ts', import.meta.url), 'utf8');
    expect(runtimeSource).not.toContain('jsrpc-builder');
    expect(runtimeSource).not.toContain('jsrpc-build');
    expect(runtimeSource).toContain("export * from './jsrpc-errors.js';");
    expect(releaseSource).not.toMatch(/from ['"]node:(?:fs|path)['"]|from ['"]esbuild['"]/);
  });
});
