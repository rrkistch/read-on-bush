import type { BookData } from './BookData';

export type ReadingDisplayState = {
  content: string;
  contents: string[];
  book: BookData;
  process: number;
  charOffset?: number;
  total: number;
  isReading: boolean;
};
