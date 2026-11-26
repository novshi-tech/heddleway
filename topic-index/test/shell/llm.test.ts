import { describe, expect, it, vi } from 'vitest';
import { AiDecider } from '../../src/ingest/deciders';
import type { IngestRequest } from '../../src/domain';
import {
  AnthropicLlm,
  LlmApiError,
  LlmRefusalError,
  MemoryRecordingStore,
  recordingKey,
  RecordingMissingError,
  RecordReplayLlm,
  type LlmClient,
  type LlmRequest,
} from '../../src/ingest/llm';

const req: LlmRequest = { purpose: 'ingest_decision', model: 'claude-sonnet-5-5', system: 's', user: 'u', schema: { type: 'object' } };

class CountingLlm implements LlmClient {
  calls = 0;
  constructor(private readonly reply: string) {}
  async complete() {
    this.calls++;
    return this.reply;
  }
}

describe('記録・再生', () => {
  it('キーはリクエストの内容だけで決まり、キー順に依存しない', async () => {
    const k1 = await recordingKey(req);
    const k2 = await recordingKey({ user: 'u', system: 's', model: 'claude-sonnet-5-5', schema: { type: 'object' }, purpose: 'ingest_decision' });
    expect(k1).toBe(k2);
    expect(await recordingKey({ ...req, model: 'other' })).not.toBe(k1);
  });

  it('replay は記録がなければ失敗し、本物を呼ばない', async () => {
    const live = new CountingLlm('x');
    await expect(new RecordReplayLlm('replay', new MemoryRecordingStore(), live).complete(req)).rejects.toBeInstanceOf(RecordingMissingError);
    expect(live.calls).toBe(0);
  });

  it('record は一度だけ本物を呼んで記録し、replay で同じ応答を返す', async () => {
    const store = new MemoryRecordingStore();
    const live = new CountingLlm('{"ok":true}');
    const rec = new RecordReplayLlm('record', store, live);
    expect(await rec.complete(req)).toBe('{"ok":true}');
    expect(await rec.complete(req)).toBe('{"ok":true}');
    expect(live.calls).toBe(1);
    expect([...store.recordings.values()][0]).toMatchObject({ request: req, response: '{"ok":true}' });
    expect(await new RecordReplayLlm('replay', store).complete(req)).toBe('{"ok":true}');
  });

  it('rerecord は既存の記録を無視して呼び直し、上書きする', async () => {
    const store = new MemoryRecordingStore();
    await new RecordReplayLlm('record', store, new CountingLlm('old')).complete(req);
    const live = new CountingLlm('new');
    expect(await new RecordReplayLlm('rerecord', store, live).complete(req)).toBe('new');
    expect(await new RecordReplayLlm('replay', store).complete(req)).toBe('new');
  });

  it('record で本物がなければ失敗する', async () => {
    await expect(new RecordReplayLlm('record', new MemoryRecordingStore()).complete(req)).rejects.toThrow(/live client/);
  });
});

describe('AnthropicLlm', () => {
  const fake = (...responses: Array<Response | Error>) => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
      const next = responses.shift();
      if (!next) throw new Error('no more responses');
      if (next instanceof Error) throw next;
      return next;
    });
    const llm = new AnthropicLlm({ apiKey: 'k', fetch, sleep: async () => {} });
    return { llm, fetch, body: (i = 0) => JSON.parse(String(fetch.mock.calls[i]![1].body)), headers: (i = 0) => fetch.mock.calls[i]![1].headers as Record<string, string> };
  };
  const ok = (res: unknown) => Response.json(res);

  it('構造化出力・フォールバック・effort を付けて呼び、テキストをつなげて返す', async () => {
    const { llm, fetch, body, headers } = fake(ok({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"a"' }, { type: 'text', text: ':1}' }] }));
    expect(await llm.complete(req)).toBe('{"a":1}');
    expect(fetch.mock.calls[0]![0]).toBe('https://api.anthropic.com/v1/messages');
    expect(headers()).toMatchObject({ 'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' });
    expect(body()).toMatchObject({
      model: 'claude-sonnet-5-5',
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } },
      fallbacks: 'default',
    });
  });

  it('schema がなければ format を付けない', async () => {
    const { llm, body } = fake(ok({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] }));
    await llm.complete({ ...req, schema: undefined });
    expect(body().output_config).toEqual({ effort: 'low' });
  });

  it('refusal と空応答はエラー', async () => {
    await expect(fake(ok({ stop_reason: 'refusal', content: [] })).llm.complete(req)).rejects.toBeInstanceOf(LlmRefusalError);
    await expect(fake(ok({ stop_reason: 'max_tokens', content: [] })).llm.complete(req)).rejects.toThrow(/empty/);
  });

  it('429・5xx・通信の失敗は 2 回まで試し直し、400 は試し直さない', async () => {
    const good = ok({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] });
    const { llm, fetch } = fake(new Response('', { status: 429 }), new TypeError('network'), good);
    expect(await llm.complete(req)).toBe('x');
    expect(fetch).toHaveBeenCalledTimes(3);

    const bad = fake(Response.json({ error: { type: 'invalid_request_error', message: 'nope' } }, { status: 400 }));
    await expect(bad.llm.complete(req)).rejects.toBeInstanceOf(LlmApiError);
    expect(bad.fetch).toHaveBeenCalledTimes(1);

    const down = fake(new Response('', { status: 503 }), new Response('', { status: 503 }), new Response('', { status: 503 }));
    await expect(down.llm.complete(req)).rejects.toThrow(/503/);
    expect(down.fetch).toHaveBeenCalledTimes(3);
  });
});

describe('AiDecider', () => {
  const request: IngestRequest = {
    mode: 'new',
    signal: {
      signalId: 's',
      dataSourceId: 'ds',
      channel: 'email',
      from: { channel: 'email', value: 'a@x' },
      to: [],
      body: 'b',
      anchors: {},
      attachments: [],
      sourceRef: 'r',
    },
    ours: false,
    dataSource: { id: 'ds', name: 'support@', description: '', channel: 'email', group: false },
    threading: { kind: 'new', by: 'no_match', reason: 'r' },
    candidates: [],
  };

  it('H6 構造化出力を検証して返す。壊れた出力は例外', async () => {
    const out = { thread: 'new', thread_id: null, title: 't', needs_response: true, reason: 'r', confidence: 0.7 };
    const llm = new CountingLlm(JSON.stringify(out));
    expect(await new AiDecider(llm, 'm').decide(request)).toEqual({ raw: out, by: 'ai' });
    await expect(new AiDecider(new CountingLlm('{"thread":"maybe"}'), 'm').decide(request)).rejects.toThrow();
  });
});
