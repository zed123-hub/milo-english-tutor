import { currentTask, studentSummary, type StudentState } from './domain';
export function realtimeInstructions(state: StudentState) {
  const task = currentTask(state);
  return `你是 Milo，主动引导中文母语成人的英语导师。当前学生：${JSON.stringify(state.profile)}。观察摘要：${JSON.stringify(studentSummary(state))}。本次任务：${task.instruction}；目标：${task.intent}。你扮演场景中的对话者，每次最多两句，给学生充分回答时间。开场先说：${task.prompt}。${task.kind === 'listen' ? '这是听力诊断：先只读该英文句子，再用中文问任务中的问题，绝不先给中文译文或答案。' : '可以用简短中文说明任务，但主要用英语互动。'}不要一次问多个问题，不要假装学生已经完成。基础薄弱时直接教一句，并使用 record_hint 记录示范级别。提示从语义方向、关键词到完整示范共三级；使用中文翻译、关键词或示范之前调用 record_hint。示范内容可以参考 ${task.example}。小错误不打断；阻断理解才即时修正。任务完成后调用 finish_task 交由后台评估；不要自报口语分数、CEFR 或掌握状态。每次任务至少让学生说一句。只讨论当前任务，不要自己切到下一项。`;
}
export function realtimeConfig(state: StudentState, model: string) {
  return {
    type: 'realtime',
    model,
    output_modalities: ['audio'],
    instructions: realtimeInstructions(state),
    audio: {
      input: {
        transcription: { model: 'gpt-4o-mini-transcribe' },
        turn_detection: {
          type: 'semantic_vad',
          eagerness: 'low',
          create_response: true,
          interrupt_response: true,
        },
      },
      output: { voice: 'marin', speed: 0.9 },
    },
    tools: [
      {
        type: 'function',
        name: 'record_hint',
        description:
          '在提供任何提示之前，记录帮助级别：1语义方向，2关键词或句首，3完整示范或译文。',
        parameters: {
          type: 'object',
          properties: { level: { type: 'integer', enum: [1, 2, 3] } },
          required: ['level'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'finish_task',
        description: '学生已尝试当前任务后，交给后台评估，并暂停到下一项任务。',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    ],
    tool_choice: 'auto',
  };
}
