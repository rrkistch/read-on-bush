import * as assert from 'assert';
import { WeReadSession, WEREAD_SECRET_KEY, type WeReadSecrets } from '../../infrastructure/weread/WeReadSession';
import { WeReadError } from '../../infrastructure/weread/WeReadError';
import type { WeReadTransport, WeReadResponse } from '../../infrastructure/weread/Transport';

const response = (value: unknown, cookies: string[] = []): WeReadResponse => ({ text: JSON.stringify(value), cookies });
const cookie = 'wr_vid=123; wr_skey=stale; wr_rt=test';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function secretStore() {
  const values = new Map<string, string>();
  const store: WeReadSecrets = {
    get: async (key) => values.get(key),
    store: async (key, value) => { values.set(key, value); },
    delete: async (key) => { values.delete(key); }
  };
  return { values, store };
}

suite('WeReadSession', () => {
  test('a cancelled proactive check sends no request', async () => {
    let requests = 0;
    const session = new WeReadSession(secretStore().store, async () => {
      requests++;
      return response({ succ: 1 }, ['wr_skey=fresh']);
    });
    await session.install(cookie);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(session.renewIfDue(0, controller.signal));
    assert.strictEqual(requests, 0);
  });

  test('failed proactive renewal does not invalidate a cookie that still works', async () => {
    const session = new WeReadSession(secretStore().store, async (input) => {
      if (input.path === '/web/login/renewal') { throw new WeReadError('network', 'offline'); }
      return response({ books: [] });
    });
    await session.install(cookie);
    await assert.rejects(session.renewIfDue());
    assert.strictEqual(session.accountId, '123');
    assert.strictEqual((await session.request({ path: '/web/shelf/sync' })).text, '{"books":[]}');
  });

  test('a late proactive renewal cannot restore credentials after logout', async () => {
    const pending = deferred<WeReadResponse>();
    const { store, values } = secretStore();
    const session = new WeReadSession(store, () => pending.promise);
    await session.install(cookie);
    const renewing = session.renewIfDue();
    const rejected = assert.rejects(renewing);
    await session.logout();
    pending.resolve(response({ succ: 1 }, ['wr_skey=late']));
    await rejected;
    assert.strictEqual(values.size, 0);
  });

  test('renews proactively once per interval and coalesces concurrent checks', async () => {
    let now = 1000;
    let renewals = 0;
    const session = new WeReadSession(secretStore().store, async (input) => {
      assert.strictEqual(input.path, '/web/login/renewal');
      renewals++;
      return response({ succ: 1 }, ['wr_skey=fresh-' + renewals]);
    }, () => now);
    await session.install(cookie);
    await Promise.all([session.renewIfDue(), session.renewIfDue()]);
    assert.strictEqual(renewals, 1);
    now += 60 * 60 * 1000;
    await session.renewIfDue();
    assert.strictEqual(renewals, 1);
    now += 6 * 60 * 60 * 1000;
    await session.renewIfDue();
    assert.strictEqual(renewals, 2);
  });

  test('a manual cookie without a refresh token keeps its original request contract', async () => {
    let requests = 0;
    const session = new WeReadSession(secretStore().store, async () => {
      requests++;
      return response({ books: [] });
    });
    await session.install('wr_vid=123; wr_skey=manual');
    await session.renewIfDue();
    assert.strictEqual(requests, 0);
    await session.request({ path: '/web/shelf/sync' });
    assert.strictEqual(requests, 1);
  });

  test('adopting a validated session preserves its recent renewal time', async () => {
    let renewals = 0;
    const transport: WeReadTransport = async () => {
      renewals++;
      return response({ succ: 1 }, ['wr_skey=fresh']);
    };
    const temporary = new WeReadSession(secretStore().store, transport, () => 1000);
    const session = new WeReadSession(secretStore().store, transport, () => 1000);
    await temporary.install(cookie);
    await temporary.renewIfDue();
    await session.adopt(temporary);
    await session.renewIfDue();
    assert.strictEqual(renewals, 1);
  });

  test('uses secret storage and restores the same account', async () => {
    const { values, store } = secretStore();
    const session = new WeReadSession(store);
    await session.install(cookie);
    assert.strictEqual(values.get(WEREAD_SECRET_KEY), cookie);
    const restored = new WeReadSession(store);
    await restored.restore();
    assert.strictEqual(restored.accountId, '123');
    await restored.logout();
    assert.strictEqual(values.size, 0);
  });

  test('coalesces authentication renewal and retries each request once', async () => {
    const renewal = deferred<void>();
    let renewals = 0;
    let normal = 0;
    const transport: WeReadTransport = async (input) => {
      if (input.path === '/web/login/renewal') {
        renewals++;
        await renewal.promise;
        return response({ succ: 1 }, ['wr_skey=fresh; HttpOnly']);
      }
      normal++;
      return response(input.cookie?.includes('fresh') ? { books: [] } : { errCode: -2013 });
    };
    const { store, values } = secretStore();
    const session = new WeReadSession(store, transport);
    await session.install(cookie);
    const first = session.request({ path: '/a' });
    const second = session.request({ path: '/b' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(renewals, 1);
    renewal.resolve();
    await Promise.all([first, second]);
    assert.strictEqual(normal, 4);
    assert.ok(values.get(WEREAD_SECRET_KEY)?.includes('wr_skey=fresh'));
  });

  test('does not renew on an ordinary permission error', async () => {
    let requests = 0;
    const session = new WeReadSession(secretStore().store, async () => {
      requests++; return response({ errCode: -100 });
    });
    await session.install(cookie);
    await assert.rejects(session.request({ path: '/a' }), (error: unknown) => error instanceof WeReadError && error.kind === 'permission');
    assert.strictEqual(requests, 1);
  });

  test('ignores a late request and cookie update after logout', async () => {
    const network = deferred<WeReadResponse>();
    const { store, values } = secretStore();
    const session = new WeReadSession(store, () => network.promise);
    await session.install(cookie);
    const request = session.request({ path: '/a' });
    const rejected = assert.rejects(request, (error: unknown) => error instanceof WeReadError && error.kind === 'cancelled');
    await session.logout();
    network.resolve(response({}, ['wr_skey=late']));
    await rejected;
    assert.strictEqual(values.size, 0);
    assert.strictEqual(session.accountId, undefined);
  });

  test('a concurrent logout waits for an in-progress credential write before deleting', async () => {
    const writing = deferred<void>();
    const { store, values } = secretStore();
    const session = new WeReadSession({
      ...store,
      store: async (key, value) => { await writing.promise; values.set(key, value); }
    });
    const installing = session.install(cookie);
    const rejected = assert.rejects(installing);
    await new Promise((resolve) => setImmediate(resolve));
    const loggingOut = session.logout();
    writing.resolve();
    await Promise.all([rejected, loggingOut]);
    assert.strictEqual(values.size, 0);
  });

  test('cancelling a caller does not wait for a slow shared renewal', async () => {
    const renewal = deferred<WeReadResponse>();
    const session = new WeReadSession(secretStore().store, async (input) =>
      input.path === '/web/login/renewal' ? renewal.promise : response({ errCode: -2013 }));
    await session.install(cookie);
    const controller = new AbortController();
    const request = session.request({ path: '/a', signal: controller.signal });
    const rejected = assert.rejects(request);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await rejected;
    renewal.resolve(response({ succ: 1 }, ['wr_skey=fresh']));
  });
});
