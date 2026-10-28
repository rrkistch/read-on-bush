import { randomBytes } from 'crypto';
import { window, ViewColumn, type Disposable, type WebviewPanel } from 'vscode';
import { toDataURL } from 'qrcode';
import { mergeCookies, validateCookie } from '../../infrastructure/weread/Cookies';
import { requestWeRead, type WeReadTransport } from '../../infrastructure/weread/Transport';
import { parseJson } from '../../infrastructure/weread/WeReadSession';
import { record, WeReadError, weReadMessage } from '../../infrastructure/weread/WeReadError';
import { renderWeReadLogin } from './WeReadLoginView';

export class WeReadLoginPanel implements Disposable {
  private panel?: WebviewPanel;
  private attempt = 0;
  private controller?: AbortController;
  private resolve?: (cookie: string | undefined) => void;
  private result?: Promise<string | undefined>;
  private readonly nonce = randomBytes(18).toString('base64');
  private lastHtml = '';

  constructor(private readonly transport: WeReadTransport = requestWeRead) {}

  show(): Promise<string | undefined> {
    if (this.panel && this.result) { this.panel.reveal(); return this.result; }
    this.result = new Promise((resolve) => { this.resolve = resolve; });
    this.panel = window.createWebviewPanel('readOnBush.weread.login', '微信读书登录', ViewColumn.Active, {
      enableScripts: true, localResourceRoots: []
    });
    this.lastHtml = '';
    this.panel.onDidDispose(() => {
      this.controller?.abort();
      this.attempt++;
      this.panel = undefined;
      this.resolve?.(undefined);
      this.resolve = undefined;
    });
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      const action = record(message).action;
      if (action === 'cancel') { this.dispose(); }
      if (action === 'retry') { void this.start(); }
    });
    void this.start();
    return this.result;
  }

  dispose(): void {
    this.controller?.abort();
    this.panel?.dispose();
  }

  private render(message: string, qr?: string, retry = false): void {
    const html = renderWeReadLogin(message, qr, retry, this.nonce);
    if (this.panel && html !== this.lastHtml) {
      this.lastHtml = html;
      this.panel.webview.html = html;
    }
  }

  private async start(): Promise<void> {
    this.controller?.abort();
    const generation = ++this.attempt;
    const controller = new AbortController();
    this.controller = controller;
    this.render('正在获取登录二维码…');
    let qr: string | undefined;
    try {
      const first = await this.transport({ path: '/api/auth/getLoginUid', signal: controller.signal });
      const raw = record(parseJson(first.text));
      const uid = String(raw.uid ?? record(raw.data).uid ?? '');
      if (!uid || uid.length > 1024) { throw new WeReadError('response', '微信读书未返回有效的登录二维码'); }
      let cookie = mergeCookies('', first.cookies);
      qr = await toDataURL('https://weread.qq.com/web/confirm?uid=' + encodeURIComponent(uid), {
        margin: 2, width: 300, errorCorrectionLevel: 'M'
      });
      if (generation !== this.attempt || controller.signal.aborted) { return; }
      this.render('等待扫码与手机确认', qr);
      const expiresAt = Date.now() + 180000;
      let otp = '';
      while (!controller.signal.aborted && generation === this.attempt && Date.now() < expiresAt) {
        let response;
        try {
          response = await this.transport({
            path: '/api/auth/getLoginInfo?uid=' + encodeURIComponent(uid) + '&otp=' + encodeURIComponent(otp),
            cookie, signal: controller.signal, timeoutMs: 65000
          });
        } catch (error) {
          if (error instanceof WeReadError && error.kind === 'timeout') { continue; }
          throw error;
        }
        if (generation !== this.attempt || controller.signal.aborted) { return; }
        cookie = mergeCookies(cookie, response.cookies);
        const root = record(parseJson(response.text));
        const data = record(root.data ?? root);
        if (data.succeed === true || data.succeed === 1) {
          const values: string[] = [];
          const vid = data.webLoginVid ?? data.vid;
          if (vid) { values.push('wr_vid=' + String(vid)); }
          if (typeof data.accessToken === 'string') { values.push('wr_skey=' + data.accessToken); }
          if (typeof data.refreshToken === 'string') { values.push('wr_rt=' + data.refreshToken); }
          const authenticated = validateCookie(mergeCookies(cookie, values));
          const complete = this.resolve;
          this.resolve = undefined;
          complete?.(authenticated);
          this.dispose();
          return;
        }
        const code = String(data.logicCode ?? '');
        if (code === 'LOGIN_TIMEOUT' || code === 'OTP_EXPIRED') { break; }
        if (code === 'NEED_OTP' || code === 'OTP_NOT_MATCH') {
          this.render(code === 'OTP_NOT_MATCH' ? '验证码不匹配，请重新输入' : '请按手机提示输入安全验证码', qr);
          const input = await window.showInputBox({
            title: '微信读书安全验证', prompt: '请输入手机提示的验证码',
            password: true, ignoreFocusOut: true,
            validateInput: (value) => /^\d{4,8}$/.test(value.trim()) ? undefined : '请输入 4–8 位数字验证码'
          });
          if (input === undefined) { this.dispose(); return; }
          otp = input.trim();
        } else if (code) {
          throw new WeReadError('auth', '微信读书未完成登录，请刷新二维码后重试');
        } else {
          this.render('等待扫码与手机确认', qr);
        }
        await new Promise<void>((resolve) => {
          const abort = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, 1000);
          controller.signal.addEventListener('abort', abort, { once: true });
          if (controller.signal.aborted) { abort(); }
        });
      }
      if (generation === this.attempt && !controller.signal.aborted) { this.render('二维码已过期，请刷新', undefined, true); }
    } catch (error) {
      if (generation === this.attempt && !controller.signal.aborted) { this.render(weReadMessage(error), undefined, true); }
    }
  }
}
