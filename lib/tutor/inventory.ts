export type FunctionId =
  | 'introduce'
  | 'request'
  | 'clarify'
  | 'preference'
  | 'past'
  | 'plan';
export type ScenarioId = 'friends' | 'cafe' | 'office' | 'airport' | 'morning';
export type TaskKind = 'listen' | 'speak' | 'transfer' | 'repair';
export type LanguageItem = {
  id: string;
  phrase: string;
  meaning: string;
  functionId: FunctionId;
};
export type TaskTemplate = {
  id: string;
  title: string;
  functionId: FunctionId;
  scenario: ScenarioId;
  kind: TaskKind;
  level: 1 | 2;
  instruction: string;
  prompt: string;
  meaning: string;
  targetIds: string[];
  example: string;
  hints: [string, string, string];
  intent: string;
};
export const scenarioNames: Record<ScenarioId, string> = {
  friends: '朋友聊天',
  cafe: '街角咖啡店',
  office: '办公室',
  airport: '机场',
  morning: '清晨时光',
};
export const functionNames: Record<FunctionId, string> = {
  introduce: '介绍自己',
  request: '提出请求',
  clarify: '澄清与求助',
  preference: '表达偏好',
  past: '讲述经历',
  plan: '商量计划',
};
export const inventory: LanguageItem[] = [
  {
    id: 'im',
    phrase: "I'm",
    meaning: '我是／我现在……',
    functionId: 'introduce',
  },
  {
    id: 'usually',
    phrase: 'I usually',
    meaning: '我通常……',
    functionId: 'introduce',
  },
  {
    id: 'can-i-have',
    phrase: 'Can I have',
    meaning: '我可以要……吗？',
    functionId: 'request',
  },
  {
    id: 'could-you',
    phrase: 'Could you',
    meaning: '你能……吗？',
    functionId: 'request',
  },
  { id: 'please', phrase: 'please', meaning: '请', functionId: 'request' },
  {
    id: 'without',
    phrase: 'without',
    meaning: '不加／没有……',
    functionId: 'request',
  },
  {
    id: 'again',
    phrase: 'say that again',
    meaning: '再说一遍',
    functionId: 'clarify',
  },
  {
    id: 'understand',
    phrase: "I don't understand",
    meaning: '我不明白',
    functionId: 'clarify',
  },
  {
    id: 'mean',
    phrase: 'What do you mean',
    meaning: '你指的是什么？',
    functionId: 'clarify',
  },
  {
    id: 'prefer',
    phrase: 'I prefer',
    meaning: '我更喜欢……',
    functionId: 'preference',
  },
  {
    id: 'because',
    phrase: 'because',
    meaning: '因为……',
    functionId: 'preference',
  },
  { id: 'went', phrase: 'I went', meaning: '我去了……', functionId: 'past' },
  {
    id: 'finished',
    phrase: 'I finished',
    meaning: '我完成了……',
    functionId: 'past',
  },
  {
    id: 'going-to',
    phrase: "I'm going to",
    meaning: '我打算……',
    functionId: 'plan',
  },
  {
    id: 'not-sure',
    phrase: "I'm not sure yet",
    meaning: '我还不确定',
    functionId: 'plan',
  },
  {
    id: 'depends',
    phrase: 'It depends on',
    meaning: '这取决于……',
    functionId: 'plan',
  },
];
function task(t: TaskTemplate) {
  return t;
}
export const taskLibrary: TaskTemplate[] = [
  task({
    id: 'listen-order',
    title: '听懂客人的小要求',
    functionId: 'request',
    scenario: 'cafe',
    kind: 'listen',
    level: 1,
    instruction:
      '先听客人点单，再告诉我：他要什么饮品，要不要糖？中文回答也可以。',
    prompt: 'A tea without sugar, please.',
    meaning: '请给我一杯不加糖的茶。',
    targetIds: ['without'],
    example: '他要不加糖的茶。',
    hints: [
      '留意饮品，以及 sugar 前面的词。',
      'tea 是茶，without 表示不加。',
      '他说要不加糖的茶。',
    ],
    intent:
      '从音频中理解客人要茶而且不加糖；只说饮品或把糖的要求说反不能算完整理解。',
  }),
  task({
    id: 'listen-work',
    title: '听懂同事的请求',
    functionId: 'request',
    scenario: 'office',
    kind: 'listen',
    level: 1,
    instruction:
      '同事需要你帮一个忙。先听，再告诉我：他想让你做什么，什么时候做？',
    prompt: 'Could you send me the file tomorrow?',
    meaning: '你能明天把文件发给我吗？',
    targetIds: ['could-you'],
    example: '他希望我明天发文件。',
    hints: [
      '留意动作、物品和句子最后的时间。',
      'send the file 是发送文件；留意 tomorrow。',
      '他希望你明天发送文件。',
    ],
    intent: '理解对方请求明天发送文件；可以用中文回答。',
  }),
  task({
    id: 'intro',
    title: '先认识一下彼此',
    functionId: 'introduce',
    scenario: 'friends',
    kind: 'speak',
    level: 1,
    instruction: '用英语告诉我你的名字。只说一句也可以。',
    prompt: "Hi, I'm Milo. What's your name?",
    meaning: '嗨，我是 Milo。你叫什么名字？',
    targetIds: ['im'],
    example: "I'm Alex. Nice to meet you.",
    hints: [
      '可以先说「我是……」，接上你自己的名字。',
      "用 I'm… 开头就可以。",
      "I'm Alex. 把 Alex 换成你的名字。",
    ],
    intent: '学生用英语介绍自己的名字；不要求特定名字或唯一句型。',
  }),
  task({
    id: 'listen-routine',
    title: '先用耳朵认识一句话',
    functionId: 'introduce',
    scenario: 'friends',
    kind: 'listen',
    level: 1,
    instruction:
      '先听这位朋友说话。然后用中文或英文告诉我：他通常什么时候喝咖啡？',
    prompt: 'I usually have coffee in the morning.',
    meaning: '我通常在早上喝咖啡。',
    targetIds: ['usually'],
    example: '他通常早上喝咖啡。',
    hints: [
      '留意句子最后说的时间。',
      '留意 morning 这个词。',
      '他说的是：我通常在早上喝咖啡。',
    ],
    intent: '回答通常早上喝咖啡；中文回答也可证明听懂，但不能证明口语能力。',
  }),
  task({
    id: 'coffee-simple',
    title: '帮你点到第一杯咖啡',
    functionId: 'request',
    scenario: 'cafe',
    kind: 'speak',
    level: 1,
    instruction: '我是店员。请用英语要一杯咖啡，加一个礼貌表达。',
    prompt: 'Hi! What would you like?',
    meaning: '你好！你想要点什么？',
    targetIds: ['can-i-have', 'please'],
    example: 'Can I have a coffee, please?',
    hints: [
      '说出你想要的饮品，再加上「请」。',
      '你可以用 Can I have… 开头。',
      'Can I have a coffee, please?',
    ],
    intent: '礼貌地请求一杯咖啡。Coffee, please 等自然替代表达同样有效。',
  }),
  task({
    id: 'coffee-detail',
    title: '把自己的需要说清楚',
    functionId: 'request',
    scenario: 'cafe',
    kind: 'speak',
    level: 2,
    instruction: '这次想要冰咖啡，不加糖。请向店员说明。',
    prompt: 'What can I get for you today?',
    meaning: '今天想喝点什么？',
    targetIds: ['can-i-have', 'without', 'please'],
    example: 'Can I have an iced coffee without sugar, please?',
    hints: [
      '需要表达三个信息：咖啡、冰的、不加糖。',
      '试着用 iced coffee 和 without sugar。',
      'Can I have an iced coffee without sugar, please?',
    ],
    intent: '请求冰咖啡且不加糖；请求茶或否定想要咖啡不能算完成。',
  }),
  task({
    id: 'office-request',
    title: '请同事帮一个忙',
    functionId: 'request',
    scenario: 'office',
    kind: 'transfer',
    level: 1,
    instruction: '我是你的同事。请用英语向我要那份文件，表达礼貌。',
    prompt: 'Hi, do you need something?',
    meaning: '嗨，你需要什么吗？',
    targetIds: ['can-i-have', 'could-you', 'please'],
    example: 'Can I have the file, please?',
    hints: [
      '像点咖啡一样，这次你需要的是文件。',
      '文件可以说 the file，也可以用 Could you send…',
      'Could you send me the file, please?',
    ],
    intent: '向同事礼貌地请求文件；可用 have/send/share 等合理表达。',
  }),
  task({
    id: 'airport-clarify',
    title: '没听清，也能接着聊',
    functionId: 'clarify',
    scenario: 'airport',
    kind: 'speak',
    level: 1,
    instruction: '机场工作人员说得很快。请用英语请他再说一遍。',
    prompt: 'Your flight is boarding at gate twenty-eight.',
    meaning: '你的航班正在 28 号登机口登机。',
    targetIds: ['again', 'please'],
    example: 'Could you say that again, please?',
    hints: [
      '不需要猜登机口，先请求重复。',
      '试试 say that again。',
      'Could you say that again, please?',
    ],
    intent: '请求工作人员重复或说慢一点，成功修复没有听清的交流。',
  }),
  task({
    id: 'office-clarify',
    title: '确认一下同事的意思',
    functionId: 'clarify',
    scenario: 'office',
    kind: 'transfer',
    level: 2,
    instruction:
      '同事说“Make it lighter”，你不知道他指什么。请用英语请求澄清。',
    prompt: 'Could you make it lighter?',
    meaning: '你能把它弄得更轻／更浅一点吗？',
    targetIds: ['mean', 'understand'],
    example: 'What do you mean by lighter?',
    hints: [
      '告诉他你不确定，并问清 lighter 的意思。',
      '可以从 What do you mean… 开始。',
      'What do you mean by lighter?',
    ],
    intent: '询问 lighter 的含义或请求解释，不是假装已经理解。',
  }),
  task({
    id: 'friends-preference',
    title: '说一个自己的选择',
    functionId: 'preference',
    scenario: 'friends',
    kind: 'speak',
    level: 1,
    instruction: '朋友约你吃饭。选披萨或面条，再说一个简单理由。',
    prompt: 'Would you like pizza or noodles?',
    meaning: '你想吃披萨还是面条？',
    targetIds: ['prefer', 'because'],
    example: 'I prefer noodles because they are delicious.',
    hints: [
      '先选一个，再说为什么喜欢。',
      '可以用 I prefer… because…',
      'I prefer noodles because they are delicious.',
    ],
    intent: '在披萨或面条之间给出选择，并给出合理理由；不限定偏好。',
  }),
  task({
    id: 'cafe-preference',
    title: '把喜好带到咖啡店',
    functionId: 'preference',
    scenario: 'cafe',
    kind: 'transfer',
    level: 1,
    instruction: '店员问咖啡还是茶。选择一种并简单说明原因。',
    prompt: 'Do you prefer coffee or tea?',
    meaning: '你更喜欢咖啡还是茶？',
    targetIds: ['prefer', 'because'],
    example: 'I prefer tea because it helps me relax.',
    hints: [
      '你有自己的喜好，没有标准选项。',
      '选择饮品后用 because 解释。',
      'I prefer tea because it helps me relax.',
    ],
    intent: '选择咖啡或茶并说明原因，语言自然替代也应接受。',
  }),
  task({
    id: 'friends-past',
    title: '聊聊昨天的小事',
    functionId: 'past',
    scenario: 'friends',
    kind: 'speak',
    level: 2,
    instruction: '告诉朋友你昨天去了哪里，以及感觉怎么样。',
    prompt: 'How was your day yesterday?',
    meaning: '你昨天过得怎么样？',
    targetIds: ['went'],
    example: 'I went to a park. It was relaxing.',
    hints: [
      '选一件真实的小事，说去的地方和感受。',
      '过去的「去」可以用 went。',
      'I went to a park. It was relaxing.',
    ],
    intent: '用英语叙述过去发生的一个活动并表达感受；个人信息可以虚构。',
  }),
  task({
    id: 'morning-plan',
    title: '今天准备怎么过',
    functionId: 'plan',
    scenario: 'morning',
    kind: 'speak',
    level: 1,
    instruction:
      '像早晨聊天一样，说说今天准备做的一件事。不确定也可以表达出来。',
    prompt: 'Morning! What are you going to do today?',
    meaning: '早上好！你今天准备做什么？',
    targetIds: ['going-to', 'not-sure'],
    example: "I'm going to work. I'm not sure about tonight yet.",
    hints: [
      '只说今天的一件事，不需要完整日程。',
      "用 I'm going to… 或 I'm not sure yet。",
      "I'm going to work. 或 I'm not sure yet.",
    ],
    intent: '说明今天的一个计划或真实表达还不确定；不强迫具体内容。',
  }),
  task({
    id: 'friends-plan',
    title: '一起商量周末',
    functionId: 'plan',
    scenario: 'friends',
    kind: 'transfer',
    level: 2,
    instruction: '朋友问周末要不要出去。告诉他要看天气再决定。',
    prompt: 'Shall we go out this weekend?',
    meaning: '我们周末出去吗？',
    targetIds: ['depends', 'not-sure'],
    example: 'It depends on the weather.',
    hints: [
      '表达你还不能决定，天气会影响选择。',
      '试着用 It depends on…',
      'It depends on the weather.',
    ],
    intent: '表示是否外出取决于天气；不要求唯一词块。',
  }),
];
export function getTask(id: string) {
  const result = taskLibrary.find((t) => t.id === id);
  if (!result) throw new Error('未知的学习任务。');
  return result;
}
export function normalizeSpeech(text: string) {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}' ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export function observedItems(text: string, allowed: string[]) {
  const normalized = ` ${normalizeSpeech(text)} `;
  return allowed.filter((id) => {
    const item = inventory.find((x) => x.id === id);
    return item && normalized.includes(` ${normalizeSpeech(item.phrase)} `);
  });
}
