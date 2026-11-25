import { AI_INGEST_JSON_SCHEMA, AiIngestDecision, buildIngestPrompt, INGEST_SYSTEM_PROMPT, type IngestRequest } from '../domain';
import type { LlmClient } from './llm';

/** 区切りと「返事や対応を求めているか」の判断者 */
export interface Decider {
  decide(req: IngestRequest): Promise<{ raw: AiIngestDecision; by: 'ai' | 'human' }>;
}

export class AiDecider implements Decider {
  constructor(
    private readonly llm: LlmClient,
    private readonly model: string,
  ) {}

  async decide(req: IngestRequest) {
    const text = await this.llm.complete({
      purpose: 'ingest_decision',
      model: this.model,
      system: INGEST_SYSTEM_PROMPT,
      user: buildIngestPrompt(req),
      schema: AI_INGEST_JSON_SCHEMA,
      maxTokens: 2048,
    });
    return { raw: AiIngestDecision.parse(JSON.parse(text)), by: 'ai' as const };
  }
}
