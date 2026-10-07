import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {formatCalendarVersion, nextCalendarVersion, writeCalendarVersion} from '../scripts/version.ts';

describe('BCTL calendar version', () => {
  it('uses local calendar arithmetic without leading zero segments', () => {
    expect(formatCalendarVersion(new Date(2026, 7, 8, 22, 57, 25))).toBe('26.808.225725');
    expect(formatCalendarVersion(new Date(2026, 0, 2, 3, 4, 5))).toBe('26.102.30405');
  });

  it('is monotonic when called in the same or an earlier second', () => {
    const clock = new Date(2026, 7, 8, 22, 57, 25);
    expect(nextCalendarVersion(clock, '26.808.225725')).toBe('26.808.225726');
    expect(nextCalendarVersion(new Date(2026, 7, 8, 22, 57, 24), '26.808.225725')).toBe('26.808.225726');
    expect(nextCalendarVersion(new Date(2026, 7, 8, 22, 57, 26), '26.808.225725')).toBe('26.808.225726');
    expect(nextCalendarVersion(new Date(2026, 6, 31, 23, 59, 59), '26.731.235959')).toBe('26.801.0');
  });

  it('writes only the injected package version and leaves the root package out of scope', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bctl-version-'));
    const packagePath = path.join(tempDir, 'package.json');
    fs.writeFileSync(packagePath, '{\n  "name": "fixture",\n  "version": "26.808.225725",\n  "private": true\n}\n', 'utf8');
    const version = writeCalendarVersion(packagePath, new Date(2026, 7, 8, 22, 57, 25));
    expect(version).toBe('26.808.225726');
    expect(JSON.parse(fs.readFileSync(packagePath, 'utf8')).version).toBe(version);
  });
});
