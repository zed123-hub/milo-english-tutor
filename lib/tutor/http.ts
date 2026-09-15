export function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
export async function readBody(
  req: Request,
  limit = 96000,
): Promise<Record<string, unknown>> {
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) throw Error('ORIGIN');
  const reader = req.body?.getReader();
  if (!reader) throw Error('INVALID_BODY');
  let size = 0;
  let content = '';
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw Error('TOO_LARGE');
    }
    content += decoder.decode(value, { stream: true });
  }
  content += decoder.decode();
  const value: unknown = JSON.parse(content);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('INVALID_BODY');
  return value as Record<string, unknown>;
}
export function safeError(error: unknown) {
  const message =
    error instanceof SyntaxError
      ? 'INVALID_BODY'
      : error instanceof Error
        ? error.message
        : '';
  const errors: Record<string, [number, string]> = {
    AUTH_REQUIRED: [401, '请登录后继续，你的学习记录将保存到自己的账户。'],
    DATABASE_UNAVAILABLE: [503, '学习记录暂时无法读取，请稍后重试。'],
    CONFLICT: [409, '另一个页面更新了学习记录。请刷新后继续，当前输入已保留。'],
    ORIGIN: [403, '请从应用页面发起请求。'],
    TOO_LARGE: [413, '这段内容太长，请缩短后再试。'],
    INVALID_BODY: [400, '提交内容格式不正确。'],
    INVALID_ACTION: [400, '这次操作已过期，请重新打开当前任务。'],
    KEY_REQUIRED: [400, '请先填写有效的 API Key。'],
    MODEL_AUTH: [502, '模型 Key 无效或没有权限，请在设置里检查。'],
    MODEL_ENDPOINT: [
      400,
      '此 API 地址不受支持。请使用 HTTPS 和受支持的服务商域名。',
    ],
    MODEL_LIMIT: [502, '模型请求受限或余额不足，请检查服务商账户。'],
    MODEL_FAILED: [502, '模型暂时连接不上，请稍后重试。'],
    MODEL_OUTPUT: [502, '模型没有返回可验证的评估，这次没有写入成绩，请重试。'],
  };
  const entry = errors[message] ?? [500, '暂时无法完成操作，请稍后重试。'];
  return response({ error: entry[1] }, entry[0]);
}
