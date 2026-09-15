import { lessons, allPhrases } from '@/lib/curriculum';
import {
  providers,
  validateEndpoint,
  requestOptions,
  type ModelConfig,
} from '@/lib/providers';
const headers = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers });
}
export async function POST(req: Request) {
  if (
    req.headers.get('origin') &&
    req.headers.get('origin') !== new URL(req.url).origin
  )
    return json({ error: '请从应用页面发起请求。' }, 403);
  let body;
  try {
    const reader = req.body?.getReader();
    if (!reader) return json({ error: '请求内容为空。' }, 400);
    let size = 0;
    let text = '';
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64000) {
        await reader.cancel();
        return json({ error: '对话太长了，请开启新对话。' }, 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    body = JSON.parse(text);
  } catch {
    return json({ error: '请求内容格式不正确。' }, 400);
  }
  if (!body || typeof body !== 'object')
    return json({ error: '请求内容格式不正确。' }, 400);
  const { config, apiKey, messages, lessonId, action } = body;
  if (
    !config ||
    typeof config !== 'object' ||
    typeof config.provider !== 'string' ||
    !Object.hasOwn(providers, config.provider) ||
    typeof config.model !== 'string' ||
    !config.model.trim() ||
    config.model.length > 200 ||
    !/^[-\w./:]+$/.test(config.model)
  )
    return json({ error: '请填写有效的服务商和模型名称。' }, 400);
  if (
    typeof apiKey !== 'string' ||
    apiKey.length < 8 ||
    apiKey.length > 1024 ||
    /\s/.test(apiKey)
  )
    return json({ error: '请先在模型设置中填写有效的 API Key。' }, 400);
  if (
    !Array.isArray(messages) ||
    messages.length < 1 ||
    messages.length > 24 ||
    messages.some(
      (m) =>
        !m ||
        !['user', 'assistant'].includes(m.role) ||
        typeof m.content !== 'string' ||
        !m.content.trim() ||
        m.content.length > 8000,
    )
  )
    return json({ error: '对话内容无效或过长，请缩短后重试。' }, 400);
  let endpoint;
  try {
    endpoint = validateEndpoint(
      config as ModelConfig,
      process.env.ALLOWED_API_HOSTS ?? '',
    );
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
  const lesson =
    lessons[
      Number.isInteger(lessonId)
        ? Math.min(Math.max(lessonId, 0), lessons.length - 1)
        : 0
    ];
  const activePhrase =
    lesson.phrases.find((p) => p.id === body.phraseId) ?? lesson.phrases[0];
  const weakIds = Array.isArray(body.learner?.needsPractice)
    ? body.learner.needsPractice
        .filter(
          (id: unknown) =>
            typeof id === 'string' && allPhrases.some((p) => p.id === id),
        )
        .slice(0, 10)
    : [];
  const learnerContext = `当前练习：${activePhrase.en}（${activePhrase.zh}）；需要再练的表达：${
    allPhrases
      .filter((p) => weakIds.includes(p.id))
      .map((p) => p.en)
      .join('；') || '暂无记录'
  }`;
  const system = `你是 Milo，一位耐心、主动带领中文母语成人零基础学习者的英语导师。学习者主动性较弱，请替他安排下一步，不要抛出开放式的“你想学什么”。每次只教一个小知识点，中文解释，英文给完整短句并附中文含义；默认回复 100 到 220 字。先示范，再留一道难度很低的题，等用户回答再反馈，不能一次给一堆题。学生答错时指出一个最重要的问题，给例子，再让他试一次；正确时解释对在哪里并提出下一小步。想放弃时降低任务到一句话。不要羞辱或承诺包教会。不要把已看过或模仿过称为掌握。不要假装你听到了音频，也不能打发音分数。不要声称能在页面关闭后主动联系用户。不要声称已修改学习进度，你只能辅导，进度由课程练习记录。学习者所在课程：${lesson.title}；课程讲解：${lesson.grammar}；词句：${lesson.phrases.map((p) => `${p.en}=${p.zh}`).join('；')}。${learnerContext}。当前辅导动作：${typeof action === 'string' ? action.slice(0, 60) : 'chat'}。涉及超出本课的英语疑问也可以解释，然后引导一个适合初学者的小练习。不要输出思考过程。`;
  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'system', content: system }, ...messages],
        stream: false,
        ...requestOptions(config),
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!upstream.ok) {
      const status = upstream.status;
      await upstream.body?.cancel();
      return json(
        {
          error:
            status === 401
              ? 'API Key 无效或已过期，请检查后重试。'
              : status === 403
                ? '当前 Key 没有权限使用这个模型。'
                : status === 429
                  ? '请求过多或余额不足，请检查服务商账户后重试。'
                  : status === 404
                    ? '找不到模型或接口，请检查模型名称与 API 地址。'
                    : status === 400
                      ? '服务商不接受当前模型参数，请检查模型名称或兼容设置。'
                      : '模型服务暂时不可用，请稍后重试或切换服务商。',
        },
        502,
      );
    }
    const reader = upstream.body?.getReader();
    if (!reader) return json({ error: '模型返回了空响应。' }, 502);
    let size = 0;
    const decoder = new TextDecoder();
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512000) {
        await reader.cancel();
        return json({ error: '模型响应过大，请重新提一个简短问题。' }, 502);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return json({ error: '接口返回的不是有效 JSON，请检查 API 地址。' }, 502);
    }
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string' || !content.trim())
      return json(
        { error: '模型没有返回可显示的回答，请重试或换一个模型。' },
        502,
      );
    return json({
      content: content.trim(),
      model: config.model,
      truncated: choice.finish_reason === 'length',
    });
  } catch (e) {
    return json(
      {
        error:
          e instanceof Error && ['TimeoutError', 'AbortError'].includes(e.name)
            ? '等待模型超过 45 秒，请稍后重试或切换模型。'
            : '暂时连接不上模型服务，请检查 API 地址和网络后重试。',
      },
      502,
    );
  }
}
