import { commands, ConfigurationTarget, window, workspace, type Disposable } from 'vscode';
import type { ApplicationContext } from './ApplicationContext';
import type { BookData } from '../domain/books';
import type { WeReadChapter, WeReadProgress } from '../domain/books/WeRead';
import { WeReadApi } from '../infrastructure/weread/WeReadApi';
import { WeReadSession } from '../infrastructure/weread/WeReadSession';
import { ChapterCache } from '../infrastructure/weread/ChapterCache';
import { WeReadError, weReadMessage } from '../infrastructure/weread/WeReadError';
import { validateCookie } from '../infrastructure/weread/Cookies';
import { WeReadLoginPanel } from '../presentation/weread/WeReadLoginPanel';
import { WeReadProvider } from '../formats/weread/WeReadProvider';
import { createWeReadTransport } from '../infrastructure/weread/Transport';

// Note: 在线书源、账号隔离与章节级进度的取舍见 docs/superpowers/specs/2026-10-26-weread-design.md。
export class WeReadService implements Disposable {
  readonly session: WeReadSession;
  readonly api: WeReadApi;
  readonly cache = new ChapterCache();
  private readonly login: WeReadLoginPanel;
  private initialization?: Promise<void>;
  private authGeneration = 0;
  private authController = new AbortController();
  private readonly subscriptions: Disposable[] = [];
  private readonly log: (line: string) => void;
  private lastRenewalCheck?: { version: number; time: number };

  constructor(private readonly app: ApplicationContext) {
    const output = window.createOutputChannel('Read On Bush · 微信读书');
    this.log = (line) => { try { output.appendLine(line); } catch { /* disposed */ } };
    this.subscriptions.push(output);
    this.session = new WeReadSession(app.context.secrets, createWeReadTransport(this.log));
    this.login = new WeReadLoginPanel(this.session.transport);
    this.api = new WeReadApi(this.session);
    app.formatRegistry.register(new WeReadProvider(this));
    for (const [id, action] of [
      ['readOnBush.weread.menu', () => this.menu()],
      ['readOnBush.weread.login', () => this.loginQr()],
      ['readOnBush.weread.setCookie', () => this.setCookie()],
      ['readOnBush.weread.refresh', () => this.refreshShelf()],
      ['readOnBush.weread.logout', () => this.logout()],
      ['readOnBush.weread.retrySync', () => this.retrySync()]
    ] as const) {
      this.subscriptions.push(commands.registerCommand(id, () => this.run(action)));
    }
    this.subscriptions.push(commands.registerCommand('readOnBush.weread.showDiagnostics', () => output.show(true)));
    const renewalTimer = setInterval(() => this.renewSession(), 30 * 60 * 1000);
    this.subscriptions.push({ dispose: () => clearInterval(renewalTimer) });
  }

  get accountId(): string | undefined { return this.session.accountId; }
  get syncEnabled(): boolean {
    return workspace.getConfiguration('readOnBush').get<boolean>('wereadSyncProgress', false);
  }

  initialize(): Promise<void> {
    return this.initialization ??= this.session.restore().then(() => {
      this.app.bookList.updateBookTreeProvider();
      this.renewSession();
    }).catch(() => {
      this.session.suspend();
      this.app.notifier.warn('无法恢复微信读书登录，请从微信读书菜单重新登录');
    });
  }

  isActive(book: BookData): boolean {
    return !!book.source && book.source.accountId === this.accountId;
  }

  async chapters(book: BookData, signal?: AbortSignal): Promise<WeReadChapter[]> {
    if (!this.isActive(book)) { throw new WeReadError('auth', '请先登录这本书所属的微信读书账号'); }
    this.renewSession();
    const version = this.session.version;
    const chapters = await this.api.chapters(book.source!.bookId, signal);
    if (version !== this.session.version || signal?.aborted) {
      throw new WeReadError('cancelled', '操作已取消');
    }
    await this.app.bookList.syncWeReadChapters(book.id, chapters);
    return chapters;
  }

  saveProgress(book: BookData, progress: WeReadProgress): void {
    book.wereadProgress = { ...progress };
    this.app.bookList.updateWeReadProgress(book.id, progress);
  }

  flushProgress(): Promise<void> { return this.app.bookList.flushProgressWrite(); }
  clearCache(): void { this.cache.clear(); }
  stopReading(): Promise<void> { return this.app.readingSession.closeCurrent(); }

  private async run(action: () => Promise<void>): Promise<void> {
    try { await this.initialize(); await action(); }
    catch (error) {
      if (!(error instanceof WeReadError && error.kind === 'cancelled')) {
        this.app.notifier.error(weReadMessage(error));
      }
    }
  }

  private async menu(): Promise<void> {
    const selected = await window.showQuickPick([
      { label: '$(device-mobile) 扫码登录', action: 'qr', description: this.accountId ? '切换账号' : undefined },
      { label: '$(key) 设置 Cookie', action: 'cookie' },
      ...(this.accountId ? [
        { label: '$(refresh) 刷新微信书架', action: 'refresh' },
        { label: '$(cloud-upload) 进度回传', description: this.syncEnabled ? '已开启 · 按章节同步' : '已关闭', action: 'sync' },
        { label: '$(sync) 重试当前书籍进度回传', action: 'retry' },
        { label: '$(output) 查看请求日志', action: 'logs' },
        { label: '$(sign-out) 退出微信读书', action: 'logout' }
      ] : [])
    ], { title: '微信读书', placeHolder: this.accountId ? '已登录，凭据保存在安全存储中' : '连接账号后同步个人书架' });
    switch (selected?.action) {
      case 'qr': await this.loginQr(); break;
      case 'cookie': await this.setCookie(); break;
      case 'refresh': await this.refreshShelf(); break;
      case 'sync': await this.toggleSync(); break;
      case 'retry': await this.retrySync(); break;
      case 'logs': await commands.executeCommand('readOnBush.weread.showDiagnostics'); break;
      case 'logout': await this.logout(); break;
    }
  }

  private beginAuth(): number {
    this.authGeneration++;
    this.authController.abort();
    this.authController = new AbortController();
    return this.authGeneration;
  }

  private async loginQr(): Promise<void> {
    const generation = this.beginAuth();
    const cookie = await this.login.show();
    if (cookie && generation === this.authGeneration) { await this.acceptCookie(cookie, generation); }
  }

  private async setCookie(): Promise<void> {
    const generation = this.beginAuth();
    this.login.dispose();
    const cookie = await window.showInputBox({
      title: '微信读书 Cookie', password: true, ignoreFocusOut: true,
      prompt: '粘贴 weread.qq.com 请求头中的完整 Cookie，仅保存到 VS Code 安全存储',
      validateInput: (value) => {
        try { validateCookie(value); return undefined; }
        catch (error) { return weReadMessage(error); }
      }
    });
    if (cookie && generation === this.authGeneration) { await this.acceptCookie(cookie, generation); }
  }

  private async acceptCookie(cookie: string, generation: number): Promise<void> {
    const temporary = new WeReadSession({
      get: async () => undefined, store: async () => undefined, delete: async () => undefined
    }, this.session.transport);
    try {
      await temporary.install(cookie, false);
      const shelf = await new WeReadApi(temporary).shelf(this.authController.signal);
      if (generation !== this.authGeneration) { return; }
      // Validate the candidate first; an invalid pasted cookie must not destroy a working login.
      this.session.suspend();
      this.cache.clear();
      this.app.bookList.updateBookTreeProvider();
      if (this.app.readingSession.current?.format === 'weread') { await this.stopReading(); }
      if (generation !== this.authGeneration) { return; }
      await this.session.adopt(temporary);
      if (generation !== this.authGeneration) { return; }
      await this.app.bookList.mergeWeReadBooks(this.accountId!, shelf);
      this.renewSession();
      this.app.notifier.info('微信读书已连接，书架已同步');
    } finally { temporary.suspend(); }
  }

  private async refreshShelf(): Promise<void> {
    if (!this.accountId) { await this.loginQr(); return; }
    this.renewSession();
    const version = this.session.version;
    const account = this.accountId;
    const books = await this.api.shelf();
    if (version !== this.session.version) { return; }
    await this.app.bookList.mergeWeReadBooks(account, books);
    this.app.notifier.info(books.length ? '微信书架已刷新' : '微信书架为空，可先在微信读书中添加书籍');
  }

  private renewSession(): void {
    if (!this.accountId) { return; }
    const version = this.session.version;
    const time = Date.now();
    if (this.lastRenewalCheck?.version === version &&
        time - this.lastRenewalCheck.time < 30 * 60 * 1000) { return; }
    this.lastRenewalCheck = { version, time };
    // Renewal is opportunistic, not a new blocking prerequisite for valid cookies.
    void this.session.renewIfDue().catch((error: unknown) => {
      if (version === this.session.version &&
          !(error instanceof WeReadError && error.kind === 'cancelled')) {
        this.log('后台登录续期未完成：' + weReadMessage(error));
      }
    });
  }

  private async toggleSync(): Promise<void> {
    const enabled = this.syncEnabled;
    if (!enabled) {
      const answer = await window.showInformationMessage(
        '开启后会将阅读位置回传到微信读书。第一版按章节同步，手机端将定位到该章开头；本地保留章内精确位置。',
        '开启回传', '取消'
      );
      if (answer !== '开启回传') { return; }
    }
    await workspace.getConfiguration('readOnBush').update('wereadSyncProgress', !enabled, ConfigurationTarget.Global);
    this.app.readingSession.refreshSettings();
    this.app.notifier.info(enabled ? '微信读书进度回传已关闭' : '微信读书进度回传已开启');
  }

  private async retrySync(): Promise<void> {
    if (!this.syncEnabled) { this.app.notifier.info('请先在微信读书菜单开启进度回传'); return; }
    const reader = this.app.readingSession.current;
    if (reader?.format !== 'weread') { this.app.notifier.info('请先打开一本微信书籍'); return; }
    await reader.syncProgress?.();
  }

  private async logout(): Promise<void> {
    this.beginAuth();
    this.login.dispose();
    this.session.suspend();
    this.cache.clear();
    this.app.bookList.updateBookTreeProvider();
    if (this.app.readingSession.current?.format === 'weread') { await this.stopReading(); }
    await this.session.logout();
    this.app.notifier.info('已退出微信读书');
  }

  dispose(): void {
    this.beginAuth();
    this.login.dispose();
    this.session.suspend();
    this.cache.clear();
    this.subscriptions.forEach((item) => item.dispose());
  }
}
