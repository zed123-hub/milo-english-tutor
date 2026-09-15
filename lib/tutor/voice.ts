export type Recognizer = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((e: {
        resultIndex: number;
        results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
      }) => void)
    | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
export function speechRecognizer() {
  const w = window as unknown as {
    SpeechRecognition?: new () => Recognizer;
    webkitSpeechRecognition?: new () => Recognizer;
  };
  const Constructor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Constructor ? new Constructor() : null;
}
export type RealtimeMessage = {
  type: string;
  item_id?: string;
  transcript?: string;
  delta?: string;
  response?: {
    status: string;
    output?: {
      type: string;
      name: string;
      call_id: string;
      arguments: string;
    }[];
  };
};
export function completedTools(event: RealtimeMessage) {
  if (event.type !== 'response.done' || event.response?.status !== 'completed')
    return [];
  return (event.response.output ?? []).filter(
    (item) =>
      item.type === 'function_call' &&
      ['record_hint', 'finish_task'].includes(item.name),
  );
}
