import { EventEmitter } from 'vscode';
import type {
  BookData,
  BookFormat,
  BookNavigationTarget,
  ReadingDisplayState,
  TxtReadingPort
} from '../domain/books';
import type {
  BookReaderController,
  ReaderJumpOptions,
  ReaderServices,
  TxtReaderCapability
} from '../formats';
import type { ApplicationContext } from './ApplicationContext';

export class ReadingSession implements TxtReadingPort {
  private currentReader?: BookReaderController;
  private openGeneration = 0;
  private closing?: Promise<void>;
  private readonly formatEmitter = new EventEmitter<BookFormat | undefined>();

  constructor(private readonly app: ApplicationContext) {
    app.context.subscriptions.push(this.formatEmitter);
  }

  readonly onDidChangeFormat = this.formatEmitter.event;

  get current(): BookReaderController | undefined {
    return this.currentReader;
  }

  get currentTxtState(): ReadingDisplayState | undefined {
    return this.txtReader?.currentTxtState;
  }

  get currentTxtPageCount(): number {
    return this.txtReader?.currentTxtPageCount ?? 0;
  }

  async open(book: BookData): Promise<void> {
    const generation = ++this.openGeneration;
    await this.releaseCurrent();
    if (generation !== this.openGeneration) { return; }
    const provider = this.app.formatRegistry.getProviderForBook(book);

    if (!provider) {
      this.app.notifier.error('暂不支持该书籍格式');
      return;
    }

    const reader = provider.createReader({ book, services: this.createReaderServices() });
    this.currentReader = reader;
    let opened: boolean;
    try { opened = await reader.open(); }
    catch {
      if (generation === this.openGeneration && this.currentReader === reader) {
        await this.releaseCurrent();
        this.app.notifier.error('打开书籍失败，请重试');
        this.app.showIdleReaderHint();
      }
      return;
    }
    if (generation !== this.openGeneration || this.currentReader !== reader) {
      // The newer open/close already owns cleanup. Closing again could erase its surface.
      return;
    }

    if (!opened) {
      await this.releaseCurrent();
      this.app.showIdleReaderHint();
      return;
    }

    this.app.bookList.markLastOpened(book.id);
    this.formatEmitter.fire(reader.format);
    void this.app.searchService.prewarm(reader.book);
  }

  async next(): Promise<void> {
    await this.currentReader?.next();
  }

  async previous(): Promise<void> {
    await this.currentReader?.previous();
  }

  async jumpTo(target: BookNavigationTarget, options?: ReaderJumpOptions): Promise<void> {
    if (!this.currentReader?.jumpTo) {
      this.app.notifier.warn('当前书籍不支持该跳转方式');
      return;
    }

    await this.currentReader.jumpTo(target, options);
  }

  async closeCurrent(): Promise<void> {
    const generation = ++this.openGeneration;
    await this.releaseCurrent();
    if (generation === this.openGeneration && !this.currentReader) { this.app.showIdleReaderHint(); }
  }

  private async releaseCurrent(): Promise<void> {
    const reader = this.currentReader;
    if (!reader) { await this.closing; return; }
    // Detach synchronously, before any flush/network await can admit another open.
    this.currentReader = undefined;
    reader.disposeAutoTurn?.();
    this.app.searchService.clear(reader.book.id);
    this.formatEmitter.fire(undefined);
    const closing = (async () => {
      try {
        await Promise.all([this.app.bookList.flushProgressWrite(), reader.close()]);
      } finally { reader.dispose?.(); }
    })();
    this.closing = closing;
    try { await closing; }
    finally { if (this.closing === closing) { this.closing = undefined; } }
  }

  refreshSettings(): void {
    this.currentReader?.refreshSettings?.();
  }

  refreshPrivacyDisplay(): void {
    this.currentReader?.refreshPrivacyDisplay?.();
  }

  async nextTxt(): Promise<void> {
    if (this.txtReader) {
      await this.currentReader?.next();
    }
  }

  async previousTxt(): Promise<void> {
    if (this.txtReader) {
      await this.currentReader?.previous();
    }
  }

  async jumpTxt(pageIndex: number): Promise<void> {
    if (this.txtReader) {
      await this.currentReader?.jumpTo?.({ kind: 'page', pageIndex });
    }
  }

  startTxt(): void {
    this.txtReader?.start();
  }

  stopTxt(): void {
    this.txtReader?.stop();
  }

  toggleAutoTurn(): void {
    this.currentReader?.toggleAutoTurn?.();
  }

  private get txtReader(): TxtReaderCapability | undefined {
    return this.currentReader?.txt;
  }

  private createReaderServices(): ReaderServices {
    return {
      readerSurface: this.app.readerSurface,
      templateService: this.app.templateService,
      privacyDisplay: this.app.privacyDisplay,
      bookCatalog: this.app.bookList,
      notifier: this.app.notifier,
      txtDisplay: this.app.displayManager
    };
  }
}
