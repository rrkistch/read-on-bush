import { CancellationTokenSource, commands, env, ProgressLocation, Uri, window, type Disposable } from 'vscode';
import type { BookData, BookNavigationTarget } from '../../domain/books';
import type { BookReaderController, ReaderServices, ReaderJumpOptions } from '../BookFormat';
import type { WeReadService } from '../../application/WeReadService';
import type { WeReadChapter } from '../../domain/books/WeRead';
import { WeReadChapterBook } from '../../domain/books/WeReadChapterBook';
import { WeReadSyncQueue } from '../../domain/books/WeReadSyncQueue';
import { AutoTurnScheduler } from '../../domain/autoTurn';
import { getAutoTurnConfig, getAutoConcealOnFocusLoss } from '../../config/settings';
import { PaginatedReaderDisplay } from '../../presentation/reader/PaginatedReaderDisplay';
import { getReaderDisplaySettings } from '../../presentation/reader/ReaderDisplaySettings';
import type { ReaderContext } from '../../infrastructure/weread/Protocol';
import { encodeWeReadId } from '../../infrastructure/weread/Protocol';
import { linkedAbort } from '../../infrastructure/weread/WeReadSession';
import { WeReadError, weReadMessage } from '../../infrastructure/weread/WeReadError';

const readerCommands = {
  next: 'readOnBush.weread.next', prev: 'readOnBush.weread.prev',
  jump: 'readOnBush.weread.jump', stop: 'readOnBush.weread.stop', viewImage: 'readOnBush.weread.viewImage'
};

type CloudProgressResult =
  | { ok: true; uid: number | undefined }
  | { ok: false; error: unknown };

export class WeReadReader implements BookReaderController {
  readonly format = 'weread';
  private readonly display: PaginatedReaderDisplay;
  private readonly lifetime = new AbortController();
  private readonly choices = new CancellationTokenSource();
  private readonly subscriptions: Disposable[] = [];
  private readonly accountVersion: number;
  private chapters: WeReadChapter[] = [];
  private context?: ReaderContext;
  private model?: WeReadChapterBook;
  private remoteFormat = 'epub';
  private sync?: WeReadSyncQueue;
  private autoTurn?: AutoTurnScheduler;
  private generation = 0;
  private closed = false;
  private disposed = false;
  private presented = false;
  private busy = false;
  private concealPending = false;
  private syncAllowed = true;
  private syncWarningShown = false;
  private pendingUid?: number;
  private visibleSince?: number;
  private activeMs = 0;

  constructor(
    readonly book: BookData,
    private readonly services: ReaderServices,
    private readonly host: WeReadService
  ) {
    this.accountVersion = host.session.version;
    this.display = new PaginatedReaderDisplay(readerCommands, services.readerSurface);
    this.subscriptions.push(
      commands.registerCommand(readerCommands.next, () => this.next()),
      commands.registerCommand(readerCommands.prev, () => this.previous()),
      commands.registerCommand(readerCommands.jump, () => this.pickChapter()),
      commands.registerCommand(readerCommands.stop, () => host.stopReading()),
      commands.registerCommand(readerCommands.viewImage, () => this.openOfficial()),
      this.display.onDidConcealContent(() => { this.stopClock(); this.autoTurn?.pauseIfRunning(); }),
      this.display.onDidRevealContent(() => this.startClock()),
      window.onDidChangeWindowState((state) => {
        if (!state.focused) { this.stopClock(); this.autoTurn?.pauseIfRunning(); }
        else { this.startClock(); }
      })
    );
  }

  async open(): Promise<boolean> {
    return window.withProgress({
      location: ProgressLocation.Notification,
      title: '正在打开在线文档',
      cancellable: true
    }, async (progress, token) => {
      const cancel = token.onCancellationRequested(() => {
        this.lifetime.abort();
        this.choices.cancel();
      });
      try {
        const pending = this.book.wereadProgress?.pendingChapterUid;
        progress.report({ message: '加载目录、阅读会话与云端位置…' });
        // All three are independent. Observe a cloud error immediately, even if a
        // required metadata request fails first, so no rejected promise is orphaned.
        const cloud = this.host.api.progress(this.book.source!.bookId, this.lifetime.signal)
          .then<CloudProgressResult, CloudProgressResult>(
            (uid) => ({ ok: true, uid }), (error: unknown) => ({ ok: false, error })
          );
        [this.chapters, this.context] = await Promise.all([
          this.host.chapters(this.book, this.lifetime.signal),
          this.host.api.context(this.book.source!.bookId, this.lifetime.signal)
        ]);
        const start = await this.startPosition(await cloud);
        if (!start || !this.isLive()) { return false; }
        progress.report({ message: '加载章节正文…' });
        if (!await this.navigate(start.index, start.offset, false)) { return false; }
        this.sync = new WeReadSyncQueue({
          send: (uid, signal) => this.sendProgress(uid, signal),
          pending: (uid) => { this.pendingUid = uid; this.savePosition(); },
          error: (error) => {
            if (!this.syncWarningShown) {
              this.syncWarningShown = true;
              this.services.notifier.warn('云进度尚未回传，本地位置已保存：' + weReadMessage(error) + '。可从微信读书菜单重试');
            }
          }
        }, start.cloudUid);
        this.sync.setEnabled(this.host.syncEnabled && this.syncAllowed);
        if (pending !== undefined && pending === this.model?.chapter.uid && pending !== start.cloudUid) {
          this.sync.enqueue(pending);
        }
        this.autoTurn = new AutoTurnScheduler({
          turnPage: () => this.move(1),
          getVisibleText: () => this.model?.getScreen(this.width, this.count).lines.join('') ?? '',
          onStateChange: (state) => {
            if (state === 'running') { this.services.notifier.info('自动翻页已开启'); }
            if (state === 'paused') { this.services.notifier.info('自动翻页已暂停'); }
          },
          onError: (error) => this.services.notifier.error(weReadMessage(error))
        }, getAutoTurnConfig);
        this.startClock();
        return true;
      } catch (error) {
        this.reportError(error);
        this.lifetime.abort();
        return false;
      } finally { cancel.dispose(); }
    });
  }

  async next(): Promise<void> { this.autoTurn?.pauseIfRunning(); await this.move(1); }
  async previous(): Promise<void> { this.autoTurn?.pauseIfRunning(); await this.move(-1); }

  async jumpTo(target: BookNavigationTarget, options?: ReaderJumpOptions): Promise<void> {
    if (target.kind !== 'section' || !this.isLive()) { return; }
    this.autoTurn?.pauseIfRunning();
    await this.navigate(target.sectionIndex, target.offset ?? 0, options?.persistProgress !== false);
  }

  getCurrentLocation(): BookNavigationTarget | undefined {
    return this.model
      ? { kind: 'section', sectionIndex: this.model.chapterIndex, offset: this.model.charOffset }
      : undefined;
  }

  refreshSettings(): void {
    this.sync?.setEnabled(this.host.syncEnabled && this.syncAllowed);
    if (this.model && !this.closed) {
      this.model.privateMode = this.services.privacyDisplay.isPrivate;
      this.display.updateSettings(getReaderDisplaySettings(this.services.templateService, this.services.privacyDisplay));
      this.display.open();
    }
  }

  refreshPrivacyDisplay(): void { this.refreshSettings(); }
  toggleAutoTurn(): void {
    if (this.display.isRealContentMode() && !this.busy && this.isLive()) { this.autoTurn?.toggle(); }
  }
  disposeAutoTurn(): void { this.autoTurn?.dispose(); this.autoTurn = undefined; }
  concealContent(): void { this.concealPending = true; this.display.concealContent(); this.stopClock(); }
  revealContent(): void { this.concealPending = false; this.display.revealContent(); this.startClock(); }

  async syncProgress(): Promise<void> {
    if (!this.syncAllowed) {
      this.services.notifier.warn('本次未能读取云端位置。请重新打开这本书，确认两端位置后再回传');
      return;
    }
    if (!this.model || !this.isLive()) { return; }
    this.syncWarningShown = false;
    this.sync?.enqueue(this.model.chapter.uid);
    await this.sync?.flush();
    await this.host.flushProgress();
    if (this.pendingUid === undefined && !this.syncWarningShown && this.host.syncEnabled) {
      this.services.notifier.info('云端章节进度已同步');
    }
  }

  async close(): Promise<void> {
    if (this.closed) { return; }
    this.closed = true;
    this.generation++;
    this.stopClock();
    this.disposeAutoTurn();
    this.lifetime.abort();
    this.choices.cancel();
    this.savePosition();
    if (this.presented) { this.display.hide(); this.presented = false; }
    await this.host.flushProgress();
    await this.sync?.flush();
    await this.host.flushProgress();
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.closed = true;
    this.lifetime.abort();
    this.choices.cancel();
    this.choices.dispose();
    this.stopClock();
    this.disposeAutoTurn();
    this.sync?.dispose();
    this.subscriptions.forEach((item) => item.dispose());
    this.display.dispose();
  }

  private get width(): number { return this.display.getEffectiveLineWidth(); }
  private get count(): number { return this.display.getLineCount(); }
  private isLive(): boolean {
    return !this.closed && !this.lifetime.signal.aborted &&
      this.host.isActive(this.book) && this.host.session.version === this.accountVersion;
  }

  private async startPosition(cloud: CloudProgressResult): Promise<{ index: number; offset: number; cloudUid?: number } | undefined> {
    const local = this.book.wereadProgress;
    let cloudUid = cloud.ok ? cloud.uid : undefined;
    if (!cloud.ok) {
      if (!this.isLive()) { return undefined; }
      this.syncAllowed = false;
      if (local) {
        this.services.notifier.warn('云进度暂不可用，将继续本地位置；本次暂停回传');
      } else {
        const action = await window.showWarningMessage('云进度暂不可用，本次将暂停回传。', '从第一章开始', '取消');
        if (action !== '从第一章开始') { return undefined; }
      }
    }
    if (!this.isLive()) { return undefined; }
    if (cloudUid === 0 && !this.chapters.some((chapter) => chapter.uid === 0)) { cloudUid = undefined; }
    const localIndex = local ? this.chapters.findIndex((chapter) => chapter.uid === local.chapterUid) : -1;
    const cloudIndex = cloudUid === undefined ? -1 : this.chapters.findIndex((chapter) => chapter.uid === cloudUid);
    if ((local && localIndex < 0) || (cloudUid !== undefined && cloudIndex < 0)) {
      const chapter = await this.chooseChapter('上次位置已不在目录中，请选择起始章节');
      return chapter === undefined ? undefined : { index: chapter, offset: 0, cloudUid };
    }
    if (local && localIndex >= 0 && cloudIndex >= 0 && local.chapterUid !== cloudUid) {
      const selected = await window.showQuickPick([
        { label: '本地位置', description: this.chapterLabel(localIndex), index: localIndex, offset: local.charOffset },
        { label: '微信读书位置', description: this.chapterLabel(cloudIndex), index: cloudIndex, offset: 0 }
      ], { title: '选择续读位置', placeHolder: '本地与微信读书停在不同章节，不会自动覆盖' }, this.choices.token);
      return selected ? { index: selected.index, offset: selected.offset, cloudUid } : undefined;
    }
    return local && localIndex >= 0 ? { index: localIndex, offset: local.charOffset, cloudUid }
      : { index: cloudIndex >= 0 ? cloudIndex : 0, offset: 0, cloudUid };
  }

  private async move(direction: 1 | -1): Promise<boolean> {
    const model = this.model;
    if (!model || !this.isLive() || this.busy || !this.display.isRealContentMode()) { return false; }
    const moved = direction === 1 ? model.next(this.width, this.count) : model.previous(this.width, this.count);
    if (moved) {
      this.savePosition();
      this.sync?.enqueue(model.chapter.uid);
      this.display.render();
      return true;
    }
    const index = model.chapterIndex + direction;
    if (index < 0 || index >= this.chapters.length) {
      this.services.notifier.info(direction > 0 ? '已经是最后一页了' : '已经是第一页了');
      return false;
    }
    return this.navigate(index, 0, true, direction < 0);
  }

  private async navigate(index: number, offset: number, persist: boolean, lastPage = false): Promise<boolean> {
    if (!this.isLive() || !Number.isSafeInteger(index) || index < 0 || index >= this.chapters.length) { return false; }
    const generation = ++this.generation;
    this.busy = true;
    try {
      const chapter = this.chapters[index];
      const loaded = await this.loadChapter(chapter);
      if (!this.isLive() || generation !== this.generation) { return false; }
      this.model = new WeReadChapterBook(chapter, index, this.chapters.length, loaded.text, offset, this.services.privacyDisplay.isPrivate);
      this.remoteFormat = loaded.format;
      if (lastPage) { this.model.lastPage(this.width, this.count); }
      if (this.presented) {
        this.display.replaceBook(this.model);
        this.display.render();
      } else {
        this.display.bind(this.model, getReaderDisplaySettings(this.services.templateService, this.services.privacyDisplay));
        this.display.reveal(this.concealPending || (!window.state.focused && getAutoConcealOnFocusLoss()));
        this.presented = true;
      }
      this.savePosition();
      if (persist) { this.sync?.enqueue(chapter.uid); }
      this.prefetch(index + 1);
      return true;
    } catch (error) {
      if (generation === this.generation) { this.reportError(error); }
      return false;
    } finally { if (generation === this.generation) { this.busy = false; } }
  }

  private loadChapter(chapter: WeReadChapter) {
    const source = this.book.source!;
    return this.host.cache.load(source.accountId + '/' + source.bookId + '/' + chapter.uid, () =>
      this.host.api.chapter(source.bookId, chapter.uid, this.context!, this.lifetime.signal));
  }

  private prefetch(index: number): void {
    if (index < this.chapters.length && this.isLive()) { void this.loadChapter(this.chapters[index]).catch(() => undefined); }
  }

  private savePosition(): void {
    const model = this.model;
    if (!model) { return; }
    this.host.saveProgress(this.book, {
      chapterUid: model.chapter.uid, chapterIndex: model.chapterIndex,
      charOffset: model.charOffset, updatedAt: Date.now(), pendingChapterUid: this.pendingUid
    });
  }

  private chapterLabel(index: number): string {
    return this.services.privacyDisplay.isPrivate ? '第 ' + (index + 1) + ' 章' : this.chapters[index].title;
  }
  private async chooseChapter(title: string): Promise<number | undefined> {
    const selected = await window.showQuickPick(this.chapters.map((_, index) => ({
      label: this.chapterLabel(index), description: '第 ' + (index + 1) + ' 章', index
    })), { title }, this.choices.token);
    return selected?.index;
  }
  private async pickChapter(): Promise<void> {
    const index = await this.chooseChapter('跳转到章节');
    if (index !== undefined) { await this.jumpTo({ kind: 'section', sectionIndex: index }); }
  }

  private startClock(): void {
    if (this.presented && this.isLive() && window.state.focused && this.display.isRealContentMode() && this.visibleSince === undefined) {
      this.visibleSince = Date.now();
    }
  }
  private stopClock(): void {
    if (this.visibleSince !== undefined) { this.activeMs += Date.now() - this.visibleSince; this.visibleSince = undefined; }
  }

  private async sendProgress(uid: number, signal: AbortSignal): Promise<void> {
    if (!this.host.isActive(this.book) || this.host.session.version !== this.accountVersion) {
      throw new WeReadError('cancelled', '账号已改变');
    }
    await this.host.flushProgress();
    const abort = linkedAbort([signal]);
    const timer = setTimeout(() => abort.controller.abort(), 5000);
    const activeSeconds = (this.activeMs + (this.visibleSince === undefined ? 0 : Date.now() - this.visibleSince)) / 1000;
    try {
      await this.host.api.report(this.book.source!.bookId, uid, this.remoteFormat, this.context!, activeSeconds, abort.controller.signal);
      this.activeMs = 0;
      if (this.visibleSince !== undefined) { this.visibleSince = Date.now(); }
      this.syncWarningShown = false;
    } finally { clearTimeout(timer); abort.dispose(); }
  }

  private async openOfficial(): Promise<void> {
    const action = await window.showInformationMessage('第一版微信读书仅显示文字和图片占位，可在官网查看原始排版。', '打开官网');
    if (action === '打开官网' && this.book.source) {
      await env.openExternal(Uri.parse('https://weread.qq.com/web/reader/' + encodeWeReadId(this.book.source.bookId)));
    }
  }
  private reportError(error: unknown): void {
    if (this.isLive() && !(error instanceof WeReadError && error.kind === 'cancelled')) {
      this.services.notifier.error(weReadMessage(error));
    }
  }
}
