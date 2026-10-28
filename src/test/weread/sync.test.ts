import * as assert from 'assert';
import { WeReadSyncQueue } from '../../domain/books/WeReadSyncQueue';
import { mergeWeReadShelf, visibleWeReadBooks } from '../../domain/books/WeReadShelf';
import { ChapterCache } from '../../infrastructure/weread/ChapterCache';
import type { BookData } from '../../domain/books';

suite('WeRead chapter sync and isolation', () => {
  test('default disabled mode never sends a progress update', async () => {
    let requests = 0;
    const queue = new WeReadSyncQueue({ send: async () => { requests++; }, pending: () => {}, error: () => {} });
    queue.enqueue(7);
    await queue.flush();
    queue.dispose();
    assert.strictEqual(requests, 0);
  });

  test('coalesces latest chapter and does not send a duplicate chapter', async () => {
    const sent: number[] = [];
    let pending: number | undefined;
    const queue = new WeReadSyncQueue({
      send: async (uid) => { sent.push(uid); }, pending: (uid) => { pending = uid; }, error: () => {}
    }, 1);
    queue.setEnabled(true);
    queue.enqueue(2); queue.enqueue(3); queue.enqueue(4);
    await queue.flush();
    assert.deepStrictEqual(sent, [4]);
    assert.strictEqual(pending, undefined);
    queue.enqueue(4);
    await queue.flush();
    assert.deepStrictEqual(sent, [4]);
    queue.dispose();
  });

  test('retains failed work without a concurrent flush retry loop', async () => {
    let finish!: () => void;
    let pending: number | undefined;
    let sent = 0;
    const queue = new WeReadSyncQueue({
      send: async () => { sent++; await new Promise<void>((resolve) => { finish = resolve; }); throw new Error('offline'); },
      pending: (uid) => { pending = uid; }, error: () => {}
    });
    queue.setEnabled(true); queue.enqueue(70);
    const first = queue.flush();
    const second = queue.flush();
    finish();
    await Promise.all([first, second]);
    assert.strictEqual(pending, 70);
    assert.strictEqual(sent, 1);
    queue.dispose();
  });

  test('disabling cancels an in-flight report and discards unsent work', async () => {
    let signal!: AbortSignal;
    let finish!: () => void;
    let pending: number | undefined;
    const queue = new WeReadSyncQueue({
      send: async (_, current) => { signal = current; await new Promise<void>((resolve) => { finish = resolve; }); },
      pending: (uid) => { pending = uid; }, error: () => assert.fail('cancel is not a failure notification')
    });
    queue.setEnabled(true); queue.enqueue(9);
    const sending = queue.flush();
    queue.setEnabled(false);
    assert.ok(signal.aborted);
    finish(); await sending;
    assert.strictEqual(pending, undefined);
    queue.dispose();
  });

  test('shelf merge preserves local books and per-account progress', () => {
    const local: BookData = { id: 'local', name: 'Local', process: 2, url: '/local.txt' };
    const first = mergeWeReadShelf([local], '1', [{ bookId: '9', title: 'Cloud' }], 100);
    first[1].privacyAlias = 'Notes';
    first[1].wereadProgress = { chapterUid: 70, chapterIndex: 1, charOffset: 33, updatedAt: 100 };
    const other = mergeWeReadShelf(first, '2', [{ bookId: '9', title: 'Other account' }], 200);
    const refreshed = mergeWeReadShelf(other, '1', [{ bookId: '9', title: 'New title' }], 300);
    assert.strictEqual(refreshed.length, 3);
    assert.strictEqual(refreshed[0], local);
    assert.strictEqual(refreshed[1].privacyAlias, 'Notes');
    assert.strictEqual(refreshed[1].wereadProgress?.charOffset, 33);
    assert.deepStrictEqual(visibleWeReadBooks(refreshed, '2').map((book) => book.name), ['Local', 'Other account']);
    assert.deepStrictEqual(visibleWeReadBooks(refreshed).map((book) => book.name), ['Local']);
    const empty = mergeWeReadShelf(refreshed, '1', []);
    assert.deepStrictEqual(visibleWeReadBooks(empty, '1').map((book) => book.name), ['Local']);
    assert.strictEqual(empty[1].wereadProgress?.charOffset, 33);
  });

  test('chapter cache is bounded and invalidates in-flight inserts on clear', async () => {
    const cache = new ChapterCache();
    let calls = 0;
    const load = async () => { calls++; return { text: 'text', format: 'txt' }; };
    for (const id of ['1', '2', '3', '4']) { await cache.load(id, load); }
    await cache.load('4', load);
    assert.strictEqual(calls, 4);
    await cache.load('1', load);
    assert.strictEqual(calls, 5);
    let complete!: (value: { text: string; format: string }) => void;
    const pending = cache.load('slow', () => new Promise((resolve) => { complete = resolve; }));
    cache.clear();
    complete({ text: 'old', format: 'txt' });
    await pending;
    const fresh = await cache.load('slow', load);
    assert.strictEqual(fresh.text, 'text');
  });
});
