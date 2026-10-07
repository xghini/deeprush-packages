import {describe, it, expect} from 'vitest';
import fc from 'fast-check';
import {xpath} from '../src/utils.ts';
import {isAbsolute} from 'path';

describe('xpath', () => {
  // ========== 单元测试：具体场景 ==========

  it('returns cwd when called with no arguments', () => {
    const result = xpath();
    expect(isAbsolute(result)).toBe(true);
    expect(result).toBe(xpath('.'));
  });

  it('handles relative path with default base', () => {
    const result = xpath('src/index.ts');
    expect(isAbsolute(result)).toBe(true);
    expect(result).toContain('src');
    expect(result).toContain('index.ts');
  });

  it('handles absolute path (ignores basePath)', () => {
    const absPath = process.platform === 'win32' ? 'C:/Users/test' : '/home/test';
    const result = xpath(absPath, '/some/other/path');
    expect(result).toContain('test');
  });

  it('handles file:/// protocol', () => {
    const fileUrl = process.platform === 'win32' ? 'file:///C:/Users/test/file.ts' : 'file:///home/test/file.ts';
    const result = xpath(fileUrl);
    expect(result).not.toContain('file:///');
    expect(result).toContain('test');
  });

  it('resolves ../ correctly', () => {
    const result = xpath('../sibling/file.ts', '/home/project/src');
    expect(result).toContain('sibling');
    expect(result).not.toContain('..');
  });

  it('normalizes ./ correctly', () => {
    const result = xpath('./config/app.json', '/home/project');
    expect(result).toContain('config');
    expect(result).not.toContain('./');
  });

  it('uses specified separator', () => {
    const result = xpath('src/lib/utils.ts', process.cwd(), '/');
    expect(result).not.toContain('\\');
  });

  // ========== 属性测试：通用规则 ==========

  // 核心规则1：输出永远是绝对路径
  it('always returns absolute path', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-zA-Z0-9_./-]{1,50}$/), // 合法路径字符
        relativePath => {
          const result = xpath(relativePath);
          return isAbsolute(result);
        }
      )
    );
  });

  // 核心规则2：输出不包含 ../ 或 ./
  it('output never contains ../ or ./', () => {
    fc.assert(
      fc.property(fc.constantFrom('src/file.ts', '../parent/file.ts', './current/file.ts', 'a/b/../c/file.ts', './a/./b/file.ts'), path => {
        const result = xpath(path);
        return !result.includes('../') && !result.includes('./');
      })
    );
  });

  // 核心规则3：file:/// 协议被正确移除
  it('strips file:/// protocol', () => {
    fc.assert(
      fc.property(fc.constantFrom('file:///home/user/file.ts', 'file:///C:/Users/file.ts', '/normal/path.ts', 'relative/path.ts'), path => {
        const result = xpath(path);
        return !result.includes('file:///');
      })
    );
  });

  // 核心规则4：分隔符统一
  it('uses consistent separator', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z0-9_.-]{1,20}$/), filename => {
        const result = xpath(`src/${filename}`, process.cwd(), '/');
        // 如果指定 / 分隔符，结果中不应该有反斜杠（除了 Windows 盘符后的情况）
        const withoutDrive = result.replace(/^[A-Z]:/, '');
        return !withoutDrive.includes('\\');
      })
    );
  });
});
