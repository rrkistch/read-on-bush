import type { TerminalCamouflageLayout } from '../../config/settings';
import type { ResolvedTerminalTemplate, TerminalTemplate } from '../readerTemplates';
import { SAFE_SGR_CODE_ALTERNATION } from '../readerTemplates/TemplateTypes';
import {
  computeResolvedEffectiveLineWidth, fallbackContentWidth, formatResolvedCamouflageScreen,
  formatResolvedDebugCamouflageScreen, getTextWidth, sanitizeTrustedTemplateContent
} from './CamouflageRenderer';
import { getCharWidth } from '../../domain/books/TextWidth';
import { KEYS_HINT } from '../readerTemplates/TemplateKeys';

export type CamouflageLayout = {
  resolved: ResolvedTerminalTemplate;
  columns?: number;
  lineWidth: number;
  lineCount: number;
  compact: boolean;
};

const shortPrefixes = {
  buildLog: '[watch] ', claudeCli: '', serverLog: 'INFO ', vite: '[vite] ', docker: 'api | '
};
const sgrPrefix = new RegExp('^\\x1b\\[(?:' + SAFE_SGR_CODE_ALTERNATION + ')m');

function flatten(lines: readonly string[]): string[] {
  return lines.flatMap((line) => line.split(/\r?\n/));
}

/** Clip decoration, never reading text. Preserve only the existing trusted SGR palette. */
function fitDecoration(value: string, width: number): string {
  const text = sanitizeTrustedTemplateContent(value);
  let result = '';
  let used = 0;
  for (let i = 0; i < text.length;) {
    const sgr = sgrPrefix.exec(text.slice(i));
    if (sgr) { result += sgr[0]; i += sgr[0].length; continue; }
    const char = String.fromCodePoint(text.codePointAt(i)!);
    const size = getCharWidth(char);
    if (used + size > width) { break; }
    result += char;
    used += size;
    i += char.length;
  }
  return result + (result.includes('\x1b[') ? '\x1b[0m' : '');
}

function bottom(template: TerminalTemplate, progress: string, columns: number): string[] {
  return flatten(template.bottom?.(progress, columns) ?? [template.done(progress, columns), '', KEYS_HINT]);
}

function compactProgress(progress: string, columns: number): string {
  let value = progress.trim();
  const prefix = columns > 12 ? '[ok] ' : '';
  const room = columns - prefix.length;
  if (getTextWidth(value) > room) {
    value = value.match(/(?:本章\s*)?\d+(?:\.\d+)?%[^\d]*$/)?.[0] ??
      value.match(/\d+\s*\/\s*\d+/)?.[0] ?? value;
  }
  return '\x1b[2m' + fitDecoration(prefix + value, columns) + '\x1b[0m';
}

// Note: shared viewport budgeting and TXT source anchors are documented in docs/architecture.md.
export function resolveCamouflageLayout(
  resolved: ResolvedTerminalTemplate,
  configuredWidth: number,
  configuredCount: number,
  dimensions?: { columns: number; rows: number },
  mode: TerminalCamouflageLayout = 'auto'
): CamouflageLayout {
  const desired = Math.max(1, Math.floor(configuredCount));
  if (mode === 'full') {
    return {
      resolved, columns: dimensions?.columns, compact: false, lineCount: desired,
      lineWidth: computeResolvedEffectiveLineWidth(configuredWidth, dimensions?.columns, resolved)
    };
  }
  const columns = Math.max(2, Math.floor(dimensions?.columns ?? fallbackContentWidth));
  const rows = Math.max(1, Math.floor(dimensions?.rows ?? desired + 2));
  const width = columns - 1; // Avoid native-terminal automatic wrapping at the last column.
  const original = resolved.template;
  const overhead = flatten(original.header).length + flatten(original.trailing).length + bottom(original, '', width).length;
  const compact = mode === 'compact' || !dimensions ||
    desired + overhead > rows || getTextWidth(original.contentPrefix) >= columns / 2;
  const footerRows = compact && rows > 1 ? 1 : 0;
  const lineCount = compact ? Math.min(desired, rows - footerRows) : desired;
  const headerRows = compact && rows - footerRows - lineCount > 0 ? 1 : 0;
  const prefix = compact
    ? fitDecoration(resolved.requestedStyle === 'custom' ? original.contentPrefix : shortPrefixes[resolved.requestedStyle],
      Math.min(10, Math.floor(Math.max(0, columns - 4) / 3)))
    : original.contentPrefix;
  const template: TerminalTemplate = {
    ...original,
    contentPrefix: prefix,
    header: compact
      ? (headerRows ? [fitDecoration(flatten(original.header).find((line) => getTextWidth(line.trim()) > 0) ?? original.terminalName, width)] : [])
      : flatten(original.header).map((line) => fitDecoration(line, width)),
    trailing: compact ? [] : flatten(original.trailing).map((line) => fitDecoration(line, width)),
    bottom: compact
      ? (progress) => footerRows ? [compactProgress(progress, width)] : []
      : (progress) => bottom(original, progress, width).map((line) => fitDecoration(line, width)),
    done: (progress) => fitDecoration(original.done(progress, width), width)
  };
  const available = Math.max(2, columns - getTextWidth(prefix) - 2);
  return {
    resolved: { ...resolved, template }, columns, compact, lineCount,
    lineWidth: configuredWidth > 0 ? Math.max(2, Math.min(configuredWidth, available)) : available
  };
}

export function formatCamouflageLayout(layout: CamouflageLayout, lines: string[], progress: string): string {
  const content = [...lines];
  if (layout.compact) { while (content.length < layout.lineCount) { content.push(''); } }
  return formatResolvedCamouflageScreen(layout.resolved, content, progress, layout.columns);
}

export function formatDebugCamouflageLayout(layout: CamouflageLayout): string {
  const resolved = layout.compact ? {
    ...layout.resolved,
    template: {
      ...layout.resolved.template,
      debugContent: flatten(layout.resolved.template.debugContent).map((line) => fitDecoration(line, layout.lineWidth))
    }
  } : layout.resolved;
  return formatResolvedDebugCamouflageScreen(resolved, layout.lineWidth, layout.lineCount, layout.columns);
}
