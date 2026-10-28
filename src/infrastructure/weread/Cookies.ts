import { WeReadError } from './WeReadError';

export function parseCookies(cookie: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const item of cookie.split(';')) {
    const separator = item.indexOf('=');
    if (separator > 0) {
      values.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
    }
  }
  return values;
}

export function mergeCookies(cookie: string, headers: readonly string[]): string {
  const values = parseCookies(cookie);
  for (const header of headers) {
    for (const [key, value] of parseCookies(header.split(';', 1)[0])) {
      values.set(key, value);
    }
  }
  return [...values].map(([key, value]) => key + '=' + value).join('; ');
}

export function validateCookie(cookie: string): string {
  const trimmed = cookie.trim().replace(/^cookie:\s*/i, '');
  if (/[\r\n\x00]/.test(trimmed) || trimmed.length > 32768) {
    throw new WeReadError('auth', 'Cookie 格式无效，请只粘贴请求头中的 Cookie 内容');
  }
  const values = parseCookies(trimmed);
  if (!/^\d+$/.test(values.get('wr_vid') ?? '') || !values.get('wr_skey')) {
    throw new WeReadError('auth', 'Cookie 必须包含 wr_vid 和 wr_skey');
  }
  return trimmed;
}

export function cookieAccount(cookie: string): string {
  return parseCookies(validateCookie(cookie)).get('wr_vid')!;
}
