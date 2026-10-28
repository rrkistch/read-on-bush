import type { EpubExtraction } from './BookExtractions';
import type { ReadingDisplayState } from './ReadingDisplayState';
import { nextScreenStart, screenBefore, screenFrom } from './epubPagination';

export type TxtPosition = { process: number; charOffset: number };
const extractions = new WeakMap<string[], EpubExtraction>();

function extraction(contents: string[]): EpubExtraction {
  let value = extractions.get(contents);
  if (!value) {
    value = { bookTitle: '', chapters: contents.map((text) => ({ title: '', text, images: [] })) };
    extractions.set(contents, value);
  }
  return value;
}

function location(state: ReadingDisplayState) {
  return { chapterIndex: state.process, charOffset: state.charOffset ?? 0 };
}

export function getTxtScreen(state: ReadingDisplayState, width: number, count: number): string[] {
  return state.contents.length ? screenFrom(extraction(state.contents), location(state), width, count).lines : [];
}

export function nextTxtPosition(state: ReadingDisplayState, width: number, count: number): TxtPosition | undefined {
  if (!state.contents.length) { return undefined; }
  const next = nextScreenStart(extraction(state.contents), location(state), width, count);
  return next ? { process: next.chapterIndex, charOffset: next.charOffset } : undefined;
}

export function previousTxtPosition(state: ReadingDisplayState, width: number, count: number): TxtPosition | undefined {
  if (!state.contents.length || (state.process === 0 && !state.charOffset)) { return undefined; }
  const { startProgress } = screenBefore(extraction(state.contents), location(state), width, count);
  return { process: startProgress.chapterIndex, charOffset: startProgress.charOffset };
}
