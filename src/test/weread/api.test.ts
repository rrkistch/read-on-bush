import * as assert from 'assert';
import { createHash } from 'crypto';
import { WeReadApi } from '../../infrastructure/weread/WeReadApi';
import { WeReadSession } from '../../infrastructure/weread/WeReadSession';
import { WeReadError } from '../../infrastructure/weread/WeReadError';
import { signWeRead, type ReaderContext } from '../../infrastructure/weread/Protocol';
import type { WeReadRequest } from '../../infrastructure/weread/Transport';

const shard = (body: string) => createHash('md5').update(body).digest('hex').toUpperCase() + body;

suite('WeRead chapter requests', () => {
  test('a failed shard aborts the remaining requests instead of leaving them to time out', async () => {
    let aborted = 0;
    const api = new WeReadApi({ request: async (input) => {
      if (input.path.endsWith('/e_0')) { throw new WeReadError('network', 'failed shard'); }
      return new Promise((_, reject) => {
        input.signal!.addEventListener('abort', () => {
          aborted++;
          reject(new WeReadError('cancelled', 'cancelled'));
        }, { once: true });
      });
    } });
    await assert.rejects(api.chapter('9', 70, { ps: 'test', format: 'epub' }), /failed shard/);
    assert.strictEqual(aborted, 2);
  });

  async function fixture(replies: Record<string, string>) {
    const requests: WeReadRequest[] = [];
    const session = new WeReadSession({
      get: async () => undefined, store: async () => {}, delete: async () => {}
    }, async (input) => {
      requests.push(input);
      const part = input.path.split('/').at(-1)!;
      assert.ok(part in replies, 'Unexpected request: ' + input.path);
      return { text: replies[part], cookies: [] };
    });
    await session.install('wr_vid=1; wr_skey=test', false);
    return { api: new WeReadApi(session), requests };
  }

  test('uses the reader format without an extra book-info request and signs each TXT part', async () => {
    const f = await fixture({ t_0: shard('#JD'), t_1: shard('QU') });
    const result = await f.api.chapter('9', 70, { ps: 'test', format: 'txt' });
    assert.deepStrictEqual(result, { text: 'ABC', format: 'txt' });
    assert.deepStrictEqual(f.requests.map((request) => request.path), ['/web/book/chapter/t_0', '/web/book/chapter/t_1']);
    const bodies = f.requests.map((request) => request.body as Record<string, string | number | boolean>);
    assert.strictEqual(bodies[0].st, 0);
    assert.strictEqual(bodies[1].st, 1);
    for (const body of bodies) {
      const { s, ...fields } = body;
      assert.strictEqual(s, signWeRead(fields));
    }
  });

  test('recognizes TXT metadata from e_0 when the format is absent', async () => {
    const f = await fixture({
      e_0: JSON.stringify({ bookId: '9', chapterUid: 70, chapterIdx: 2 }),
      t_0: shard('#JD'), t_1: shard('QU')
    });
    const context: ReaderContext = { ps: 'test' };
    const result = await f.api.chapter('9', 70, context);
    assert.deepStrictEqual(result, { text: 'ABC', format: 'txt' });
    assert.strictEqual(context.format, 'txt');
    await f.api.chapter('9', 70, context);
    assert.strictEqual(f.requests.filter((request) => request.path.endsWith('/e_0')).length, 1);
  });

  test('reuses the first valid EPUB shard rather than requesting it twice', async () => {
    const f = await fixture({ e_0: shard('#J'), e_1: shard('DQ'), e_3: shard('U') });
    const context: ReaderContext = { ps: 'test' };
    assert.deepStrictEqual(await f.api.chapter('9', 70, context), { text: 'ABC', format: 'epub' });
    assert.strictEqual(context.format, 'epub');
    assert.strictEqual(f.requests.length, 3);
    assert.strictEqual(f.requests.filter((request) => request.path.endsWith('/e_0')).length, 1);
  });

  test('does not treat an unknown or mismatched JSON response as a TXT signal', async () => {
    for (const body of [{}, { bookId: 'another', chapterUid: 70 }, { bookId: '9', chapterUid: 99 }]) {
      const f = await fixture({ e_0: JSON.stringify(body) });
      await assert.rejects(f.api.chapter('9', 70, { ps: 'test' }),
        (error: unknown) => error instanceof WeReadError && error.kind === 'response');
      assert.strictEqual(f.requests.length, 1);
    }
  });

  test('preserves an explicit unsupported format rather than guessing another', async () => {
    const f = await fixture({});
    await assert.rejects(f.api.chapter('9', 70, { ps: 'test', format: 'mobi' }),
      (error: unknown) => error instanceof WeReadError && error.kind === 'unsupported');
    assert.strictEqual(f.requests.length, 0);
  });
});
