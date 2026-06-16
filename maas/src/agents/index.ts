/**
 * Agent Implementations
 *
 * ✅ Analyzer - реальный поиск в LSM через keyword matching
 * ✅ Assembler - реальная сборка контекста из LSM + raw_logs
 * ✅ FinalResponder - реальный вызов OpenAI с полным контекстом памяти
 *
 * Все агенты полностью функциональны и протестированы.
 */

import { pool } from '../../../shared/db';
import { logger } from '../../../shared/logger';
import { createChatCompletion } from '../../../shared/openai';

/**
 * Helper: Sleep function
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Analyzer Agent - Memory Retriever
 *
 * Задача: Найти релевантные воспоминания из LSM
 * Статусы: NEW → ANALYZING → ANALYZED
 *
 * Текущая реализация (v0.2):
 * - Извлекает keywords из user_query
 * - Ищет в lsm_storage через semantic_tags && keywords (PostgreSQL array overlap)
 * - Возвращает до 3 релевантных memories
 * - Сохраняет результат в analysis_result
 *
 * TODO v0.3: Vector search для семантического поиска
 */
export async function runAnalyzer(pipelineId: string): Promise<void> {
  logger.info(`[Analyzer] 🔍 Starting for ${pipelineId}`);

  try {
    // Идемпотентный захват задачи
    const result = await pool.query(
      `UPDATE pipeline_runs
       SET status = 'ANALYZING', updated_at = NOW()
       WHERE id = $1 AND status = 'NEW'
       RETURNING *`,
      [pipelineId]
    );

    if (result.rowCount === 0) {
      logger.warn(`[Analyzer] Task ${pipelineId} already taken or invalid status`);
      return;
    }

    const run = result.rows[0];
    logger.info(`[Analyzer] Processing query: "${run.user_query.substring(0, 50)}..."`);

    // Extract semantic keywords using LLM (v0.2)
    const keywords = await extractSemanticKeywords(run.user_query);
    logger.info(`[Analyzer] Extracted keywords: [${keywords.join(', ')}]`);

    // Search LSM for relevant memories (v0.2: keyword-based search)
    // Fetch recent user memories, then filter weak one-tag matches in code.
    const memoryResult = await pool.query(
      `SELECT summary_text, semantic_tags, time_bucket
       FROM lsm_storage
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [run.user_id]
    );

    const normalizedKeywords = keywords.map(keyword => keyword.toLowerCase());
    const memories = memoryResult.rows
      .map(row => {
        const semanticTags = row.semantic_tags || [];
        const overlapCount = semanticTags
          .map((tag: string) => tag.toLowerCase())
          .filter((tag: string) =>
            normalizedKeywords.some(keyword => tag.includes(keyword) || keyword.includes(tag))
          )
          .length;

        return {
          summary_text: row.summary_text,
          semantic_tags: semanticTags,
          time_bucket: row.time_bucket,
          overlap_count: overlapCount
        };
      })
      .filter(memory => memory.overlap_count >= MIN_MEMORY_TAG_OVERLAP)
      .slice(0, 3)
      .map(({ overlap_count: _overlapCount, ...memory }) => memory);

    logger.info(`[Analyzer] Found ${memories.length} relevant memories from LSM (${keywords.length} keywords)`);

    // Результат анализа (формат для Assembler)
    const analysis = {
      memories,
      search_keywords: keywords,
      timestamp: new Date().toISOString(),
    };

    // Сохранение результата
    await pool.query(
      `UPDATE pipeline_runs
       SET
         analysis_result = $1,
         status = 'ANALYZED',
         updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(analysis), pipelineId]
    );

    logger.info(`[Analyzer] ✅ Completed for ${pipelineId}`);
  } catch (error) {
    logger.error(`[Analyzer] ❌ Error for ${pipelineId}:`, error);
    throw error;
  }
}

/**
 * Extract semantic keywords from query using LLM (v0.2)
 *
 * Uses AI to understand the semantic meaning and extract
 * relevant topic tags that would match stored memories.
 */
async function extractSemanticKeywords(query: string): Promise<string[]> {
  try {
    const response = await createChatCompletion({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a keyword extractor. Given a user query, extract 3-7 semantic topic tags that capture the main concepts.

Rules:
- Output ONLY a JSON array of lowercase strings
- Include both specific terms AND broader topic categories
- Think about what topics this query relates to
- Include synonyms and related concepts

Example:
Query: "How does factorial work in recursion?"
Output: ["factorial", "recursion", "mathematics", "programming", "functions", "algorithms"]

Query: "What's the call stack?"
Output: ["call stack", "stack", "memory", "programming", "functions", "execution"]`
        },
        {
          role: 'user',
          content: query
        }
      ],
      temperature: 0.3,
      max_tokens: 100
    });

    // Parse JSON array from response
    const match = response.match(/\[[\s\S]*\]/);
    if (match) {
      const tags = JSON.parse(match[0]);
      logger.info(`[Analyzer] LLM extracted tags: [${tags.join(', ')}]`);
      return tags;
    }
  } catch (error) {
    logger.warn(`[Analyzer] LLM extraction failed, falling back to simple:`, error);
  }

  // Fallback to simple extraction
  return extractSimpleKeywords(query);
}

/**
 * Simple keyword extraction (fallback)
 */
function extractSimpleKeywords(query: string): string[] {
  const stopWords = ['the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'how', 'when', 'where', 'why', 'to', 'for', 'of', 'in', 'on', 'at'];

  const words = query.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.includes(w));

  return [...new Set(words)];
}

/**
 * Assembler Agent - Context Builder v2
 *
 * Задача: Сборка контекста для LLM согласно /context/format.md
 * Статусы: ANALYZED → ASSEMBLING → READY
 *
 * Реализация v2.0:
 * - Читает analysis_result от Analyzer (memories из LSM)
 * - Приоритизирует memories по релевантности и свежести
 * - Читает последние диалоги из raw_logs
 * - Применяет лимит токенов (~4000 токенов для контекста)
 * - Собирает контекст: SYSTEM ROLE + PREVIOUS CONTEXT (LSM) + RECENT CONVERSATION + CURRENT QUERY
 * - Сохраняет в final_context_payload для FinalResponder
 */

// Constants for token management
const MAX_CONTEXT_TOKENS = 4000; // Leave room for response
const CHARS_PER_TOKEN = 4; // Rough estimate: 1 token ≈ 4 chars
const MIN_MEMORY_TAG_OVERLAP = 2;

export async function runAssembler(pipelineId: string): Promise<void> {
  logger.info(`[Assembler] 📦 Starting for ${pipelineId}`);

  try {
    // Идемпотентный захват
    const result = await pool.query(
      `UPDATE pipeline_runs
       SET status = 'ASSEMBLING', updated_at = NOW()
       WHERE id = $1 AND status = 'ANALYZED'
       RETURNING *`,
      [pipelineId]
    );

    if (result.rowCount === 0) {
      logger.warn(`[Assembler] Task ${pipelineId} already taken or invalid status`);
      return;
    }

    const run = result.rows[0];
    logger.info(`[Assembler] Building context for: "${run.user_query.substring(0, 50)}..."`);

    // Получить результаты анализа (от Analyzer)
    const analysis = run.analysis_result || { memories: [], search_keywords: [] };
    const searchKeywords = analysis.search_keywords || [];

    // Приоритизировать memories по релевантности
    const prioritizedMemories = prioritizeMemories(analysis.memories || [], searchKeywords);
    logger.info(`[Assembler] Prioritized ${prioritizedMemories.length} memories`);

    // Получить recent conversation из raw_logs (обработанные и свежие необработанные)
    const logsResult = await pool.query(
      `SELECT
         pipeline_run_id,
         log_type,
         log_data,
         created_at
       FROM raw_logs
       WHERE user_id = $1
         AND pipeline_run_id != $2
       ORDER BY created_at DESC
       LIMIT 20`,
      [run.user_id, pipelineId]
    );

    // Группируем логи в пары query-answer независимо от порядка UUID.
    const exchangeMap = new Map<string, { query?: string; answer?: string; created_at: Date }>();
    for (const log of logsResult.rows) {
      const exchange: { query?: string; answer?: string; created_at: Date } =
        exchangeMap.get(log.pipeline_run_id) || { created_at: log.created_at };

      if (log.created_at < exchange.created_at) {
        exchange.created_at = log.created_at;
      }

      if (log.log_type === 'USER_QUERY') {
        exchange.query = log.log_data.query;
      } else if (log.log_type === 'SYSTEM_RESPONSE') {
        exchange.answer = log.log_data.answer;
      }

      exchangeMap.set(log.pipeline_run_id, exchange);
    }

    const recentLogs: Array<{ query: string; answer: string }> = Array.from(exchangeMap.values())
      .filter((exchange): exchange is { query: string; answer: string; created_at: Date } =>
        Boolean(exchange.query && exchange.answer)
      )
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .slice(-10)
      .map(({ query, answer }) => ({ query, answer }));

    logger.info(`[Assembler] Found ${recentLogs.length} recent exchanges from raw_logs`);

    // Собрать контекст с учётом лимита токенов
    const context = buildContextWithTokenLimit(
      run.user_query,
      prioritizedMemories,
      recentLogs,
      MAX_CONTEXT_TOKENS
    );

    const estimatedTokens = Math.ceil(context.length / CHARS_PER_TOKEN);
    logger.info(`[Assembler] Context built: ${context.length} chars (~${estimatedTokens} tokens)`);

    // Сохранение результата
    await pool.query(
      `UPDATE pipeline_runs
       SET
         final_context_payload = $1,
         status = 'READY',
         updated_at = NOW()
       WHERE id = $2`,
      [context, pipelineId]
    );

    logger.info(`[Assembler] ✅ Completed for ${pipelineId}`);
  } catch (error) {
    logger.error(`[Assembler] ❌ Error for ${pipelineId}:`, error);
    throw error;
  }
}

/**
 * Prioritize memories by relevance (tag overlap) and recency
 */
function prioritizeMemories(
  memories: Array<{ summary_text: string; semantic_tags?: string[]; time_bucket?: string }>,
  searchKeywords: string[]
): Array<{ summary_text: string; semantic_tags?: string[]; time_bucket?: string; score: number }> {
  if (!memories || memories.length === 0) return [];

  return memories
    .map(memory => {
      let score = 0;

      // Score by tag overlap
      if (memory.semantic_tags && searchKeywords.length > 0) {
        const tags = memory.semantic_tags.map(t => t.toLowerCase());
        const keywords = searchKeywords.map(k => k.toLowerCase());
        const overlap = tags.filter(t => keywords.some(k => t.includes(k) || k.includes(t))).length;
        score += overlap * 10;
      }

      // Score by recency (recent weeks get bonus)
      if (memory.time_bucket) {
        const match = memory.time_bucket.match(/(\d{4})-W(\d{2})/);
        if (match) {
          const year = parseInt(match[1]);
          const week = parseInt(match[2]);
          const now = new Date();
          const currentYear = now.getFullYear();
          const currentWeek = getWeekNumber(now);

          const weeksDiff = (currentYear - year) * 52 + (currentWeek - week);
          if (weeksDiff <= 1) score += 5; // This week or last week
          else if (weeksDiff <= 4) score += 3; // Last month
          else if (weeksDiff <= 12) score += 1; // Last 3 months
        }
      }

      return { ...memory, score };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Get ISO week number
 */
function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/**
 * Build context string with token limit
 */
function buildContextWithTokenLimit(
  currentQuery: string,
  memories: Array<{ summary_text: string; score?: number }>,
  recentLogs: Array<{ query: string; answer: string }>,
  maxTokens: number
): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  let context = '';
  let remainingChars = maxChars;

  // Section 1: SYSTEM ROLE (always included, ~200 chars)
  const systemRole = `SYSTEM ROLE:\nYou are a helpful AI assistant with long-term memory of past conversations with this user.\n\n`;
  context += systemRole;
  remainingChars -= systemRole.length;

  // Section 4: CURRENT QUERY (always included, reserve space)
  const querySection = `CURRENT QUERY:\n${currentQuery}\n\nPlease respond naturally, referencing past context when relevant. If this is a follow-up about a place, carry forward the country or region from previous context explicitly.`;
  remainingChars -= querySection.length + 50; // Buffer

  // Section 2: PREVIOUS CONTEXT (from long-term memory) - prioritized
  if (memories && memories.length > 0) {
    let memorySection = `PREVIOUS CONTEXT (from long-term memory):\n`;
    let memoriesAdded = 0;

    for (const m of memories) {
      const memoryText = `• ${m.summary_text}\n`;
      if (remainingChars - memoryText.length > 500) { // Keep buffer for conversations
        memorySection += memoryText;
        remainingChars -= memoryText.length;
        memoriesAdded++;
      } else {
        break;
      }
    }

    if (memoriesAdded > 0) {
      context += memorySection + '\n';
    }
  }

  // Section 3: RECENT CONVERSATION - limit to fit
  if (recentLogs && recentLogs.length > 0) {
    let convSection = `RECENT CONVERSATION:\n`;
    let conversationsAdded = 0;

    // Add most recent conversations first (they're most relevant)
    const recentFirst = [...recentLogs].reverse();
    const toAdd: string[] = [];

    for (const log of recentFirst) {
      const convText = `User: ${log.query}\nAssistant: ${log.answer}\n\n`;
      if (remainingChars - convText.length > 100) {
        toAdd.unshift(convText); // Add to beginning to maintain chronological order
        remainingChars -= convText.length;
        conversationsAdded++;
        if (conversationsAdded >= 3) break; // Max 3 recent conversations
      } else {
        break;
      }
    }

    if (conversationsAdded > 0) {
      context += convSection + toAdd.join('');
    }
  }

  // Add current query section
  context += querySection;

  return context;
}


/**
 * Final Responder Agent Stub
 *
 * Задача: Генерация финального ответа через LLM
 * Статусы: READY → RESPONDING → COMPLETED
 */
export async function runFinalResponder(pipelineId: string): Promise<void> {
  logger.info(`[FinalResponder] 💬 Starting for ${pipelineId}`);

  try {
    // Идемпотентный захват
    const result = await pool.query(
      `UPDATE pipeline_runs
       SET status = 'RESPONDING', updated_at = NOW()
       WHERE id = $1 AND status = 'READY'
       RETURNING *`,
      [pipelineId]
    );

    if (result.rowCount === 0) {
      logger.warn(`[FinalResponder] Task ${pipelineId} already taken or invalid status`);
      return;
    }

    const run = result.rows[0];
    logger.info(`[FinalResponder] Generating response for: "${run.user_query.substring(0, 50)}..."`);

    // Получаем контекст от Assembler (если есть)
    const contextPayload = run.final_context_payload || run.user_query;

    // Вызов реального OpenAI
    logger.info('[FinalResponder] 🤖 Calling OpenAI...');
    const answer = await createChatCompletion({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful AI assistant with access to long-term memory. Provide clear, accurate, and contextual responses. Use memory only when it is directly relevant to the current query. Do not introduce unrelated remembered topics. For city/place questions, state the country or region in the first sentence when it is known from the current query or previous context.'
        },
        {
          role: 'user',
          content: contextPayload
        }
      ],
      temperature: 0.3,
      max_tokens: 2000
    });

    logger.info(`[FinalResponder] ✅ OpenAI responded (${answer.length} chars)`);

    // Логирование в raw_logs (для будущей обработки Archivist)
    logger.info(`[FinalResponder] 📝 Logging to raw_logs...`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Log 1: USER_QUERY
      await client.query(
        `INSERT INTO raw_logs (pipeline_run_id, user_id, log_type, log_data)
         VALUES ($1, $2, 'USER_QUERY', $3)`,
        [
          pipelineId,
          run.user_id,
          JSON.stringify({
            query: run.user_query,
            timestamp: new Date().toISOString()
          })
        ]
      );

      // Log 2: SYSTEM_RESPONSE
      await client.query(
        `INSERT INTO raw_logs (pipeline_run_id, user_id, log_type, log_data)
         VALUES ($1, $2, 'SYSTEM_RESPONSE', $3)`,
        [
          pipelineId,
          run.user_id,
          JSON.stringify({
            answer: answer,
            timestamp: new Date().toISOString()
          })
        ]
      );

      await client.query(
        `UPDATE pipeline_runs
         SET
           final_answer = $1,
           status = 'COMPLETED',
           updated_at = NOW()
         WHERE id = $2`,
        [answer, pipelineId]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    logger.info(`[FinalResponder] ✅ Logged 2 entries to raw_logs`);
    logger.info(`[FinalResponder] ✅ Completed for ${pipelineId}`);
  } catch (error) {
    logger.error(`[FinalResponder] ❌ Error for ${pipelineId}:`, error);
    throw error;
  }
}

/**
 * Archivist Agent - Memory Creator
 *
 * Задача: Создать долгосрочную память (LSM) из завершённых диалогов
 * Триггер: После COMPLETED (или по расписанию для batch processing)
 *
 * Текущая реализация (v1.0):
 * - Читает raw_logs для конкретного pipeline_run
 * - Суммаризирует диалог через LLM
 * - Извлекает semantic_tags через LLM
 * - Записывает в lsm_storage
 * - Помечает raw_logs как processed
 */
export async function runArchivist(pipelineId: string): Promise<void> {
  logger.info(`[Archivist] 📚 Starting for ${pipelineId}`);

  try {
    // 1. Получить данные pipeline_run
    const pipelineResult = await pool.query(
      `SELECT user_id, user_query, final_answer
       FROM pipeline_runs
       WHERE id = $1 AND status = 'COMPLETED'`,
      [pipelineId]
    );

    if (pipelineResult.rowCount === 0) {
      logger.warn(`[Archivist] Pipeline ${pipelineId} not found or not completed`);
      return;
    }

    const pipeline = pipelineResult.rows[0];
    logger.info(`[Archivist] Processing dialog for user ${pipeline.user_id}`);

    // 2. Читать raw_logs для этого pipeline (ещё не обработанные)
    const logsResult = await pool.query(
      `SELECT id, log_type, log_data
       FROM raw_logs
       WHERE pipeline_run_id = $1
         AND processed = false
       ORDER BY created_at ASC`,
      [pipelineId]
    );

    if (logsResult.rowCount === 0) {
      logger.info(`[Archivist] No unprocessed logs for ${pipelineId}`);
      return;
    }

    const logs = logsResult.rows;
    logger.info(`[Archivist] Found ${logs.length} unprocessed logs`);

    // 3. Собрать диалог для суммаризации
    const dialogText = logs.map(log => {
      if (log.log_type === 'USER_QUERY') {
        return `User: ${log.log_data.query}`;
      } else if (log.log_type === 'SYSTEM_RESPONSE') {
        return `Assistant: ${log.log_data.answer}`;
      }
      return '';
    }).filter(Boolean).join('\n\n');

    logger.info(`[Archivist] Dialog text: ${dialogText.length} chars`);

    // 4. Вызвать LLM для суммаризации и извлечения тегов
    logger.info(`[Archivist] 🤖 Calling LLM for summarization...`);

    const archivistPrompt = `You are an archivist. Analyze this conversation and create a memory record.

CONVERSATION:
${dialogText}

Respond in JSON format with exactly these fields:
{
  "summary": "A 1-2 sentence summary of what was discussed, focusing on key facts and user preferences",
  "tags": ["tag1", "tag2", "tag3"] // 3-5 relevant keywords/topics as lowercase strings
}

Important:
- Summary should capture the essence of the conversation
- Tags should be useful for future retrieval (topics, entities, preferences mentioned)
- Keep tags simple and lowercase (e.g., "programming", "preferences", "typescript")`;

    const llmResponse = await createChatCompletion({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: archivistPrompt }
      ],
      temperature: 0.3, // Lower temperature for more consistent JSON
      max_tokens: 500
    });

    logger.info(`[Archivist] LLM responded: ${llmResponse.length} chars`);

    // 5. Парсить JSON ответ
    let archiveData: { summary: string; tags: string[] };
    try {
      // Извлечь JSON из ответа (может быть обёрнут в markdown)
      const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }
      archiveData = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      logger.error(`[Archivist] Failed to parse LLM response:`, llmResponse);
      // Fallback: создать базовую запись
      archiveData = {
        summary: `Dialog about: ${pipeline.user_query.substring(0, 100)}`,
        tags: extractSimpleKeywords(pipeline.user_query)
      };
    }

    logger.info(`[Archivist] Summary: "${archiveData.summary.substring(0, 80)}..."`);
    logger.info(`[Archivist] Tags: [${archiveData.tags.join(', ')}]`);

    // 6. Вычислить time_bucket (ISO week format: 2025-W47)
    const now = new Date();
    const timeBucket = getISOWeek(now);
    logger.info(`[Archivist] Time bucket: ${timeBucket}`);

    // 7. Записать в lsm_storage
    const logIds = logs.map(l => l.id);

    await pool.query(
      `INSERT INTO lsm_storage (user_id, time_bucket, semantic_tags, summary_text, source_run_ids)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        pipeline.user_id,
        timeBucket,
        archiveData.tags,
        archiveData.summary,
        [pipelineId] // source_run_ids - массив UUID
      ]
    );

    logger.info(`[Archivist] ✅ Created LSM record`);

    // 8. Пометить raw_logs как обработанные
    await pool.query(
      `UPDATE raw_logs
       SET processed = true, processed_at = NOW()
       WHERE id = ANY($1)`,
      [logIds]
    );

    logger.info(`[Archivist] ✅ Marked ${logIds.length} logs as processed`);
    logger.info(`[Archivist] ✅ Completed for ${pipelineId}`);

  } catch (error) {
    logger.error(`[Archivist] ❌ Error for ${pipelineId}:`, error);
    throw error;
  }
}

/**
 * Get ISO week string (e.g., "2025-W47")
 */
function getISOWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${weekNo.toString().padStart(2, '0')}`;
}
