// src/utils.ts
import {normalize, join, isAbsolute, sep, dirname} from 'path';

export {xpath, exefile, exedir};

/** 执行文件路径，支持 pm2 等工具通过环境变量覆盖 */
const exefile = process.env.KIT_EXEPATH || process.env.KIT_EXEFILE || process.argv[1] || '';

/** 执行文件所在目录 */
const exedir = dirname(exefile);

/**
 * 强大可靠的路径处理
 * - 相对路径在后，绝对路径在前，最终都转换为绝对路径
 * - 统一分隔符，方便比较路径
 * - 自动处理 file:/// 协议、../裁切等
 * @param targetPath - 目标路径（可以是相对路径或绝对路径）
 * @param basePath - 基准路径，默认为 process.cwd()
 * @param separator - 路径分隔符，默认为 '/'
 */
function xpath(targetPath: string = '.', basePath: string = exedir, separator: '/' | '\\' = '/'): string {
  // 处理 file:/// 协议
  const stripFileProtocol = (p: string): string => {
    if (p.startsWith('file:///')) {
      // Windows: file:///C:/path → C:/path (去掉8个字符)
      // Unix: file:///path → /path (去掉7个字符)
      return process.platform === 'win32' ? p.slice(8) : p.slice(7);
    }
    return p;
  };

  // 处理 basePath
  let resolvedBase = stripFileProtocol(basePath);
  if (!isAbsolute(resolvedBase)) {
    resolvedBase = join(process.cwd(), resolvedBase);
  }

  // 处理 targetPath
  let result: string;
  const cleanTarget = stripFileProtocol(targetPath);

  if (isAbsolute(cleanTarget)) {
    result = normalize(cleanTarget);
  } else {
    result = normalize(join(resolvedBase, cleanTarget));
  }

  // 统一分隔符
  if (separator === '/' && sep === '\\') {
    return result.split(sep).join('/');
  }
  if (separator === '\\' && sep === '/') {
    return result.split(sep).join('\\');
  }
  return result;
}
