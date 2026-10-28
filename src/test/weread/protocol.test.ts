import * as assert from 'assert';
import { createHash } from 'crypto';
import {
  chapterText, decodeWeReadContent, encodeWeReadId, readerContext, signWeRead
} from '../../infrastructure/weread/Protocol';
import { cookieAccount, mergeCookies, validateCookie } from '../../infrastructure/weread/Cookies';
import { parseChapters, parseShelf } from '../../infrastructure/weread/WeReadApi';
import { WeReadChapterBook } from '../../domain/books/WeReadChapterBook';
import { checkApiResponse, WeReadError } from '../../infrastructure/weread/WeReadError';

suite('WeRead protocol and pagination', () => {
  test('encodes known public reader identifiers', () => {
    assert.strictEqual(encodeWeReadId('43208843'), 'c9c321c07293508bc9c79df');
    assert.strictEqual(encodeWeReadId(2), 'c81322c012c81e728d9d180');
    assert.strictEqual(encodeWeReadId(119), '07e323f027707e1cd7dc674');
    assert.strictEqual(signWeRead({ b: 2, a: 'a b' }), signWeRead({ a: 'a b', b: 2 }));
  });
  test('validates and decodes a minimal swapped shard', () => {
    const payload = '#JDQU'; // QUJD -> ABC, protocol's short-input two-pair swap.
    const shard = createHash('md5').update(payload).digest('hex').toUpperCase() + payload;
    assert.strictEqual(decodeWeReadContent([shard]), 'ABC');
    assert.throws(() => decodeWeReadContent([shard.slice(0, -1) + 'A']));
    assert.throws(() => decodeWeReadContent(['{}']));
  });
  test('does not execute SSR code or remote chapter markup', () => {
    assert.deepStrictEqual(readerContext('<script>window.__INITIAL_STATE__={"reader":{"psvts":"session","token":"test"}};</script>'),
      { ps: 'session', token: 'test', pc: undefined });
    assert.throws(() => readerContext('window.__INITIAL_STATE__=alert("no")'));
    assert.strictEqual(readerContext('window.__INITIAL_STATE__={"reader":{"psvts":"x","bookInfo":{"format":"txt"}}}').format, 'txt');
    assert.strictEqual(chapterText('<head><title>hide</title></head><p>甲&amp;乙</p><script>bad()</script><p>正文<img src="bad"></p>', 'epub'),
      '甲&乙\n\n正文\n[图片]');
    assert.strictEqual(chapterText('  <普通文字>\r\n下一行 ', 'txt'), '<普通文字>\n下一行');
  });
  test('recognizes explicit authentication messages even without a numeric error code', () => {
    assert.throws(() => checkApiResponse({ errMsg: '鉴权失败' }),
      (error: unknown) => error instanceof WeReadError && error.kind === 'auth');
    assert.throws(() => checkApiResponse({ errMsg: '微信登录授权已过期' }),
      (error: unknown) => error instanceof WeReadError && error.kind === 'auth');
    assert.doesNotThrow(() => checkApiResponse({ succ: 1 }));
  });
  test('preserves cookie values and rejects header injection', () => {
    assert.strictEqual(mergeCookies('wr_vid=1; wr_skey=a==', ['wr_skey=b==; HttpOnly']), 'wr_vid=1; wr_skey=b==');
    assert.strictEqual(cookieAccount('wr_vid=123; wr_skey=x'), '123');
    assert.throws(() => validateCookie('wr_vid=1; wr_skey=x\r\nAuthorization: bad'));
  });
  test('rejects invalid shelf data rather than clearing the shelf', () => {
    assert.deepStrictEqual(parseShelf({ books: [] }), []);
    assert.throws(() => parseShelf({ error: 'no' }));
    assert.strictEqual(parseShelf({ books: [{ bookId: '1', title: 'A' }, { bookId: '1', title: 'A' }] }).length, 1);
  });
  test('uses real chapter UIDs rather than sequential UI indexes', () => {
    const chapters = parseChapters({ data: [{ bookId: '1', updated: [
      { chapterUid: 70, chapterIdx: 2, title: '后' }, { chapterUid: 9, chapterIdx: 1, title: '前' }
    ] }] }, '1');
    assert.deepStrictEqual(chapters.map((chapter) => chapter.uid), [9, 70]);
  });
  test('keeps a source character anchor across display widths', () => {
    const book = new WeReadChapterBook({ uid: 70, title: '真实章节', index: 2 }, 1, 3, '甲乙丙丁戊己庚辛壬癸');
    assert.strictEqual(book.next(4, 2), true);
    assert.strictEqual(book.charOffset, 4);
    book.getScreen(8, 3);
    assert.strictEqual(book.charOffset, 4);
    assert.strictEqual(book.previous(4, 2), true);
    assert.strictEqual(book.charOffset, 0);
    book.privateMode = true;
    assert.ok(!book.getProgressLabel().includes('真实章节'));
  });
});
