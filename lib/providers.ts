export type ProviderId =
  | 'deepseek'
  | 'glm'
  | 'openai'
  | 'qwen'
  | 'minimax'
  | 'custom';
export type ModelConfig = {
  provider: ProviderId;
  model: string;
  baseUrl: string;
  tokenParameter: 'max_tokens' | 'max_completion_tokens';
};
export const providers: Record<
  ProviderId,
  { name: string; model: string; baseUrl: string; description: string }
> = {
  deepseek: {
    name: 'DeepSeek',
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com',
    description: '中文讲解与日常陪练',
  },
  glm: {
    name: '智谱 GLM',
    model: 'glm-4.7-flash',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    description: '轻量学习与中文互动',
  },
  openai: {
    name: 'OpenAI GPT',
    model: 'gpt-5.4-nano',
    baseUrl: 'https://api.openai.com/v1',
    description: '英语表达与情景对话',
  },
  qwen: {
    name: '阿里 Qwen',
    model: 'qwen-plus',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    description: '百炼兼容文本接口',
  },
  minimax: {
    name: 'MiniMax',
    model: 'MiniMax-M3',
    baseUrl: 'https://api.minimax.io/v1',
    description: '兼容文本接口',
  },
  custom: {
    name: '兼容 API',
    model: '',
    baseUrl: 'https://openrouter.ai/api/v1',
    description: 'OpenRouter、硅基流动等',
  },
};
export const defaultConfig: ModelConfig = {
  provider: 'deepseek',
  ...providers.deepseek,
  tokenParameter: 'max_tokens',
};
export function validateEndpoint(config: ModelConfig, extraAllowed = '') {
  if (
    typeof config.provider !== 'string' ||
    !Object.hasOwn(providers, config.provider)
  )
    throw new Error('请选择支持的模型服务商。');
  const base = ['custom', 'qwen'].includes(config.provider)
    ? config.baseUrl
    : providers[config.provider].baseUrl;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error('API 地址格式不正确。');
  }
  const allowed = new Set([
    'api.openai.com',
    'api.deepseek.com',
    'open.bigmodel.cn',
    'openrouter.ai',
    'api.siliconflow.cn',
    'api.moonshot.cn',
    'dashscope.aliyuncs.com',
    'dashscope-intl.aliyuncs.com',
    'dashscope-us.aliyuncs.com',
    'cn-hongkong.dashscope.aliyuncs.com',
    'api.minimax.io',
    ...extraAllowed
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
  ]);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== '443') ||
    (!allowed.has(url.hostname) &&
      !/^[-a-z0-9]+\.(?:cn-beijing|cn-hongkong|ap-southeast-1|ap-northeast-1)\.maas\.aliyuncs\.com$/.test(
        url.hostname,
      ))
  )
    throw new Error(
      'API 地址必须使用 HTTPS 和受支持的服务商域名。其他域名需在服务端 ALLOWED_API_HOSTS 中配置。',
    );
  return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '')}/chat/completions`;
}
export function requestOptions(config: ModelConfig) {
  if (config.provider === 'minimax')
    return {
      max_completion_tokens: 4096,
      reasoning_split: true,
      ...(config.model === 'MiniMax-M3'
        ? { thinking: { type: 'disabled' } }
        : {}),
    };
  if (config.provider === 'openai')
    return {
      max_completion_tokens: 1600,
      store: false,
      ...(/^(gpt-5\.[14]-(nano|mini)|gpt-5\.[12])/.test(config.model)
        ? { reasoning_effort: 'none' }
        : {}),
    };
  if (config.provider === 'deepseek')
    return {
      max_tokens: 1600,
      ...(config.model === 'deepseek-flash' ||
      config.model.startsWith('deepseek-v4')
        ? { thinking: { type: 'disabled' } }
        : {}),
    };
  if (config.provider === 'glm')
    return {
      max_tokens: 1600,
      ...(/^glm-(?:4\.[5-9]|[5-9])(?:[.-]|$)/i.test(config.model)
        ? { thinking: { type: 'disabled' } }
        : {}),
    };
  return {
    [config.tokenParameter === 'max_completion_tokens'
      ? 'max_completion_tokens'
      : 'max_tokens']: 1600,
  };
}
