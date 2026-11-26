import { TopicIndexService } from '../../src/app/service';
import { counterIds, ManualClock } from '../../scripts/lib/clock';
export { counterIds, ManualClock };
import { DummyConnector, MemoryDummyBackend } from '../../src/connectors/dummy/connector';
import type { Connectors } from '../../src/connectors/types';
import { DEFAULT_POLICY, type AiIngestDecision, type IngestPolicy, type IngestRequest, type Seed } from '../../src/domain';
import type { Decider } from '../../src/ingest/deciders';
import { memoryRepo } from '../../src/store/memory';
import type { Repo } from '../../src/store/types';

/** 依頼を記録し、関数で答える Decider */
export class StubDecider implements Decider {
  readonly requests: IngestRequest[] = [];
  constructor(private readonly answer: (req: IngestRequest) => AiIngestDecision) {}
  async decide(req: IngestRequest) {
    this.requests.push(req);
    return { raw: this.answer(req), by: 'ai' as const };
  }
}

export async function makeService(
  seed: Seed,
  opts: { repo?: Repo; decide?: (req: IngestRequest) => AiIngestDecision; clock?: ManualClock; policy?: IngestPolicy } = {},
) {
  const repo = opts.repo ?? memoryRepo();
  await repo.master.replaceSeed(seed);
  const backend = new MemoryDummyBackend();
  const connectors: Connectors = {
    email: new DummyConnector('email', backend),
    slack: new DummyConnector('slack', backend),
    line: new DummyConnector('line', backend),
  };
  const clock = opts.clock ?? new ManualClock();
  const decider = new StubDecider(
    opts.decide ??
      (() => {
        throw new Error('unexpected AI decision');
      }),
  );
  const service = new TopicIndexService({ repo, clock, newId: counterIds(), decider, connectors, policy: opts.policy ?? DEFAULT_POLICY });
  return { service, repo, backend, clock, decider };
}
