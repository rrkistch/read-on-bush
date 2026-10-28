import type { BookData, BookOutlineItem } from '../../domain/books';
import type { BookFormatProvider, CreateReaderInput } from '../BookFormat';
import type { WeReadService } from '../../application/WeReadService';
import { WeReadReader } from './WeReadReader';
import { WeReadError, weReadMessage } from '../../infrastructure/weread/WeReadError';
import { window } from 'vscode';

export class WeReadProvider implements BookFormatProvider {
  readonly format = 'weread';
  readonly supportedExtensions: readonly string[] = [];

  constructor(private readonly host: WeReadService) {}

  async importBook(): Promise<BookData> {
    throw new WeReadError('unsupported', '请从微信读书菜单同步书架，不需要导入本地文件');
  }

  createReader(input: CreateReaderInput): WeReadReader {
    return new WeReadReader(input.book, input.services, this.host);
  }

  async getOutline(book: BookData): Promise<BookOutlineItem[]> {
    try {
      const chapters = await this.host.chapters(book);
      return chapters.map((chapter, index) => ({
        id: String(chapter.uid), title: chapter.title,
        target: { kind: 'section', sectionIndex: index, offset: 0 }
      }));
    } catch (error) {
      if (!(error instanceof WeReadError && error.kind === 'cancelled')) {
        void window.showWarningMessage(weReadMessage(error));
      }
      return [];
    }
  }
}
