export type Phrase = {
  id: string;
  en: string;
  zh: string;
  pronunciation: string;
  note: string;
  prompt: string;
  answers: string[];
  options: string[];
};
export type Lesson = {
  id: number;
  title: string;
  subtitle: string;
  goal: string;
  grammar: string;
  phrases: Phrase[];
};
function phrase(
  id: string,
  en: string,
  zh: string,
  pronunciation: string,
  note: string,
  prompt: string,
  answers: string[],
  options: string[],
): Phrase {
  return { id, en, zh, pronunciation, note, prompt, answers, options };
}
export const lessons: Lesson[] = [
  {
    id: 0,
    title: '从一句 Hello 开始',
    subtitle: '打招呼与告别',
    goal: '遇到别人时，你能自然地打个招呼。',
    grammar:
      '英语句子从左往右读。第一个字母通常大写，句末加标点。先会用，不用一次记住所有规则。',
    phrases: [
      phrase(
        'hello',
        'Hello.',
        '你好。',
        '/həˈləʊ/',
        'Hello 可以在大多数见面场合使用。H 是大写的 h；两个 l 要都写出来。',
        '见到新朋友，说一句「你好」。',
        ['hello', 'hi'],
        ['你好。', '谢谢。', '再见。'],
      ),
      phrase(
        'bye',
        'Bye.',
        '再见。',
        '/baɪ/',
        '离开时用 Bye。它和 Hello 的使用时机相反。',
        '准备离开，和朋友说「再见」。',
        ['bye', 'goodbye'],
        ['早上好。', '再见。', '你好。'],
      ),
      phrase(
        'thanks',
        'Thank you.',
        '谢谢你。',
        '/ˈθæŋk juː/',
        '别人帮了你，就说 Thank you。th 发音时，舌尖轻放在上下牙之间，送气。',
        '朋友帮你开了门，你想说「谢谢你」。',
        ['thank you', 'thanks'],
        ['谢谢你。', '我很好。', '对不起。'],
      ),
    ],
  },
  {
    id: 1,
    title: '让我们认识一下',
    subtitle: '说出自己的名字',
    goal: '你可以用完整句子介绍自己。',
    grammar: 'I 表示「我」，无论在哪里都大写。I am 可以缩写成 I’m，意思不变。',
    phrases: [
      phrase(
        'iam',
        'I am Alex.',
        '我是 Alex。',
        '/aɪ æm ˈælɪks/',
        'I = 我；am 在这里连接「我」和名字。Alex 是练习用的名字。',
        '假设你叫 Alex，请介绍自己。',
        ['i am alex', "i'm alex"],
        ['我是 Alex。', '他是 Alex。', '你是 Alex 吗？'],
      ),
      phrase(
        'myname',
        'My name is Alex.',
        '我的名字是 Alex。',
        '/maɪ neɪm ɪz ˈælɪks/',
        'My name 表示「我的名字」。名字前用 is。',
        '用 My name 开头，说「我的名字是 Alex」。',
        ['my name is alex'],
        ['你叫什么？', '我的名字是 Alex。', '你好，Alex。'],
      ),
      phrase(
        'meet',
        'Nice to meet you.',
        '很高兴认识你。',
        '/naɪs tə miːt juː/',
        '第一次认识一个人时可以用这句话。先把它作为一个整体记住。',
        '第一次见面，说「很高兴认识你」。',
        ['nice to meet you', "it's nice to meet you"],
        ['很高兴认识你。', '我想喝水。', '再见。'],
      ),
    ],
  },
  {
    id: 2,
    title: '是你吗？',
    subtitle: '提问与简单回答',
    goal: '你会问一个简单问题，并回答是或不是。',
    grammar:
      'You are Alex. 是陈述。把 are 放到 you 前面，Are you Alex? 就变成了问题。',
    phrases: [
      phrase(
        'areyou',
        'Are you Alex?',
        '你是 Alex 吗？',
        '/ɑː juː ˈælɪks/',
        '提问时把 Are 放在前面，句末使用问号。',
        '向对方确认「你是 Alex 吗？」',
        ['are you alex'],
        ['我是 Alex。', '你是 Alex 吗？', 'Alex 在哪里？'],
      ),
      phrase(
        'yes',
        'Yes, I am.',
        '是的，我是。',
        '/jes aɪ æm/',
        '回答 Are you…? 时，从对方的 you 换成自己的 I。',
        '对方问你是不是 Alex。你是，应该怎么回答？',
        ['yes i am'],
        ['不是，我不是。', '是的，我是。', '我是老师。'],
      ),
      phrase(
        'no',
        'No, I am not.',
        '不，我不是。',
        '/nəʊ aɪ æm nɒt/',
        'not 表示否定。I am not 也可以写成 I’m not。',
        '对方认错人了。说「不，我不是」。',
        ['no i am not', "no i'm not"],
        ['不，我不是。', '很高兴认识你。', '请再说一次。'],
      ),
    ],
  },
  {
    id: 3,
    title: '今天感觉怎么样',
    subtitle: '表达自己的状态',
    goal: '用一句话告诉别人你的感受。',
    grammar: 'I am 后面可以放名字，也可以放描述状态的词，例如 happy（开心）。',
    phrases: [
      phrase(
        'fine',
        "I'm fine.",
        '我很好。',
        '/aɪm faɪn/',
        'I’m = I am。fine 在这里表示状态不错。',
        '朋友问你怎么样，回答「我很好」。',
        ["i'm fine", 'i am fine'],
        ['我很累。', '我很好。', '我很开心。'],
      ),
      phrase(
        'happy',
        "I'm happy.",
        '我很开心。',
        '/aɪm ˈhæpi/',
        '把 fine 换成 happy，就能说另一种心情。',
        '今天有件开心的事，告诉朋友「我很开心」。',
        ["i'm happy", 'i am happy'],
        ['我很开心。', '我很好。', '我很累。'],
      ),
      phrase(
        'tired',
        "I'm tired.",
        '我很累。',
        '/aɪm ˈtaɪəd/',
        'tired 表示疲倦。只换一个词，就能表达新意思。',
        '忙了一天，告诉朋友「我很累」。',
        ["i'm tired", 'i am tired'],
        ['我想喝水。', '我很累。', '我喜欢茶。'],
      ),
    ],
  },
  {
    id: 4,
    title: '说说身边的小东西',
    subtitle: '介绍物品',
    goal: '指着眼前的东西，说清它是什么。',
    grammar: 'This is… 表示「这是……」。a 表示一个，放在单数可数名词前。',
    phrases: [
      phrase(
        'pen',
        'This is a pen.',
        '这是一支笔。',
        '/ðɪs ɪz ə pen/',
        'pen 是笔。这里不能省略 a。',
        '指着一支笔，说「这是一支笔」。',
        ['this is a pen'],
        ['这是一本书。', '这是一支笔。', '这是一个杯子。'],
      ),
      phrase(
        'book',
        'This is a book.',
        '这是一本书。',
        '/ðɪs ɪz ə bʊk/',
        '把 pen 换成 book（书），句型保持不变。',
        '指着一本书，说「这是一本书」。',
        ['this is a book'],
        ['这是一本书。', '我有一本书。', '我喜欢书。'],
      ),
      phrase(
        'cup',
        'This is a cup.',
        '这是一个杯子。',
        '/ðɪs ɪz ə kʌp/',
        'cup 是杯子。英语中都用 a，中文会说一个、一本、一支。',
        '指着一个杯子，说「这是一个杯子」。',
        ['this is a cup'],
        ['这是一个杯子。', '我想喝水。', '这是一支笔。'],
      ),
    ],
  },
  {
    id: 5,
    title: '一杯水，也能自己要',
    subtitle: '表达需要',
    goal: '礼貌地提出一个简单需求。',
    grammar:
      'I want… 表示「我想要……」。加 please 会更礼貌。water 和 tea 在这里不加 a。',
    phrases: [
      phrase(
        'water',
        'I want water, please.',
        '我想要水，谢谢。',
        '/aɪ wɒnt ˈwɔːtə pliːz/',
        'water 表示水。please 可以放句末，用逗号隔开。',
        '用 I want 开头，礼貌地说你想要水。',
        ['i want water please', 'please i want water'],
        ['我喜欢水。', '我想要水，谢谢。', '这是一杯水。'],
      ),
      phrase(
        'tea',
        'I want tea, please.',
        '我想要茶，谢谢。',
        '/aɪ wɒnt tiː pliːz/',
        'tea 表示茶。保持句型不变，只换想要的东西。',
        '用 I want 开头，礼貌地说你想要茶。',
        ['i want tea please', 'please i want tea'],
        ['我想要茶，谢谢。', '我不喜欢茶。', '我想要水，谢谢。'],
      ),
      phrase(
        'please',
        'Please.',
        '请。',
        '/pliːz/',
        'please 用来礼貌地提出请求；thank you 用来感谢。',
        '用一个单词表达「请」。',
        ['please'],
        ['谢谢。', '再见。', '请。'],
      ),
    ],
  },
  {
    id: 6,
    title: '聊聊你喜欢的',
    subtitle: '喜好与否定',
    goal: '表达喜欢和不喜欢。',
    grammar:
      'I like… = 我喜欢……。I don’t like… = 我不喜欢……。don’t 是 do not 的缩写。',
    phrases: [
      phrase(
        'like',
        'I like tea.',
        '我喜欢茶。',
        '/aɪ laɪk tiː/',
        'like 是喜欢。这里不用 am：I like，而不是 I am like。',
        '告诉朋友「我喜欢茶」。',
        ['i like tea'],
        ['我想要茶。', '我喜欢茶。', '我不喜欢茶。'],
      ),
      phrase(
        'dont',
        "I don't like coffee.",
        '我不喜欢咖啡。',
        '/aɪ dəʊnt laɪk ˈkɒfi/',
        'coffee 是咖啡。don’t 放在 like 前面表示不喜欢。',
        '告诉朋友「我不喜欢咖啡」。',
        ["i don't like coffee", 'i do not like coffee'],
        ['我不喜欢咖啡。', '我想要咖啡。', '我喜欢咖啡。'],
      ),
      phrase(
        'music',
        'I like music.',
        '我喜欢音乐。',
        '/aɪ laɪk ˈmjuːzɪk/',
        'music 表示音乐。I like 还可以接很多你喜欢的事物。',
        '告诉朋友「我喜欢音乐」。',
        ['i like music'],
        ['我会唱歌。', '我喜欢音乐。', '我很开心。'],
      ),
    ],
  },
  {
    id: 7,
    title: '没听懂，也能继续聊',
    subtitle: '求助与综合练习',
    goal: '在对话卡住时，主动请求帮助。',
    grammar:
      '不会时也可以用英语求助。把这些短句练熟，再用前面学过的句子接着聊。',
    phrases: [
      phrase(
        'understand',
        "I don't understand.",
        '我不明白。',
        '/aɪ dəʊnt ˌʌndəˈstænd/',
        'understand 表示理解。don’t 再次帮助你表达否定。',
        '你没听懂对方的意思，说「我不明白」。',
        ["i don't understand", 'i do not understand'],
        ['我不喜欢。', '我不明白。', '我很好。'],
      ),
      phrase(
        'again',
        'Please say it again.',
        '请再说一次。',
        '/pliːz seɪ ɪt əˈɡen/',
        'say = 说；again = 再一次。先按整句学习。',
        '你没有听清，请对方再说一次。',
        ['please say it again', 'say it again please'],
        ['请再说一次。', '请给我水。', '请慢一点。'],
      ),
      phrase(
        'slowly',
        'Please speak slowly.',
        '请说慢一点。',
        '/pliːz spiːk ˈsləʊli/',
        'slowly 表示慢慢地。可以在真实对话中直接使用。',
        '对方说得太快，请对方说慢一点。',
        ['please speak slowly', 'speak slowly please'],
        ['请再说一次。', '请说慢一点。', '很高兴认识你。'],
      ),
    ],
  },
];
export const allPhrases = lessons.flatMap((l) => l.phrases);
export function normalizeAnswer(value: string) {
  return value
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[.,!?，。！？]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
export function isCorrect(phrase: Phrase, answer: string) {
  return phrase.answers.some(
    (a) => normalizeAnswer(a) === normalizeAnswer(answer),
  );
}
