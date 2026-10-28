export type WeReadErrorKind =
  | 'auth' | 'network' | 'permission' | 'unsupported' | 'response' | 'cancelled' | 'rate' | 'timeout';

export class WeReadError extends Error {
  constructor(readonly kind: WeReadErrorKind, message: string) {
    super(message);
    this.name = 'WeReadError';
  }
}

export function cancelled(): WeReadError {
  return new WeReadError('cancelled', '操作已取消');
}

export function weReadMessage(error: unknown): string {
  return error instanceof WeReadError ? error.message : '微信读书请求失败，请重试';
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function checkApiResponse(value: unknown): void {
  const data = record(value);
  const code = Number(data.errCode ?? data.errcode ?? 0);
  const message = typeof data.errMsg === 'string' ? data.errMsg : '';
  if ([-2010, -2012, -2013, -2014, -12013].includes(code) ||
      message.includes('鉴权失败') || message.includes('登录授权已过期')) {
    throw new WeReadError('auth', '微信读书登录已过期，请重新登录');
  }
  if (code !== 0) {
    throw new WeReadError('permission', '微信读书拒绝了请求，请在官网确认账号和阅读权限');
  }
}
