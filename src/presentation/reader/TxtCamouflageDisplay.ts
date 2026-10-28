import { commands } from 'vscode';
import type { ExtensionContext } from 'vscode';
import { Commands } from '../../config/commands';
import { getTerminalCamouflageLayout } from '../../config/settings';
import { getTxtScreen, nextTxtPosition, previousTxtPosition } from '../../domain/books/TxtPagination';
import { resolveCamouflageLayout, formatCamouflageLayout, formatDebugCamouflageLayout } from './CamouflageLayout';
import type { ResolvedTerminalTemplate } from '../readerTemplates';
import { CamouflageDisplayBase } from './CamouflageDisplayBase';
import type { CamouflageInputHandlers } from '../readerControls';
import { createReaderSurfaceFrame, type ReaderSurface } from '../readerSurfaces';
import type { ReadingDisplayState } from './ReaderDisplayTypes';
import {
  computeResolvedEffectiveLineWidth,
  resolveBuiltinTemplate,
  updateTerminalTemplate
} from './rendering';
import {
  getTerminalNextProcessStep,
  getTerminalPrevProcessStep
} from './CamouflagePagination';

export class TxtCamouflageDisplay extends CamouflageDisplayBase {
  private lastState?: ReadingDisplayState;
  private lastShowProgress = false;
  private lastLineWidth = 0;
  private lastLineCount = 3;
  private lastTemplate: ResolvedTerminalTemplate = resolveBuiltinTemplate('buildLog');

  constructor(context: ExtensionContext, readerView: ReaderSurface) {
    super(context, readerView, Commands.Stop);
  }

  render(
    state: ReadingDisplayState,
    showProgress: boolean,
    lineWidth: number,
    lineCount: number,
    template: ResolvedTerminalTemplate
  ): void {
    this.lastState = state;
    this.lastShowProgress = showProgress;
    this.lastLineWidth = lineWidth;
    this.lastLineCount = lineCount;
    this.updateTemplate(template);
    this.open();
  }

  pause(): void {
    if (!this.opened && !this.lastState) {
      return;
    }

    this.deactivate();
    this.readerView.publishIdle(this.lastTemplate);
  }

  reveal(
    showProgress: boolean,
    lineWidth: number,
    lineCount: number,
    template: ResolvedTerminalTemplate
  ): void {
    this.lastShowProgress = showProgress;
    this.lastLineWidth = lineWidth;
    this.lastLineCount = lineCount;
    this.updateTemplate(template);
    this.open();
  }

  protected getInputHandlers(): CamouflageInputHandlers {
    return {
      next: () => void commands.executeCommand(Commands.NextLine),
      prev: () => void commands.executeCommand(Commands.PrevLine),
      jump: () => void commands.executeCommand(Commands.JumpLine),
      search: () => this.executeRealContentCommand(Commands.SearchCurrentBook),
      toggleDebug: () => this.toggleDebugContent(),
      toggleAutoTurn: () => this.executeRealContentCommand(Commands.AutoTurnToggle),
      quit: () => this.concealController.handleQuitKey(),
      onNonQuitKey: () => this.concealController.clearPendingQuit()
    };
  }

  protected clearState(): void {
    this.lastState = undefined;
  }

  getNextPosition(state: ReadingDisplayState, width: number, count: number, template: ResolvedTerminalTemplate) {
    const layout = this.getLayout(width, count, template);
    return nextTxtPosition(state, layout.lineWidth, layout.lineCount);
  }

  getPreviousPosition(state: ReadingDisplayState, width: number, count: number, template: ResolvedTerminalTemplate) {
    const layout = this.getLayout(width, count, template);
    return previousTxtPosition(state, layout.lineWidth, layout.lineCount);
  }

  getVisibleText(state: ReadingDisplayState): string {
    const layout = this.getLayout();
    return getTxtScreen(state, layout.lineWidth, layout.lineCount).join('');
  }

  private getLayout(width = this.lastLineWidth, count = this.lastLineCount, template = this.lastTemplate) {
    return resolveCamouflageLayout(template, width, count, this.viewportDimensions, getTerminalCamouflageLayout());
  }

  getNextProcessStep(
    state: ReadingDisplayState,
    lineWidth: number,
    lineCount: number,
    template: ResolvedTerminalTemplate
  ): number {
    return getTerminalNextProcessStep(state, this.getEffectiveLineWidth(lineWidth, template), lineCount);
  }

  getPrevProcessStep(
    state: ReadingDisplayState,
    lineWidth: number,
    lineCount: number,
    template: ResolvedTerminalTemplate
  ): number {
    return getTerminalPrevProcessStep(state, this.getEffectiveLineWidth(lineWidth, template), lineCount);
  }

  private getEffectiveLineWidth(
    lineWidth: number,
    template: ResolvedTerminalTemplate
  ): number {
    return computeResolvedEffectiveLineWidth(lineWidth, this.viewportDimensions?.columns, template);
  }

  private updateTemplate(template: ResolvedTerminalTemplate): void {
    this.lastTemplate = updateTerminalTemplate(this.lastTemplate, template);
  }

  protected renderOrIdle(): void {
    if (!this.opened) {
      return;
    }

    if (this.lastState) {
      this.writeLastState();
      return;
    }

    if (this.concealController.mode === 'real') {
      this.readerView.publishIdle(this.lastTemplate);
      return;
    }

    const screen = formatDebugCamouflageLayout(this.getLayout());
    this.readerView.publishFrame(
      createReaderSurfaceFrame(screen, this.lastTemplate, this.concealController.mode)
    );
  }

  private writeLastState(): void {
    const state = this.lastState!;
    const layout = this.getLayout();
    const progress = this.lastShowProgress
      ? '  ' + Math.min(state.process + 1, state.total) + '/' + state.total : '';
    const screen = this.concealController.mode === 'debugTemplate'
      ? formatDebugCamouflageLayout(layout)
      : formatCamouflageLayout(layout, getTxtScreen(state, layout.lineWidth, layout.lineCount), progress);
    this.readerView.publishFrame(
      createReaderSurfaceFrame(screen, this.lastTemplate, this.concealController.mode)
    );
  }
}
