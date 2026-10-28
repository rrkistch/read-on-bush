import { createHash } from 'crypto';
import { Parser } from 'htmlparser2';
import { WeReadError, record } from './WeReadError';

type Fields = Record<string, string | number | boolean>;
const md5 = (value: string) => createHash('md5').update(value).digest('hex');

// Protocol algorithms, not file-integrity checks. Research sources: THIRD_PARTY_NOTICES.md.
export function encodeWeReadId(value: string | number): string {
  const text = String(value);
  const digest = md5(text);
  const numeric = /^\d+$/.test(text);
  const chunks = numeric
    ? text.match(/.{1,9}/g)!.map((chunk) => Number(chunk).toString(16))
    : [Array.from({ length: text.length }, (_, i) => text.charCodeAt(i).toString(16)).join('')];
  let encoded = digest.slice(0, 3) + (numeric ? '3' : '4') + '2' + digest.slice(-2);
  encoded += chunks.map((chunk) => chunk.length.toString(16).padStart(2, '0') + chunk).join('g');
  if (encoded.length < 20) { encoded += digest.slice(0, 20 - encoded.length); }
  return encoded + md5(encoded).slice(0, 3);
}

export function signWeRead(fields: Fields): string {
  const query = Object.keys(fields).sort()
    .map((key) => key + '=' + encodeURIComponent(String(fields[key]))).join('&');
  let odd = 0x15051505;
  let even = odd;
  for (let i = query.length - 1; i > 0; i -= 2) {
    odd = (odd ^ (query.charCodeAt(i) << ((query.length - i) % 30))) & 0x7fffffff;
    even = (even ^ (query.charCodeAt(i - 1) << (i % 30))) & 0x7fffffff;
  }
  return (odd + even).toString(16);
}

export function webAppId(userAgent: string): string {
  let hash = 0;
  for (let i = 0; i < userAgent.length; i++) {
    hash = (hash * 131 + userAgent.charCodeAt(i)) & 0x7fffffff;
  }
  return 'wb' + userAgent.split(' ').slice(0, 12).map((part) => part.length % 10).join('') + 'h' + hash;
}

export function shardBody(shard: string): string {
  if (!/^[0-9a-f]{32}/i.test(shard) || md5(shard.slice(32)).toUpperCase() !== shard.slice(0, 32).toUpperCase()) {
    throw new WeReadError('response', '章节响应无效或阅读权限不足，请在微信读书官网确认');
  }
  return shard.slice(32);
}

export function decodeWeReadContent(shards: readonly string[]): string {
  const encoded = shards.map(shardBody).join('').slice(1);
  const chars = encoded.split('');
  const length = chars.length;
  const swaps: number[] = [];
  if (length >= 4 && length < 11) {
    swaps.push(0, 2);
  } else if (length >= 11) {
    const tailLength = Math.min(4, Math.ceil(length / 10));
    let digits = '';
    for (let i = length - 1; i >= length - tailLength; i--) {
      digits += parseInt(encoded.charCodeAt(i).toString(2), 4);
    }
    const range = length - tailLength - 2;
    const width = String(range).length;
    for (let i = 0; swaps.length < 10 && i + width < digits.length; i += width) {
      swaps.push(Number(digits.slice(i, i + width)) % range);
      swaps.push(Number(digits.slice(i + 1, i + width + 1)) % range);
    }
  }
  for (let i = swaps.length - 2; i >= 0; i -= 2) {
    for (let j = 1; j >= 0; j--) {
      const a = swaps[i] + j;
      const b = swaps[i + 1] + j;
      [chars[a], chars[b]] = [chars[b], chars[a]];
    }
  }
  const base64 = chars.join('').replace(/-/g, '+').replace(/_/g, '/');
  if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) {
    throw new WeReadError('response', '章节解码失败，请在官网确认该书可读');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(base64, 'base64'));
  } catch {
    throw new WeReadError('response', '章节文本编码不受支持');
  }
}

export function chapterText(content: string, format: string): string {
  if (format === 'txt') {
    const text = content.replace(/\r\n?/g, '\n').trim();
    if (!text) { throw new WeReadError('unsupported', '当前章节没有可显示的文字'); }
    return text;
  }
  const parts: string[] = [];
  let suppressed = 0;
  const hidden = new Set(['script', 'style', 'noscript', 'svg', 'head']);
  const blocks = new Set(['p', 'div', 'section', 'h1', 'h2', 'h3', 'h4', 'li', 'blockquote', 'tr']);
  const parser = new Parser({
    onopentag(name) {
      if (hidden.has(name)) { suppressed++; }
      if (suppressed) { return; }
      if (name === 'br' || blocks.has(name)) { parts.push('\n'); }
      if (name === 'img' || name === 'image') { parts.push('\n[图片]\n'); }
    },
    ontext(text) { if (!suppressed) { parts.push(text); } },
    onclosetag(name) {
      if (hidden.has(name)) { suppressed = Math.max(0, suppressed - 1); }
      if (!suppressed && blocks.has(name)) { parts.push('\n'); }
    }
  }, { decodeEntities: true });
  parser.end(content);
  const text = parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  if (!text) {
    throw new WeReadError('unsupported', '当前章节没有可显示的文字，请在官网查看图片或原始排版');
  }
  return text;
}

export type ReaderContext = { ps: string; pc?: string; token?: string; format?: string };

/** Parse JSON SSR state only; never evaluate scripts from a remote page. */
export function readerContext(html: string): ReaderContext {
  const marker = /(?:window\.)?__INITIAL_STATE__\s*=\s*/g.exec(html);
  const start = marker ? html.indexOf('{', marker.index + marker[0].length) : -1;
  if (start < 0) { throw new WeReadError('response', '微信读书阅读会话不可用，请重新登录'); }
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      if (escaped) { escaped = false; }
      else if (char === '\\') { escaped = true; }
      else if (char === '"') { quoted = false; }
    } else if (char === '"') {
      quoted = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}' && --depth === 0) {
      try {
        const reader = record(record(JSON.parse(html.slice(start, i + 1))).reader);
        const bookInfo = record(reader.bookInfo);
        if (typeof reader.psvts === 'string' && reader.psvts) {
          return {
            ps: reader.psvts,
            pc: typeof reader.pclts === 'string' ? reader.pclts : undefined,
            token: typeof reader.token === 'string' ? reader.token : undefined,
            ...(typeof bookInfo.format === 'string' ? { format: bookInfo.format } : {})
          };
        }
      } catch { /* Invalid JSON is a protocol error, never executable code. */ }
      break;
    }
  }
  throw new WeReadError('response', '微信读书阅读会话格式已变化，请更新扩展或在官网阅读');
}
