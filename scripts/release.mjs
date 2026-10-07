// Release one package: node scripts/release.mjs <package> (e.g. bctl).
// Bumps packages/<package>/package.json to the DeepRush calendar version (YY.MDD.HHMMSS, local time, always
// above the current one), runs the package's local checks (`check`, else `test`), commits, tags
// `<package>@<version>` and pushes. The tag starts .github/workflows/publish.yml, which publishes to npm.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const name = process.argv[2];
const dir = path.join(root, 'packages', name || '');
if (!name || !existsSync(path.join(dir, 'package.json'))) {
  console.error('usage: npm run release -- <package>   (a folder under packages/)');
  process.exit(1);
}
// npm is npm.cmd on Windows and needs a shell; git gets no shell so arguments with spaces stay whole.
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: cmd === 'npm' && process.platform === 'win32' });
const read = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim();

if (read('git', ['status', '--porcelain'])) {
  console.error('working tree is not clean; commit or stash first');
  process.exit(1);
}

const calendar = (now) => `${now.getFullYear() % 100}.${(now.getMonth() + 1) * 100 + now.getDate()}.${now.getHours() * 10000 + now.getMinutes() * 100 + now.getSeconds()}`;
const newer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
const file = path.join(dir, 'package.json');
const raw = readFileSync(file, 'utf8');
const pkg = JSON.parse(raw);
let version = calendar(new Date());
if (!newer(version, pkg.version)) {
  const [a, b, c] = pkg.version.split('.').map(Number);
  version = `${a}.${b}.${c + 1}`;
}
writeFileSync(file, raw.replace(`"version": "${pkg.version}"`, `"version": "${version}"`));
console.log(`${pkg.name}: ${pkg.version} -> ${version}`);

try {
  run('npm', ['run', pkg.scripts?.check ? 'check' : 'test'], dir);
} catch (error) {
  writeFileSync(file, raw);
  console.error('checks failed; version restored');
  process.exit(1);
}

const tag = `${name}@${version}`;
run('git', ['add', path.relative(root, file)]);
run('git', ['commit', '-m', `release: ${tag}`]);
run('git', ['tag', tag]);
run('git', ['push', 'origin', 'HEAD', tag]);
console.log(`pushed ${tag}; GitHub Actions publishes it: https://github.com/${read('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])}/actions`);
