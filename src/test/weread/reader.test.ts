import * as assert from 'assert';
import { EventEmitter } from 'vscode';
import { WeReadReader } from '../../formats/weread/WeReadReader';
import { ChapterCache, type LoadedWeReadChapter } from '../../infrastructure/weread/ChapterCache';
import { WeReadError } from '../../infrastructure/weread/WeReadError';
import { PrivacyService } from '../../application/PrivacyService';
import { CamouflageTemplateService } from '../../presentation/reader/rendering';
import type { WeReadService } from '../../application/WeReadService';
import type { ReaderServices } from '../../formats/BookFormat';
import type { BookData } from '../../domain/books';
import type { ReaderSurface, ReaderSurfaceFrame } from '../../presentation/readerSurfaces/ReaderSurface';
import type { WeReadChapter } from '../../domain/books/WeRead';
import type { ReaderContext } from '../../infrastructure/weread/Protocol';

suite('WeReadReader lifecycle', () => {
  const readers: WeReadReader[] = [];
  teardown(async () => { for (const reader of readers.splice(0)) { await reader.close(); } });

  function fixture(options: {
    load?: (uid: number) => Promise<LoadedWeReadChapter>; sync?: boolean;
    chapters?: () => Promise<WeReadChapter[]>;
    context?: () => Promise<ReaderContext>;
    progress?: () => Promise<number | undefined>;
  } = {}) {
    const frames: ReaderSurfaceFrame[] = [];
    const stored: number[] = [];
    const sent: number[] = [];
    const errors: string[] = [];
    const resize = new EventEmitter<{ columns: number; rows: number }>();
    let input: ((value: string) => void) | undefined;
    const surface: ReaderSurface = {
      onDidResize: resize.event,
      publishFrame: (frame) => { frames.push(frame); },
      publishIdle: () => {}, publishHint: () => {}, clear: () => {},
      setInputHandler: (handler) => { input = handler; }, focus: () => {}, dispose: () => resize.dispose()
    };
    const privacy = new PrivacyService();
    privacy.setMode('normal');
    const services: ReaderServices = {
      readerSurface: surface, templateService: new CamouflageTemplateService(), privacyDisplay: privacy,
      notifier: { info: () => {}, warn: (message) => errors.push(message), error: (message) => errors.push(message) },
      bookCatalog: {
        syncChapters: () => undefined, flushProgressWrite: async () => {},
        updateBookProcess: () => {}, updateEpubProgress: () => {}, updatePdfProgress: () => {}
      },
      txtDisplay: { getNextProcessStep: () => 1, getPrevProcessStep: () => 1, render: () => {}, pause: () => {} }
    };
    const book: BookData = {
      id: 'weread:123:9', name: 'Test', process: 0, format: 'weread', url: 'weread://123/9',
      source: { kind: 'weread', accountId: '123', bookId: '9', onShelf: true }
    };
    const version = { version: 1 };
    const host = {
      session: version, isActive: () => version.version === 1, syncEnabled: options.sync ?? false,
      cache: new ChapterCache(),
      chapters: options.chapters ?? (async () => [{ uid: 9, title: '第一章', index: 1 }, { uid: 70, title: '第二章', index: 2 }]),
      api: {
        context: options.context ?? (async () => ({ ps: 'test' })),
        progress: options.progress ?? (async () => 9),
        chapter: async (_: string, uid: number) => options.load
          ? options.load(uid) : { text: uid === 9 ? '甲乙' : '丙丁', format: 'txt' },
        report: async (_: string, uid: number) => { sent.push(uid); }
      },
      saveProgress: (current: BookData, progress: NonNullable<BookData['wereadProgress']>) => {
        current.wereadProgress = progress; stored.push(progress.chapterUid);
      },
      flushProgress: async () => {}, stopReading: async () => {}
    } as unknown as WeReadService;
    const reader = new WeReadReader(book, services, host);
    readers.push(reader);
    return { reader, frames, stored, sent, errors, version, book, input: (key: string) => input?.(key) };
  }

  test('starts independent catalog, reader session and cloud progress requests together', async () => {
    const started: string[] = [];
    let catalogReady!: (chapters: WeReadChapter[]) => void;
    let contextReady!: (context: ReaderContext) => void;
    let progressReady!: (uid: number) => void;
    const f = fixture({
      chapters: () => { started.push('catalog'); return new Promise((resolve) => { catalogReady = resolve; }); },
      context: () => { started.push('context'); return new Promise((resolve) => { contextReady = resolve; }); },
      progress: () => { started.push('progress'); return new Promise((resolve) => { progressReady = resolve; }); }
    });
    const opening = f.reader.open();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(started.sort(), ['catalog', 'context', 'progress']);
    catalogReady([{ uid: 9, title: 'First', index: 1 }]);
    contextReady({ ps: 'test' });
    progressReady(9);
    assert.strictEqual(await opening, true);
  });

  test('a required metadata failure closes cleanly even if cloud progress fails later', async () => {
    let rejectProgress!: (error: unknown) => void;
    const f = fixture({
      context: async () => { throw new WeReadError('timeout', '阅读会话超时'); },
      progress: () => new Promise((_, reject) => { rejectProgress = reject; })
    });
    assert.strictEqual(await f.reader.open(), false);
    rejectProgress(new WeReadError('timeout', '云进度超时'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(f.errors, ['阅读会话超时']);
    assert.strictEqual(f.frames.length, 0);
  });

  test('closing during metadata preparation prevents a late open and any saved position', async () => {
    let contextReady!: (context: ReaderContext) => void;
    const f = fixture({ context: () => new Promise((resolve) => { contextReady = resolve; }) });
    const opening = f.reader.open();
    await new Promise((resolve) => setImmediate(resolve));
    await f.reader.close();
    contextReady({ ps: 'test' });
    assert.strictEqual(await opening, false);
    assert.strictEqual(f.frames.length, 0);
    assert.strictEqual(f.book.wereadProgress, undefined);
  });

  test('reads both directions across non-contiguous chapter UIDs without default uploads', async () => {
    const f = fixture();
    assert.strictEqual(await f.reader.open(), true);
    f.reader.revealContent();
    await f.reader.next();
    assert.strictEqual(f.book.wereadProgress?.chapterUid, 70);
    await f.reader.previous();
    assert.strictEqual(f.book.wereadProgress?.chapterUid, 9);
    await f.reader.close();
    assert.deepStrictEqual(f.sent, []);
    assert.strictEqual(f.errors.length, 0);
  });

  test('enabled sync flushes the latest real chapter on close', async () => {
    const f = fixture({ sync: true });
    await f.reader.open(); f.reader.revealContent();
    await f.reader.next();
    await f.reader.close();
    assert.deepStrictEqual(f.sent, [70]);
    assert.strictEqual(f.book.wereadProgress?.pendingChapterUid, undefined);
  });

  test('failed chapter fetch keeps the old position and readable content', async () => {
    const f = fixture({ load: async (uid) => {
      if (uid === 70) { throw new WeReadError('network', '测试断网'); }
      return { text: '甲乙', format: 'txt' };
    } });
    await f.reader.open(); f.reader.revealContent();
    await f.reader.next();
    assert.strictEqual(f.reader.getCurrentLocation()?.kind, 'section');
    assert.strictEqual(f.book.wereadProgress?.chapterUid, 9);
    assert.ok(f.frames.at(-1)?.screen.includes('甲乙'));
    assert.ok(f.errors.includes('测试断网'));
  });

  test('a chapter arriving after conceal stays concealed', async () => {
    let finish!: (value: LoadedWeReadChapter) => void;
    const f = fixture({ load: async (uid) => uid === 9 ? { text: '甲乙', format: 'txt' }
      : new Promise((resolve) => { finish = resolve; }) });
    await f.reader.open(); f.reader.revealContent();
    const changing = f.reader.next();
    f.input('d');
    finish({ text: '隐藏正文', format: 'txt' });
    await changing;
    assert.strictEqual(f.frames.at(-1)?.mode, 'debugTemplate');
    assert.ok(!f.frames.at(-1)?.screen.includes('隐藏正文'));
  });

  test('a chapter arriving after close cannot render or persist its location', async () => {
    let finish!: (value: LoadedWeReadChapter) => void;
    const f = fixture({ load: async (uid) => uid === 9 ? { text: '甲乙', format: 'txt' }
      : new Promise((resolve) => { finish = resolve; }) });
    await f.reader.open(); f.reader.revealContent();
    const changing = f.reader.next();
    await f.reader.close();
    const frames = f.frames.length;
    finish({ text: '迟到正文', format: 'txt' });
    await changing;
    assert.strictEqual(f.frames.length, frames);
    assert.strictEqual(f.book.wereadProgress?.chapterUid, 9);
  });
});
