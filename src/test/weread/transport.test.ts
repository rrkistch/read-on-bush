import * as assert from 'assert';
import { createWeReadTransport, requestLabel } from '../../infrastructure/weread/Transport';
import { WeReadError } from '../../infrastructure/weread/WeReadError';

suite('WeRead transport diagnostics', () => {
  test('labels endpoints without exposing account, book, query or token values', () => {
    assert.strictEqual(requestLabel('/web/book/chapterInfos?bookId=private'), '目录');
    assert.strictEqual(requestLabel('/web/reader/private-book-hash?token=secret'), '阅读会话');
    assert.strictEqual(requestLabel('/web/book/chapter/e_0?token=secret'), '正文分片 e_0');
    assert.strictEqual(requestLabel('/web/book/chapter/private-book-id'), '正文');
    assert.strictEqual(requestLabel('/web/book/getProgress?bookId=private'), '云进度');
  });

  test('rejects a cross-origin request before sending credentials', async () => {
    const transport = createWeReadTransport();
    await assert.rejects(transport({ path: 'https://example.com/', cookie: 'private' }),
      (error: unknown) => error instanceof WeReadError && error.kind === 'response');
    await assert.rejects(transport({ path: '//example.com/', cookie: 'private' }),
      (error: unknown) => error instanceof WeReadError && error.kind === 'response');
  });

  test('an already-cancelled request does not start a connection', async () => {
    const controller = new AbortController();
    controller.abort();
    const messages: string[] = [];
    const transport = createWeReadTransport((line) => messages.push(line));
    await assert.rejects(transport({ path: '/web/shelf/sync', signal: controller.signal }),
      (error: unknown) => error instanceof WeReadError && error.kind === 'cancelled');
    assert.deepStrictEqual(messages, []);
  });
});
