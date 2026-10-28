function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]!));
}

export function renderWeReadLogin(
  message: string, qr: string | undefined, canRetry: boolean, nonce: string
): string {
  return [
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; script-src \'nonce-' + nonce + '\'">',
    '<title>微信读书登录</title><style>',
    ':root{color-scheme:light dark}body{margin:0;padding:40px 24px;font:var(--vscode-font-size,14px)/1.7 var(--vscode-font-family,system-ui);color:var(--vscode-foreground,#ccc);background:var(--vscode-editor-background,#1e1e1e)}',
    'main{max-width:440px;margin:auto}h1{font-size:24px;font-weight:600;margin:0 0 8px}.intro{color:var(--vscode-descriptionForeground,#aaa);margin:0 0 28px}',
    '.qr{width:256px;height:256px;max-width:100%;display:block;margin:24px auto;padding:12px;background:#fff;border-radius:8px;box-sizing:border-box}',
    '.placeholder{height:256px;display:grid;place-items:center;color:var(--vscode-descriptionForeground,#aaa)}',
    '.state{text-align:center;min-height:48px;margin:20px 0}nav{display:flex;gap:12px;justify-content:center;margin-top:20px}',
    'button{font:inherit;padding:7px 18px;border:1px solid transparent;border-radius:3px;cursor:pointer;background:var(--vscode-button-background,#0078d4);color:var(--vscode-button-foreground,#fff)}',
    'button:hover{background:var(--vscode-button-hoverBackground,#006cbe)}button:focus-visible{outline:2px solid var(--vscode-focusBorder,#0078d4);outline-offset:3px}',
    '.secondary{background:var(--vscode-button-secondaryBackground,#333);color:var(--vscode-button-secondaryForeground,#ddd)}',
    '.help{margin-top:32px;padding-top:20px;border-top:1px solid var(--vscode-panel-border,#444);color:var(--vscode-descriptionForeground,#aaa)}',
    '</style></head><body><main><h1>连接微信读书</h1><p class="intro">用手机微信扫码，并在手机上确认登录。</p>',
    qr ? '<img class="qr" src="' + escapeHtml(qr) + '" alt="微信读书登录二维码">'
      : canRetry ? '' : '<div class="placeholder" aria-hidden="true">微信读书</div>',
    '<p class="state" role="status" aria-live="polite">' + escapeHtml(message) + '</p><nav>',
    canRetry ? '<button id="retry">刷新二维码</button>' : '',
    '<button class="secondary" id="cancel">取消登录</button></nav>',
    '<p class="help">登录凭据保存在 VS Code 的安全存储中。也可以关闭此窗口，在“微信读书”菜单里选择“设置 Cookie”。</p>',
    '</main><script nonce="' + nonce + '">',
    'const api=acquireVsCodeApi();document.getElementById("cancel").onclick=()=>api.postMessage({action:"cancel"});',
    'const retry=document.getElementById("retry");if(retry)retry.onclick=()=>api.postMessage({action:"retry"});',
    '</script></body></html>'
  ].join('');
}
