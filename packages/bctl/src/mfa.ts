// src/mfa.ts
import {createHmac} from 'crypto';

/**
 * 生成 TOTP 验证码
 * @param secret - Base32 编码的密钥
 * @param offset - 时间步偏移量（默认 0 = 当前窗口，-1 = 上一个窗口）
 * @returns 6 位验证码字符串
 */
export function genMFACode(secret: string, offset: number = 0): string {
  const time = Buffer.alloc(8);
  time.writeBigInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const key = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const buf = Buffer.alloc((key.length * 5) >>> 3);
  const map = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let val = 0,
    bits = 0,
    idx = 0;
  for (const char of key) {
    val = (val << 5) | map.indexOf(char);
    bits += 5;
    if (bits >= 8) buf[idx++] = (val >>> (bits -= 8)) & 0xff;
  }
  const hmac = createHmac('sha1', buf).update(time).digest();
  return ((hmac.readUInt32BE(hmac[19]! & 0x0f) & 0x7fffffff) % 1e6).toString().padStart(6, '0');
}

/**
 * 计算到下一个 MFA 窗口的毫秒数
 * @returns 毫秒数（含 1000ms 缓冲）
 */
export function MFANextTime(): number {
  // 直接算出当前窗口剩余时间，并多给 1000ms 缓冲确保跨过临界点
  return 30000 - (Date.now() % 30000) + 1000;
}
