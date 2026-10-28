import { createHash, randomInt } from 'crypto';
import type { WeReadChapter, WeReadShelfBook } from '../../domain/books/WeRead';
import {
  chapterText, decodeWeReadContent, encodeWeReadId, readerContext, signWeRead,
  webAppId, shardBody, type ReaderContext
} from './Protocol';
import { WEREAD_USER_AGENT, type WeReadRequest } from './Transport';
import { WeReadSession, linkedAbort, parseJson } from './WeReadSession';
import { cancelled, checkApiResponse, record, WeReadError } from './WeReadError';

export function parseShelf(value: unknown): WeReadShelfBook[] {
  const data = record(value);
  if (!Array.isArray(data.books)) { throw new WeReadError('response', '微信书架数据格式已变化'); }
  const books = new Map<string, WeReadShelfBook>();
  for (const item of data.books) {
    const book = record(item);
    if ((typeof book.bookId !== 'string' && typeof book.bookId !== 'number') || typeof book.title !== 'string') {
      throw new WeReadError('response', '微信书架包含无法识别的书籍');
    }
    const bookId = String(book.bookId);
    books.set(bookId, {
      bookId, title: book.title,
      author: typeof book.author === 'string' ? book.author : undefined,
      format: typeof book.format === 'string' ? book.format : undefined
    });
  }
  return [...books.values()];
}

export function parseChapters(value: unknown, bookId: string): WeReadChapter[] {
  const root = record(value);
  const entries = Array.isArray(root.data) ? root.data : [root];
  const entry = entries.map(record).find((item) => String(item.bookId) === bookId);
  if (!entry || !Array.isArray(entry.updated)) {
    throw new WeReadError('response', '微信读书目录数据格式已变化');
  }
  const chapters: WeReadChapter[] = [];
  const seen = new Set<number>();
  for (const item of entry.updated) {
    const chapter = record(item);
    const uid = Number(chapter.chapterUid);
    if (!Number.isSafeInteger(uid) || uid < 0 || typeof chapter.title !== 'string') {
      throw new WeReadError('response', '微信读书目录包含无效章节');
    }
    if (!seen.has(uid)) {
      seen.add(uid);
      chapters.push({ uid, title: chapter.title, index: Number(chapter.chapterIdx ?? chapters.length) });
    }
  }
  chapters.sort((a, b) => a.index - b.index);
  if (!chapters.length) { throw new WeReadError('unsupported', '这本微信书籍暂时没有可读章节'); }
  return chapters;
}

export class WeReadApi {
  // Note: 格式探测及取消策略见 docs/superpowers/specs/2026-10-26-weread-design.md 的“请求链路取舍”。
  constructor(readonly session: Pick<WeReadSession, 'request'>) {}

  async json(input: Omit<WeReadRequest, 'cookie'>): Promise<unknown> {
    const response = await this.session.request(input);
    const data = parseJson(response.text);
    checkApiResponse(data);
    return data;
  }

  async shelf(signal?: AbortSignal): Promise<WeReadShelfBook[]> {
    return parseShelf(await this.json({ path: '/web/shelf/sync', signal }));
  }

  async chapters(bookId: string, signal?: AbortSignal): Promise<WeReadChapter[]> {
    if (bookId.startsWith('MP_')) {
      throw new WeReadError('unsupported', '第一版暂不支持公众号合集，请在官网阅读');
    }
    return parseChapters(await this.json({
      path: '/web/book/chapterInfos', body: { bookIds: [bookId] }, signal
    }), bookId);
  }

  async progress(bookId: string, signal?: AbortSignal): Promise<number | undefined> {
    const value = record(await this.json({
      path: '/web/book/getProgress?bookId=' + encodeURIComponent(bookId), signal
    }));
    const progress = record(value.book ?? value.data ?? value);
    if (progress.chapterUid === undefined) {
      if (!Object.keys(progress).length || progress.succ === 1) { return undefined; }
      throw new WeReadError('response', '微信读书云进度格式已变化');
    }
    const uid = Number(progress.chapterUid);
    if (!Number.isSafeInteger(uid) || uid < 0) { throw new WeReadError('response', '微信读书云进度无效'); }
    return uid;
  }

  async context(bookId: string, signal?: AbortSignal): Promise<ReaderContext> {
    return readerContext((await this.session.request({
      path: '/web/reader/' + encodeWeReadId(bookId), signal
    })).text);
  }

  async chapter(
    bookId: string, uid: number, context: ReaderContext, signal?: AbortSignal
  ): Promise<{ text: string; format: string }> {
    let format = context.format;
    if (format && !['epub', 'txt', 'pdf'].includes(format)) {
      throw new WeReadError('unsupported', '暂不支持这本微信书籍的正文格式，请在官网阅读');
    }
    const group = linkedAbort([signal]);
    try {
      if (encodeWeReadId(Math.floor(Date.now() / 1000)) === context.ps) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            group.controller.signal.removeEventListener('abort', abort);
            reject(cancelled());
          };
          const timer = setTimeout(() => {
            group.controller.signal.removeEventListener('abort', abort); resolve();
          }, 1050);
          if (group.controller.signal.aborted) { abort(); }
          else { group.controller.signal.addEventListener('abort', abort, { once: true }); }
        });
      }
      const ct = Math.floor(Date.now() / 1000);
      const requestPart = async (part: string) => {
        const fields = {
          b: encodeWeReadId(bookId), c: encodeWeReadId(uid), r: randomInt(10000) ** 2,
          st: part === 't_1' ? 1 : 0, ct, ps: context.ps, pc: encodeWeReadId(ct), sc: 1, prevChapter: false
        };
        return (await this.session.request({
          path: '/web/book/chapter/' + part,
          body: { ...fields, s: signWeRead(fields) }, signal: group.controller.signal
        })).text;
      };
      let first: string | undefined;
      if (!format) {
        first = await requestPart('e_0');
        if (/^\s*\{/.test(first)) {
          const metadata = record(parseJson(first));
          if (String(metadata.bookId) !== bookId || Number(metadata.chapterUid) !== uid) {
            throw new WeReadError('response', '微信读书未返回有效的章节格式信息');
          }
          format = 'txt';
        } else {
          shardBody(first);
          format = 'epub';
        }
      }
      // The reader state or the protocol's explicit e_0 metadata determines the format.
      // No per-chapter book/info request is needed on the critical path.
      const shards = format === 'txt'
        ? await Promise.all(['t_0', 't_1'].map(requestPart))
        : await Promise.all([first ?? requestPart('e_0'), requestPart('e_1'), requestPart('e_3')]);
      const text = chapterText(decodeWeReadContent(shards), format);
      context.format = format;
      return { text, format };
    } catch (error) {
      group.controller.abort();
      throw error;
    } finally { group.dispose(); }
  }

  async report(
    bookId: string, uid: number, format: string, context: ReaderContext,
    activeSeconds: number, signal?: AbortSignal, timeoutMs = 5000
  ): Promise<void> {
    const now = Date.now();
    const seconds = Math.floor(now / 1000);
    const fields: Record<string, string | number> = {
      appId: webAppId(WEREAD_USER_AGENT), b: encodeWeReadId(bookId),
      c: encodeWeReadId(uid), ci: uid, co: 0, ct: seconds, dy: 0, fm: format,
      pc: encodeWeReadId(seconds), pr: 0, ps: context.ps, sm: ''
    };
    if (context.token) {
      const nonce = randomInt(1000);
      Object.assign(fields, {
        rt: Math.max(0, Math.min(60, Math.floor(activeSeconds))),
        ts: now, rn: nonce,
        sg: createHash('sha256').update(String(now) + nonce + context.token).digest('hex')
      });
    }
    const response = record(await this.json({
      path: '/web/book/read', body: { ...fields, s: signWeRead(fields) }, signal, timeoutMs
    }));
    if (response.succ !== 1) { throw new WeReadError('response', '微信读书进度回传未成功，可稍后重试'); }
    if (typeof response.readerToken === 'string') { context.token = response.readerToken; }
  }
}
