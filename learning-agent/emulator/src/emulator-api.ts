import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../../../shared/db';
import { createChatCompletion } from '../../../shared/openai';
import { logger } from '../../../shared/logger';

/**
 * User Emulator API v0.3.0
 *
 * Generates synthetic Student/Mentor dialogs.
 *
 * TWO MODES:
 * - DIRECT: OpenAI direct calls (no memory between dialogs)
 * - PIPELINE: Routes through MaaS pipeline (uses LSM memory!)
 *
 * Endpoints:
 * - POST /api/emulator/generate    - Generate dialogs
 * - GET  /api/emulator/status      - Get current status
 * - POST /api/emulator/mode        - Set mode (direct/pipeline)
 */

const router = Router();

// Emulation mode
type EmulationMode = 'direct' | 'pipeline';
let currentMode: EmulationMode = 'direct';

interface EmulationConfig {
  studentPrompt: string;
  mentorPrompt: string;
  topic: string;
  dialogCount: number;
  turnsPerDialog: number;
  mode?: EmulationMode;
}

interface GeneratedMessage {
  role: 'student' | 'mentor';
  content: string;
  timestamp: string;
  user_id: string;
  source: 'direct' | 'pipeline';
}

interface GeneratedDialog {
  dialog_id: string;
  topic: string;
  messages: GeneratedMessage[];
  created_at: string;
}

// Active emulation state
let isEmulating = false;
let currentEmulation: {
  config: EmulationConfig;
  progress: number;
  total: number;
  dialogs: GeneratedDialog[];
  mode: EmulationMode;
} | null = null;

/**
 * POST /api/emulator/mode
 * Set emulation mode
 */
router.post('/mode', (req: Request, res: Response) => {
  const { mode } = req.body;

  if (mode !== 'direct' && mode !== 'pipeline') {
    return res.status(400).json({
      success: false,
      error: 'Некорректный режим. Используй "direct" или "pipeline"'
    });
  }

  currentMode = mode;
  logger.info(`[Emulator] Mode set to: ${mode}`);

  res.json({
    success: true,
    mode: currentMode,
    description: mode === 'pipeline'
      ? 'Ответы ментора идут через MaaS pipeline с LSM-памятью'
      : 'Прямые вызовы OpenAI без памяти между диалогами'
  });
});

/**
 * GET /api/emulator/mode
 * Get current mode
 */
router.get('/mode', (req: Request, res: Response) => {
  res.json({
    success: true,
    mode: currentMode,
    description: currentMode === 'pipeline'
      ? 'Конвейер: используется память MaaS'
      : 'Прямой режим: без памяти между диалогами'
  });
});

/**
 * POST /api/emulator/generate
 * Generate Student/Mentor dialogs
 */
router.post('/generate', async (req: Request, res: Response) => {
  if (isEmulating) {
    return res.status(409).json({
      success: false,
      error: 'Эмуляция уже выполняется',
      progress: currentEmulation?.progress,
      total: currentEmulation?.total
    });
  }

  const mode = req.body.mode || currentMode;

  const config: EmulationConfig = {
    studentPrompt: req.body.studentPrompt || 'Ты любознательный ученик, который изучает программирование. Отвечай на русском.',
    mentorPrompt: req.body.mentorPrompt || 'Ты опытный ментор по программированию. Отвечай на русском.',
    topic: req.body.topic || 'Общие концепции программирования',
    dialogCount: Math.min(req.body.dialogCount || 3, 10),
    turnsPerDialog: Math.min(req.body.turnsPerDialog || 4, 10),
    mode
  };

  // In pipeline mode, use SAME user_id across dialogs for memory!
  // In direct mode, fresh IDs each time
  const studentUserId = uuidv4();
  const mentorUserId = mode === 'pipeline' ? studentUserId : uuidv4(); // Pipeline: same user for memory

  logger.info('[Emulator] Starting generation', {
    mode,
    topic: config.topic,
    dialogs: config.dialogCount,
    turns: config.turnsPerDialog,
    studentUserId,
    mentorUserId
  });

  isEmulating = true;
  currentEmulation = {
    config,
    progress: 0,
    total: config.dialogCount,
    dialogs: [],
    mode
  };

  try {
    const dialogs: GeneratedDialog[] = [];

    for (let d = 0; d < config.dialogCount; d++) {
      currentEmulation.progress = d + 1;

      const dialog = await generateDialog(
        config,
        studentUserId,
        mentorUserId,
        d + 1,
        mode
      );

      dialogs.push(dialog);
      currentEmulation.dialogs.push(dialog);
    }

    logger.info('[Emulator] Generation complete', {
      mode,
      dialogsGenerated: dialogs.length,
      totalMessages: dialogs.reduce((sum, d) => sum + d.messages.length, 0)
    });

    res.json({
      success: true,
      mode,
      config: {
        topic: config.topic,
        dialogCount: config.dialogCount,
        turnsPerDialog: config.turnsPerDialog
      },
      userIds: {
        student: studentUserId,
        mentor: mentorUserId
      },
      dialogs
    });
  } catch (error: any) {
    logger.error('[Emulator] Generation failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    isEmulating = false;
    currentEmulation = null;
  }
});

/**
 * GET /api/emulator/status
 * Get current emulation status
 */
router.get('/status', (req: Request, res: Response) => {
  res.json({
    success: true,
    isEmulating,
    mode: currentEmulation?.mode || currentMode,
    progress: currentEmulation?.progress || 0,
    total: currentEmulation?.total || 0,
    dialogsCompleted: currentEmulation?.dialogs.length || 0
  });
});

/**
 * Generate a single dialog with multiple turns
 */
async function generateDialog(
  config: EmulationConfig,
  studentUserId: string,
  mentorUserId: string,
  dialogNumber: number,
  mode: EmulationMode
): Promise<GeneratedDialog> {
  const dialogId = uuidv4();
  const messages: GeneratedMessage[] = [];
  const conversationHistory: Array<{ role: 'student' | 'mentor'; content: string }> = [];

  logger.info(`[Emulator] Generating dialog #${dialogNumber} (${mode} mode)...`);

  for (let turn = 0; turn < config.turnsPerDialog; turn++) {
    // 1. Generate student message (direct OR pipeline)
    let studentMessage: string;
    let studentSource: 'direct' | 'pipeline';

    if (mode === 'pipeline') {
      // Route through MaaS pipeline - both roles use MaaS!
      // Include the meta-prompt so MaaS knows the role
      const studentQuery = turn === 0
        ? `[ИНСТРУКЦИЯ РОЛИ: ${config.studentPrompt}]\n\nТема: ${config.topic}\n\nСгенерируй первый вопрос ученика по этой теме. Пиши только по-русски.`
        : `[ИНСТРУКЦИЯ РОЛИ: ${config.studentPrompt}]\n\nТема: ${config.topic}\n\nСгенерируй следующий уточняющий вопрос ученика. Пиши только по-русски.`;

      studentMessage = await getResponseViaPipeline(studentUserId, studentQuery, 'student');
      studentSource = 'pipeline';
    } else {
      // Direct OpenAI call - no memory
      studentMessage = await generateStudentMessage(
        config.studentPrompt,
        config.topic,
        conversationHistory,
        turn === 0
      );
      studentSource = 'direct';
      await storeMessage(studentUserId, 'student', studentMessage, dialogId, turn);
    }

    const studentMsg: GeneratedMessage = {
      role: 'student',
      content: studentMessage,
      timestamp: new Date().toISOString(),
      user_id: studentUserId,
      source: studentSource
    };
    messages.push(studentMsg);
    conversationHistory.push({ role: 'student', content: studentMessage });

    // 2. Generate mentor response (direct OR pipeline)
    let mentorMessage: string;
    let mentorSource: 'direct' | 'pipeline';

    if (mode === 'pipeline') {
      // Route through MaaS pipeline - both roles use MaaS!
      // Include the meta-prompt so MaaS knows the role
      const mentorQuery = `[ИНСТРУКЦИЯ РОЛИ: ${config.mentorPrompt}]\n\nВопрос ученика: "${studentMessage}"\n\nОтветь как ментор. Пиши только по-русски.`;

      mentorMessage = await getResponseViaPipeline(studentUserId, mentorQuery, 'mentor');
      mentorSource = 'pipeline';
    } else {
      // Direct OpenAI call - no memory
      mentorMessage = await generateMentorMessage(
        config.mentorPrompt,
        config.topic,
        conversationHistory
      );
      mentorSource = 'direct';
      await storeMessage(studentUserId, 'mentor', mentorMessage, dialogId, turn);
    }

    const mentorMsg: GeneratedMessage = {
      role: 'mentor',
      content: mentorMessage,
      timestamp: new Date().toISOString(),
      user_id: studentUserId,
      source: mentorSource
    };
    messages.push(mentorMsg);
    conversationHistory.push({ role: 'mentor', content: mentorMessage });
  }

  return {
    dialog_id: dialogId,
    topic: config.topic,
    messages,
    created_at: new Date().toISOString()
  };
}

/**
 * Get response via MaaS pipeline (with memory!)
 * Used for both Student and Mentor roles
 */
async function getResponseViaPipeline(
  userId: string,
  query: string,
  role: 'student' | 'mentor',
  timeoutMs: number = 60000
): Promise<string> {
  logger.info(`[Emulator] Routing ${role} to MaaS pipeline...`);

  // 1. Insert into pipeline_runs
  const result = await pool.query(
    `INSERT INTO pipeline_runs (user_id, user_query, status)
     VALUES ($1, $2, 'NEW')
     RETURNING id`,
    [userId, query]
  );
  const pipelineRunId = result.rows[0].id;

  logger.info(`[Emulator] Created pipeline_run: ${pipelineRunId}`);

  // 2. Wait for completion
  const startTime = Date.now();
  const pollInterval = 500;

  while (Date.now() - startTime < timeoutMs) {
    const statusResult = await pool.query(
      'SELECT status, final_answer, error_message FROM pipeline_runs WHERE id = $1',
      [pipelineRunId]
    );

    const row = statusResult.rows[0];

    if (row.status === 'COMPLETED') {
      logger.info(`[Emulator] Pipeline completed in ${Date.now() - startTime}ms`);
      return row.final_answer || 'Ответ не был сгенерирован';
    }

    if (row.status === 'FAILED') {
      throw new Error(`Pipeline завершился с ошибкой: ${row.error_message}`);
    }

    // Still processing
    await sleep(pollInterval);
  }

  throw new Error(`Pipeline не ответил за ${timeoutMs}мс. Orchestrator запущен?`);
}

/**
 * Generate a student message (direct OpenAI)
 */
async function generateStudentMessage(
  metaPrompt: string,
  topic: string,
  history: Array<{ role: string; content: string }>,
  isFirst: boolean
): Promise<string> {
  const systemPrompt = `${metaPrompt}

Ты ведешь учебный диалог на тему: ${topic}

Правила:
- Задавай живые вопросы, в которых видно любопытство
- Опирайся на предыдущие ответы в диалоге
- Показывай, если тебе что-то непонятно или нужно уточнение
- Пиши кратко: максимум 2-3 предложения
- Пиши только по-русски
${isFirst ? '- Начни разговор с того, что именно хочешь понять' : '- Продолжи разговор естественно'}`;

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt }
  ];

  for (const msg of history) {
    messages.push({
      role: msg.role === 'student' ? 'assistant' : 'user',
      content: msg.content
    });
  }

  if (!isFirst) {
    messages.push({
      role: 'user',
      content: 'Продолжи как ученик. Что бы ты сказал или спросил дальше? Ответь по-русски.'
    });
  }

  const response = await createChatCompletion({
    model: 'gpt-4o-mini',
    messages,
    temperature: 0.8,
    max_tokens: 200
  });

  return response.trim();
}

/**
 * Generate a mentor response (direct OpenAI - no memory)
 */
async function generateMentorMessage(
  metaPrompt: string,
  topic: string,
  history: Array<{ role: string; content: string }>
): Promise<string> {
  const systemPrompt = `${metaPrompt}

Ты ведешь обучающий диалог на тему: ${topic}

Правила:
- Направляй вопросами, а не только готовыми ответами
- Помогай ученику самому находить понимание
- Поддерживай, но оставайся точным
- Пиши кратко: максимум 2-4 предложения
- Пиши только по-русски`;

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt }
  ];

  for (const msg of history) {
    messages.push({
      role: msg.role === 'student' ? 'user' : 'assistant',
      content: msg.content
    });
  }

  const response = await createChatCompletion({
    model: 'gpt-4o-mini',
    messages,
    temperature: 0.7,
    max_tokens: 300
  });

  return response.trim();
}

/**
 * Store message in raw_logs table
 */
async function storeMessage(
  userId: string,
  role: string,
  content: string,
  dialogId: string,
  turn: number
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO raw_logs (user_id, log_type, log_data)
       VALUES ($1, $2, $3)`,
      [
        userId,
        'EMULATED_MESSAGE',
        JSON.stringify({
          role: role === 'student' ? 'user' : 'assistant',
          content,
          source: 'emulator',
          dialog_id: dialogId,
          turn,
          emulated_role: role
        })
      ]
    );
  } catch (error: any) {
    logger.error('[Emulator] Failed to store message', error);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default router;
