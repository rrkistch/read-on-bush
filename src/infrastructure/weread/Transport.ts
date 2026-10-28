import { request as httpsRequest } from 'https';
import { cancelled, WeReadError } from './WeReadError';

export const WEREAD_ORIGIN = 'https://weread.qq.com';
export const WEREAD_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export type WeReadRequest = {
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  cookie?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};
export type WeReadResponse = { text: string; cookies: string[] };
export type WeReadTransport = (input: WeReadRequest) => Promise<WeReadResponse>;

export function requestLabel(path: string): string {
  path = path.split('?', 1)[0];
  if (path.startsWith('/web/book/chapterInfos')) { return '目录'; }
  if (path.startsWith('/web/book/chapter/')) {
    const part = path.split('/').at(-1) ?? '';
    return /^(e_[0-3]|t_[01])$/.test(part) ? '正文分片 ' + part : '正文';
  }
  if (path.startsWith('/web/reader/')) { return '阅读会话'; }
  if (path.startsWith('/web/book/getProgress')) { return '云进度'; }
  if (path.startsWith('/web/book/info')) { return '书籍信息'; }
  if (path.startsWith('/web/shelf/')) { return '书架'; }
  if (path.startsWith('/web/login/renewal')) { return '登录续期'; }
  if (path.startsWith('/web/book/read')) { return '进度回传'; }
  return '登录';
}

/** Deliberately no redirects: session cookies must never follow an arbitrary Location. */
export function createWeReadTransport(log: (line: string) => void = () => {}): WeReadTransport {
  return (input) => new Promise((resolve, reject) => {
    const url = new URL(input.path, WEREAD_ORIGIN);
    if (url.origin !== WEREAD_ORIGIN || !input.path.startsWith('/')) {
      reject(new WeReadError('response', '微信读书请求地址无效'));
      return;
    }
    if (input.signal?.aborted) {
      reject(cancelled());
      return;
    }
    const started = Date.now();
    const label = requestLabel(input.path);
    const method = input.method ?? (input.body === undefined ? 'GET' : 'POST');
    let phase = '连接';
    let finished = false;
    const finish = (result: string) => {
      if (!finished) {
        finished = true;
        // No URL parameters, book IDs, bodies, cookies or response content in diagnostics.
        try {
          log(label + ' ' + method + ' ' + result + ' ' + (Date.now() - started) + 'ms，阶段=' + phase);
        } catch { /* A closed output channel must not change a request's result. */ }
      }
    };
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    const req = httpsRequest(url, {
      method,
      headers: {
        'User-Agent': WEREAD_USER_AGENT,
        Referer: WEREAD_ORIGIN + '/web/',
        Origin: WEREAD_ORIGIN,
        Accept: '*/*',
        ...(input.cookie ? { Cookie: input.cookie } : {}),
        ...(body ? {
          'Content-Type': 'application/json;charset=UTF-8',
          'Content-Length': Buffer.byteLength(body)
        } : {})
      }
    }, (res) => {
      phase = '响应正文';
      const status = res.statusCode ?? 0;
      if (status !== 200) {
        finish('HTTP ' + status);
        res.resume();
        reject(new WeReadError(
          status === 401 ? 'auth' : status === 429 ? 'rate' : status === 403 ? 'permission' : 'network',
          status === 401 ? '微信读书登录已过期，请重新登录'
            : status === 429 ? '微信读书请求过于频繁，请稍后重试'
            : status === 403 ? '微信读书拒绝访问，请在官网确认账号权限'
            : '微信读书服务暂不可用，请稍后重试'
        ));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 10 * 1024 * 1024) {
          req.destroy(new WeReadError('response', '微信读书响应超过大小限制'));
        } else {
          chunks.push(chunk);
        }
      });
      res.on('end', () => {
        finish('成功');
        resolve({ text: Buffer.concat(chunks).toString('utf8'), cookies: res.headers['set-cookie'] ?? [] });
      });
      res.on('error', () => {
        finish('响应中断');
        reject(new WeReadError('network', '微信读书' + label + '响应中断，请重试'));
      });
    });
    req.on('socket', (socket) => {
      phase = req.reusedSocket ? '复用连接，等待响应头' : 'DNS/TCP';
      if (!req.reusedSocket) {
        socket.once('connect', () => { phase = 'TLS'; });
        socket.once('secureConnect', () => { phase = '等待响应头'; });
      }
    });
    const abort = () => req.destroy(cancelled());
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) { abort(); }
    const timer = setTimeout(() => req.destroy(new WeReadError('timeout', '微信读书' + label + '请求超时，请重试')), input.timeoutMs ?? 20000);
    req.on('close', () => {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
    });
    req.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(error instanceof WeReadError ? error.kind :
        '网络错误' + (code && /^[A-Z0-9_]+$/.test(code) ? '[' + code + ']' : ''));
      reject(error instanceof WeReadError
        ? error : new WeReadError('network', '无法连接微信读书，请检查网络后重试'));
    });
    req.end(body);
  });
}

export const requestWeRead = createWeReadTransport();
