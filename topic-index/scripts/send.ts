import { createHmac } from 'node:crypto';
import { echoFrom, loadScenario, type Scenario, type Step } from './lib/scenario';

// WEBHOOK_SECRET=<MURMUR_WEBHOOK_SECRET の値> npm run send <scenario> <signal の id>... -- --url <ゲートウェイの URL>/topic-index [--sent-ref <ref>]（URL は TOPIC_INDEX_URL でもよい）
// fixtures/<scenario>/signals.jsonl の signal 行（と状態の写しの mirror 行）を、実環境の Webhook（POST /webhooks/dummy）に 1 件ずつ流す（H7）。
// record_sent の action 行で echo のものは、その送信がデータソースで観測された分（H5 の統合を確かめる）を流す。
// sent_ref はシナリオの値か、スタンドが記録したときの値を --sent-ref で渡す。
// ほかの action 行と cron 行は流さない（スタンドの操作と見回りは実環境で起こす）。受信時刻は本体の時計になる

async function main() {
  const args = process.argv.slice(2);
  const urlAt = args.indexOf('--url');
  const base = urlAt >= 0 ? args.splice(urlAt, 2)[1] : process.env.TOPIC_INDEX_URL;
  if (!base) throw new Error('本体の URL を --url か TOPIC_INDEX_URL で渡す');
  const refAt = args.indexOf('--sent-ref');
  const sentRefOverride = refAt >= 0 ? args.splice(refAt, 2)[1] : undefined;
  const [name, ...ids] = args;
  if (!name || ids.length === 0) throw new Error('usage: npm run send <scenario> <signal の id>... [--url <本体の URL>]');
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) throw new Error('WEBHOOK_SECRET がない');

  const scenario = loadScenario(name);
  for (const id of ids) {
    const step = scenario.steps.find((s) => s.id === id);
    if (!step) throw new Error(`${name}: 行 ${id} がない`);
    const signal =
      'signal' in step
        ? step.signal
        : 'mirror' in step
          ? { kind: 'mirror', ...step.mirror }
          : 'action' in step
            ? echoOf(scenario, step, sentRefOverride)
            : undefined;
    if (!signal) throw new Error(`${name}: ${id} は signal 行・mirror 行でも、echo の record_sent でもない`);
    const body = JSON.stringify([signal]);
    const res = await fetch(`${base}/webhooks/dummy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-topic-index-signature': createHmac('sha256', secret).update(body).digest('hex') },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${id}: ${res.status} ${text}`);
    console.log(`${id}: ${text}`);
  }
}

/** record_sent の行から、その送信がデータソースで観測された分（observed-sent）を作る。シナリオの echo と同じ形 */
function echoOf(scenario: Scenario, step: Extract<Step, { action: unknown }>, sentRefOverride?: string) {
  if (step.action.tool !== 'record_sent' || !step.echo) return undefined;
  const input = step.action.input as Record<string, unknown>;
  const ds = scenario.seed.dataSources.find((d) => d.id === input.data_source);
  const self = ds?.kind === 'service' ? echoFrom(scenario, ds, step.action.as) : undefined;
  if (!ds || ds.kind !== 'service' || !self) throw new Error(`${step.id}: echo の data_source が不正`);
  const sentRef = sentRefOverride ?? String(input.sent_ref);
  const a = (input.anchors ?? {}) as Record<string, unknown>;
  const to = [
    ...((input.to as string[] | undefined) ?? []),
    ...((input.to_contact_ids as string[] | undefined) ?? []).flatMap((pid) =>
      scenario.seed.addresses.filter((x) => x.contactId === pid && x.channel === ds.channel).slice(0, 1).map((x) => x.value),
    ),
  ];
  return {
    dataSourceId: ds.id,
    channel: ds.channel,
    from: { channel: ds.channel, value: self.value },
    to: to.map((value) => ({ channel: ds.channel, value })),
    subject: input.subject,
    body: String(input.body),
    anchors: {
      messageId: sentRef,
      inReplyTo: a.in_reply_to,
      threadTs: a.thread_ts,
      quotedMessageId: a.quoted_message_id,
      threadKey: a.thread_key,
      jiraKeys: a.jira_keys,
      prRefs: a.pr_refs,
    },
    sourceRef: `${ds.channel}:${sentRef}`,
  };
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
