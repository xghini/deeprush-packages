import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export interface CalendarParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** DeepRush calendar version: YY.MDD.(hour*10000 + minute*100 + second). */
export function formatCalendarVersion(now: Date): string {
  if (Number.isNaN(now.getTime())) throw new Error('Invalid calendar clock');
  const year = now.getFullYear() % 100;
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const time = now.getHours() * 10000 + now.getMinutes() * 100 + now.getSeconds();
  return `${year}.${month * 100 + day}.${time}`;
}

function parseCalendarVersion(version: string): CalendarParts | undefined {
  const match = /^(\d{1,2})\.(\d{3,4})\.(\d{1,6})$/.exec(version.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const monthDay = Number(match[2]);
  const clock = String(Number(match[3])).padStart(6, '0');
  const month = Math.floor(monthDay / 100);
  const day = monthDay % 100;
  const hour = Number(clock.slice(0, 2));
  const minute = Number(clock.slice(2, 4));
  const second = Number(clock.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;
  return {year, month, day, hour, minute, second};
}

function compareParts(left: CalendarParts, right: CalendarParts): number {
  const a = [left.year, left.month, left.day, left.hour, left.minute, left.second];
  const b = [right.year, right.month, right.day, right.hour, right.minute, right.second];
  for (let index = 0; index < a.length; index++) {
    const leftValue = a[index]!;
    const rightValue = b[index]!;
    if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
  }
  return 0;
}

function bumpParts(parts: CalendarParts): CalendarParts {
  const date = new Date(2000 + parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second + 1);
  return {
    year: date.getFullYear() % 100,
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
  };
}

function formatParts(parts: CalendarParts): string {
  return `${parts.year}.${parts.month * 100 + parts.day}.${parts.hour * 10000 + parts.minute * 100 + parts.second}`;
}

/** Return a strictly newer calendar version when a previous package version is valid. */
export function nextCalendarVersion(now: Date, previousVersion?: string): string {
  const candidate = formatCalendarVersion(now);
  const previous = previousVersion ? parseCalendarVersion(previousVersion) : undefined;
  if (!previous) return candidate;
  const current = parseCalendarVersion(candidate);
  if (current && compareParts(current, previous) > 0) return candidate;
  return formatParts(bumpParts(previous));
}

export function packageJsonPath(scriptUrl = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(scriptUrl)), '..', 'package.json');
}

export function writeCalendarVersion(packagePath = packageJsonPath(), now = new Date()): string {
  const source = fs.readFileSync(packagePath, 'utf8');
  const packageJson = JSON.parse(source) as {version?: string; [key: string]: unknown};
  if (typeof packageJson.version !== 'string') throw new Error(`version field not found in ${packagePath}`);
  const version = nextCalendarVersion(now, packageJson.version);
  if (version !== packageJson.version) {
    packageJson.version = version;
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  }
  return version;
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  return Boolean(invoked && path.resolve(invoked) === path.resolve(fileURLToPath(import.meta.url)));
}

if (isMainModule()) {
  const packagePath = packageJsonPath();
  const version = writeCalendarVersion(packagePath);
  console.log(`Calendar version: ${version}`);
}
