import { cookieAccount, mergeCookies, parseCookies, validateCookie } from './Cookies';
import { requestWeRead, type WeReadRequest, type WeReadResponse, type WeReadTransport } from './Transport';
import { cancelled, checkApiResponse, record, WeReadError } from './WeReadError';

export const WEREAD_SECRET_KEY = 'readOnBush.weread.cookie';
export type WeReadSecrets = {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
};

export function parseJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new WeReadError('response', '微信读书返回了无法识别的数据，请稍后重试'); }
}

export function linkedAbort(signals: (AbortSignal | undefined)[]) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal?.aborted) { controller.abort(); }
    else { signal?.addEventListener('abort', abort, { once: true }); }
  }
  return {
    controller,
    dispose: () => signals.forEach((signal) => signal?.removeEventListener('abort', abort))
  };
}

export function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { return Promise.reject(cancelled()); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class WeReadSession {
  private cookie = '';
  private epoch = new AbortController();
  private renewal?: { generation: number; promise: Promise<void> };
  private pendingSave: Promise<void> = Promise.resolve();
  private generation = 0;
  private active = false;
  private lastRenewalAt?: number;

  constructor(
    private readonly secrets: WeReadSecrets,
    readonly transport: WeReadTransport = requestWeRead,
    private readonly now: () => number = Date.now
  ) {}

  get accountId(): string | undefined { return this.active ? cookieAccount(this.cookie) : undefined; }
  get version(): number { return this.generation; }

  async restore(): Promise<void> {
    const cookie = await this.secrets.get(WEREAD_SECRET_KEY);
    if (cookie) { await this.install(cookie, false); }
  }

  async install(cookie: string, persist = true): Promise<void> {
    const validated = validateCookie(cookie);
    this.suspend();
    const generation = this.generation;
    this.pendingSave = this.pendingSave.catch(() => undefined).then(async () => {
      if (generation !== this.generation) { throw cancelled(); }
      if (persist) { await this.secrets.store(WEREAD_SECRET_KEY, validated); }
    });
    await this.pendingSave;
    if (generation !== this.generation) { throw cancelled(); }
    this.cookie = validated;
    this.active = true;
  }

  async adopt(other: WeReadSession): Promise<void> {
    const renewedAt = other.lastRenewalAt;
    await this.install(other.cookie);
    this.lastRenewalAt = renewedAt;
  }

  async renewIfDue(maxAgeMs = 6 * 60 * 60 * 1000, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) { throw cancelled(); }
    // Existing manually supplied skey-only cookies must not acquire a refresh-token prerequisite.
    if (!this.active || !parseCookies(this.cookie).get('wr_rt')) { return; }
    if (this.lastRenewalAt !== undefined && this.now() - this.lastRenewalAt < maxAgeMs) { return; }
    const request = this.renew(this.generation);
    await (signal ? waitWithAbort(request, signal) : request);
  }

  suspend(): void {
    this.active = false;
    this.generation++;
    this.epoch.abort();
    this.epoch = new AbortController();
    this.renewal = undefined;
    this.lastRenewalAt = undefined;
  }

  async logout(): Promise<void> {
    this.suspend();
    this.cookie = '';
    await this.pendingSave.catch(() => undefined);
    await this.secrets.delete(WEREAD_SECRET_KEY);
  }

  async request(input: Omit<WeReadRequest, 'cookie'>): Promise<WeReadResponse> {
    if (!this.active) { throw new WeReadError('auth', '请先登录微信读书'); }
    const generation = this.generation;
    const abort = linkedAbort([input.signal, this.epoch.signal]);
    const send = async () => {
      if (generation !== this.generation || abort.controller.signal.aborted) { throw cancelled(); }
      const response = await this.transport({ ...input, cookie: this.cookie, signal: abort.controller.signal });
      if (generation !== this.generation || abort.controller.signal.aborted) { throw cancelled(); }
      if (/^\s*\{/.test(response.text)) { checkApiResponse(parseJson(response.text)); }
      await this.acceptCookies(response.cookies, generation);
      if (generation !== this.generation || abort.controller.signal.aborted) { throw cancelled(); }
      return response;
    };
    try {
      const failedCookie = this.cookie;
      try { return await send(); }
      catch (error) {
        if (!(error instanceof WeReadError) || error.kind !== 'auth') { throw error; }
        if (this.cookie === failedCookie) { await waitWithAbort(this.renew(generation), abort.controller.signal); }
        return await send();
      }
    } finally { abort.dispose(); }
  }

  private renew(generation: number): Promise<void> {
    if (generation !== this.generation || !this.active) { return Promise.reject(cancelled()); }
    if (this.renewal?.generation === generation) { return this.renewal.promise; }
    const promise = (async () => {
      const response = await this.transport({
        path: '/web/login/renewal', method: 'POST', cookie: this.cookie,
        body: { rq: '%2Fweb%2Fbook%2Fread', ql: false }, signal: this.epoch.signal
      });
      if (generation !== this.generation || !this.active) { throw cancelled(); }
      const data = record(parseJson(response.text));
      checkApiResponse(data);
      if (data.succ !== 1 || !response.cookies.some((header) => header.startsWith('wr_skey='))) {
        throw new WeReadError('auth', '微信读书登录已过期，请重新登录');
      }
      await this.acceptCookies(response.cookies, generation);
      if (generation !== this.generation || !this.active) { throw cancelled(); }
      this.lastRenewalAt = this.now();
    })();
    this.renewal = { generation, promise };
    void promise.finally(() => {
      if (this.renewal?.promise === promise) { this.renewal = undefined; }
    }).catch(() => undefined);
    return promise;
  }

  private async acceptCookies(headers: string[], generation: number): Promise<void> {
    if (!headers.length) { return; }
    const merged = mergeCookies(this.cookie, headers);
    if (cookieAccount(merged) !== cookieAccount(this.cookie)) {
      throw new WeReadError('auth', '微信读书账号发生变化，请重新登录');
    }
    if (merged === this.cookie) { return; }
    this.cookie = merged;
    this.pendingSave = this.pendingSave.catch(() => undefined).then(async () => {
      if (generation === this.generation && this.active) {
        await this.secrets.store(WEREAD_SECRET_KEY, merged);
      }
    });
    await this.pendingSave;
  }
}
