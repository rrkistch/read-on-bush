import * as assert from 'assert';
import { ReadingSession } from '../../application/ReadingSession';
import type { ApplicationContext } from '../../application/ApplicationContext';
import type { BookData } from '../../domain/books';
import type { BookReaderController } from '../../formats/BookFormat';

suite('ReadingSession asynchronous ownership', () => {
  test('a newer open owns cleanup and is not erased by the old completion', async () => {
    const book = (id: string): BookData => ({ id, name: id, process: 0, url: '/' + id + '.txt' });
    let resolveOld!: (value: boolean) => void;
    let oldCloses = 0;
    const marked: string[] = [];
    const readers = new Map<string, BookReaderController>();
    const app = {
      context: { subscriptions: [] }, bookList: { flushProgressWrite: async () => {}, markLastOpened: (id: string) => marked.push(id) },
      searchService: { clear: () => {}, prewarm: async () => {} },
      privacyDisplay: {}, notifier: { error: () => {} }, showIdleReaderHint: () => {},
      formatRegistry: { getProviderForBook: () => ({
        createReader: ({ book: current }: { book: BookData }) => {
          const reader: BookReaderController = {
            book: current, format: 'txt',
            open: () => current.id === 'a' ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve(true),
            close: async () => { if (current.id === 'a') { oldCloses++; } },
            next: async () => {}, previous: async () => {}
          };
          readers.set(current.id, reader);
          return reader;
        }
      }) }
    } as unknown as ApplicationContext;
    const session = new ReadingSession(app);
    const first = session.open(book('a'));
    await new Promise((resolve) => setImmediate(resolve));
    await session.open(book('b'));
    resolveOld(true);
    await first;
    assert.strictEqual(session.current, readers.get('b'));
    assert.deepStrictEqual(marked, ['b']);
    assert.strictEqual(oldCloses, 1);
    await session.closeCurrent();
  });
});
