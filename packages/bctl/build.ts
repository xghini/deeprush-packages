import fs from 'fs';
import ts from 'typescript';
import esbuild from 'esbuild';
import path from 'path';

const distDir = path.resolve(import.meta.dirname, 'dist');
// 路径一律以包目录为基准，避免从 workspace 根调用时 cwd 漂移导致 readdirSync ENOENT。
const srcDir = path.resolve(import.meta.dirname, 'src');

/** 递归获取目录下所有 .ts 文件（排除 .d.ts 和符号链接） */
const getFiles = (dir: string): string[] => {
  const entries = fs.readdirSync(dir, {withFileTypes: true});
  return entries.flatMap(e => {
    if (e.isSymbolicLink()) return [];
    if (e.isDirectory()) return getFiles(path.join(dir, e.name));
    if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) return [path.join(dir, e.name)];
    return [];
  });
};

/** 使用 TypeScript API 生成 .d.ts */
const emitDeclarations = () => {
  const files = getFiles(srcDir);
  const program = ts.createProgram(files, {
    declaration: true,
    // 只发布 dist（不含 src），declarationMap 会指向包内不存在的 ../src/*.ts，故关闭。
    declarationMap: false,
    emitDeclarationOnly: true,
    declarationDir: distDir,
    rootDir: srcDir,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
  });
  const result = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(result.diagnostics);
  if (diagnostics.length) {
    diagnostics.forEach(d => {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
      if (d.file && d.start !== undefined) {
        const {line, character} = d.file.getLineAndCharacterOfPosition(d.start);
        console.error(`${d.file.fileName}:${line + 1}:${character + 1} - ${msg}`);
      } else {
        console.error(msg);
      }
    });
    throw new Error('TypeScript compilation failed');
  }
};

try {
  console.log('🚀 Starting Build...');
  // 1. 清理目录
  fs.rmSync(distDir, {recursive: true, force: true});
  // 2. 使用 esbuild 构建 JS：逐文件产出，dist 结构镜像 src，
  //    使分层对消费方（及读 node_modules 的工具）保持可见，并支持按子路径引入。
  await esbuild.build({
    entryPoints: getFiles(srcDir),
    bundle: false,
    outdir: distDir,
    outbase: srcDir,
    format: 'esm',
    platform: 'node',
    target: 'esnext',
    sourcemap: true,
    packages: 'external',
  });
  // 3. 生成类型声明 (.d.ts)
  console.log('📝 Generating types...');
  emitDeclarations();
  console.log('✅ Build Success.');
} catch (e) {
  console.error(`\n❌ Build Failed: ${(e as Error).message}`);
  process.exit(1);
}
