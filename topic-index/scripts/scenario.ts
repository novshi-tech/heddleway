import { AnthropicLlm } from '../src/ingest/llm';
import { d1Repo } from '../src/store/d1';
import { localD1 } from './lib/d1';
import { listScenarios, loadScenario, runScenario, verifyScenario, type DeciderMode } from './lib/scenario';

// npm run scenario run <name|all> [--ai replay|record|rerecord] [--db memory|d1]
// npm run scenario verify <name|all> [...]   expected.json と比較し、H1 のリプレイ比較も行う

const USAGE = 'usage: npm run scenario <run|verify> <name|all> [--ai replay|record|rerecord] [--db memory|d1] [--model <id>]';

async function main() {
  const [cmd, target, ...rest] = process.argv.slice(2);
  if (!cmd || !target || !['run', 'verify'].includes(cmd)) throw new Error(USAGE);
  const flag = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const aiMode = flag('ai') as 'replay' | 'record' | 'rerecord' | undefined;
  const model = flag('model') ?? process.env.CLAUDE_MODEL ?? 'claude-sonnet-5-5';
  const decider: DeciderMode = aiMode
    ? {
        kind: 'ai',
        mode: aiMode,
        model,
        live: aiMode === 'replay' ? undefined : new AnthropicLlm({ apiKey: requireApiKey() }),
      }
    : { kind: 'hint' };

  const names = target === 'all' ? listScenarios() : [target];
  let failed = false;
  for (const name of names) {
    const scenario = loadScenario(name);
    let close: (() => Promise<void>) | undefined;
    let repo;
    if (flag('db') === 'd1') {
      const db = await localD1();
      close = db.close;
      repo = d1Repo(db.db);
    }
    const run = await runScenario(scenario, { repo, decider });
    const p = await run.service.state();
    console.log(`\n# ${name}（${scenario.config.title}） ${scenario.config.hypotheses.join(' ')} [${scenario.config.status}]`);
    console.log(`  steps=${scenario.steps.length} events=${p.lastSeq} threads=${Object.keys(p.threads).length}`);
    if (cmd === 'verify') {
      const v = await verifyScenario(run);
      const pct = (c: number, t: number) => (t === 0 ? '-' : `${((100 * c) / t).toFixed(1)}% (${c}/${t})`);
      console.log(`  H1 replay: ${v.replayHashMatches ? 'OK' : 'NG'} thread-hash=${v.threadHash.slice(0, 16)}`);
      const who = decider.kind === 'hint' ? 'ヒント' : 'AI';
      const m = v.metrics;
      console.log(
        `  H6 ingest: 全体 ${pct(m.correct, m.total)} / 構造の区切り ${pct(m.structural.correct, m.structural.total)} / ${who}の区切り ${pct(m.ai.correct, m.ai.total)}`,
      );
      if (m.confidences.length) console.log(`  confidence: ${m.confidences.map((c) => c.toFixed(2)).join(' ')}`);
      if (v.errors.length) {
        failed = true;
        for (const e of v.errors) console.log(`  ✗ ${e}`);
      } else console.log('  ✓ expected.json と一致');
    }
    await close?.();
  }
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

function requireApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('--ai record / rerecord には ANTHROPIC_API_KEY が要る');
  return key;
}
