import * as assert from 'assert';
import { TxtBook } from '../../domain/books/TxtBook';
import { getTxtScreen, nextTxtPosition, previousTxtPosition } from '../../domain/books/TxtPagination';
import type { BookData, ReadingDisplayState } from '../../domain/books';

suite('TXT viewport pagination', () => {
  test('a long segment is fully read in one-line viewports without dropping its tail', () => {
    const text = '甲乙丙丁戊己庚辛壬癸AB😀CDEFG';
    const book: BookData = { id: 'a', name: 'test', process: 0, url: '/test.txt' };
    let state!: ReadingDisplayState;
    const reader = new TxtBook(book, [text, '后续正文'], {
      display: {
        getNextProcessStep: () => 1, getPrevProcessStep: () => 1,
        getNextPosition: (s) => nextTxtPosition(s, 6, 1),
        getPreviousPosition: (s) => previousTxtPosition(s, 6, 1),
        render: (s) => { state = s; }, pause: () => {}
      },
      progress: { updateBookProcess: () => {} },
      notifier: { info: () => {}, warn: () => {}, error: () => {} }
    });
    reader.start();
    const visible: string[] = [];
    do { visible.push(...getTxtScreen(state, 6, 1)); } while (reader.nextLine(false));
    assert.strictEqual(visible.join(''), text + '后续正文');
    reader.prevLine();
    assert.ok(state.charOffset !== undefined);
  });

  test('partial TXT positions survive reopening and old integer bookmarks remain valid', () => {
    const data: BookData = { id: 'a', name: 'test', process: 0, txtCharOffset: 4, url: '/test.txt' };
    const dependencies = {
      display: { getNextProcessStep: () => 1, getPrevProcessStep: () => 1, render: () => {}, pause: () => {} },
      progress: { updateBookProcess: () => {} },
      notifier: { info: () => {}, warn: () => {}, error: () => {} }
    };
    const book = new TxtBook(data, ['0123456789', 'abcdef'], dependencies);
    assert.strictEqual(book.getDisplayState().content, '456789');
    book.jumpLine(1);
    assert.strictEqual(book.getDisplayState().charOffset, 0);
    assert.strictEqual(data.txtCharOffset, undefined);
    const legacy = new TxtBook({ ...data, process: 1 }, ['0123456789', 'abcdef'], dependencies);
    assert.strictEqual(legacy.getDisplayState().content, 'abcdef');
  });
});
