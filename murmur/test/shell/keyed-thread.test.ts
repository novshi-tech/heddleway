import { afterAll, describe, expect, it } from 'vitest';
import { Directory, connectTaskList, createPersonalDataSource, planMasterEdit, type InboundMirror, type Seed } from '../../src/domain';
import { d1Repo } from '../../src/store/d1';
import { memoryRepo } from '../../src/store/memory';
import type { Repo } from '../../src/store/types';
import { counterIds } from '../../scripts/lib/clock';
import { localD1 } from '../../scripts/lib/d1';
import { makeService } from '../helpers/service';
import { seed } from '../helpers/world';

// 外のサービスのキー（To Do のタスクの ID・Jira の課題キー）で決まるスレッドに、2 つの書き手が書く:
// スタンドの記録（record_sent。アンカーの threadKey = sent_ref）と、コネクタの写し（InboundMirror。threadKey = キー）。
// どちらが先でも、同時に走っても、1 本のスレッドに収まること（ADR 0031 の決定 8・0039 の決定 3）。
// 追記は期待する lastSeq つきで、ぶつかったら読み直してやり直す（MurmurService.run）。それが D1 でも効くことを確かめる

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

const impls: [string, () => Promise<Repo>][] = [
  ['memory', async () => memoryRepo()],
  [
    'd1',
    async () => {
      const { db, close } = await localD1();
      closers.push(close);
      return d1Repo(db);
    },
  ],
];

// Graph の ID に近い 152 文字（base64 の文字を一通り含む）
const TASK = 'AAMkADk5ZTNhMmI0LTYxYjktNDRiNi1iYTJkLWQ4Y2Y1ZDY1NDQ0ZQBGAAAAAACqX-0_7c8hQqk+JvKq/1abcDQCnJ5qGkgO3SIRgWz7oTK8XAAAAJQ3sAAA=';
const ISSUE = 'SPW-2040';
const KATO = 'kato-account';

interface Kind {
  name: string;
  channel: 'todo' | 'jira';
  key: string;
  seed(): Promise<{ seed: Seed; dataSourceId: string }>;
}

const kinds: Kind[] = [
  {
    name: 'To Do のタスク',
    channel: 'todo',
    key: TASK,
    async seed() {
      let dataSourceId = '';
      const { after } = planMasterEdit(seed, (d) => {
        dataSourceId = connectTaskList(d, { dir: new Directory(d), now: '2026-11-12T00:00:00.000Z', newId: counterIds() }, { userId: 'u_bob', gatewayCredentialId: 'gw_bob', displayName: 'Bob', address: 'bob.todo@ubs.example', listId: 'L', listName: 'Murmur' }).dataSource.id;
      });
      return { seed: after, dataSourceId };
    },
  },
  {
    name: 'Jira の課題',
    channel: 'jira',
    key: ISSUE,
    async seed() {
      let dataSourceId = '';
      const { after } = planMasterEdit(seed, (d) => {
        dataSourceId = createPersonalDataSource(d, 'u_bob', { channel: 'jira', name: 'Bob の Jira', identity: 'bob-account', gatewayCredentialId: 'gw_jira' }, { dir: new Directory(d), now: '2026-11-12T00:00:00.000Z', newId: counterIds() }).dataSourceId;
      });
      return { seed: after, dataSourceId };
    },
  },
];

async function world(kind: Kind, make: () => Promise<Repo>) {
  const planned = await kind.seed();
  const made = await makeService(planned.seed, { repo: await make() });
  const { dataSourceId } = planned;
  const mirror = (): InboundMirror => ({
    kind: 'mirror',
    dataSourceId,
    channel: kind.channel,
    threadKey: kind.key,
    fields: { closed: false, holders: ['bob.todo@ubs.example'], title: '調査', statusLabel: 'Murmur', due: '2026-11-14' },
    sourceRef: `mirror:${kind.key}`,
  });
  // スタンドが外のサービスで作った直後の記録。タスクは宛先なし、Jira は担当者宛て（アンカーの threadKey は課題キー）
  const record = () =>
    made.service.recordSent('u_bob', {
      dataSourceId,
      to: kind.channel === 'jira' ? [KATO] : [],
      toContactIds: [],
      subject: '調査',
      body: '作った',
      sentRef: kind.key,
      ...(kind.channel === 'jira' ? { anchors: { threadKey: kind.key } } : {}),
    });
  const threadsOf = async () => Object.values((await made.service.state()).threads).filter((t) => t.dataSourceId === dataSourceId);
  return { ...made, mirror, record, threadsOf };
}

/** 最初の n 回の append が揃うまで、揃った操作を止める（どの操作も、追記の前に状態を読み終えたことを確かめる） */
function gateAppends(repo: Repo, n = 2): Repo {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  const events = repo.events;
  return {
    ...repo,
    events: {
      read: (after) => events.read(after),
      append: async (expected, drafts, at) => {
        if (arrived < n) {
          arrived++;
          if (arrived === n) release();
          await open;
        }
        return events.append(expected, drafts, at);
      },
    },
  };
}

describe.each(kinds)('H5 $name: 記録と写しは 1 スレッドに収まる', (kind) => {
  describe.each(impls)('%s', (_n, make) => {
    it('記録 → 写し（逐次）', async () => {
      const w = await world(kind, make);
      await w.record();
      w.clock.set('2026-11-12T00:23:48.249Z');
      await w.service.mirror(w.mirror());
      const threads = await w.threadsOf();
      expect(threads).toHaveLength(1);
      expect(threads[0]).toMatchObject({ sourceKey: kind.key, source: { due: '2026-11-14' } });
      expect(threads[0]!.signalIds).toHaveLength(1);
    });

    it('写し → 記録（逐次）', async () => {
      const w = await world(kind, make);
      await w.service.mirror(w.mirror());
      w.clock.set('2026-11-12T00:23:52.513Z');
      await w.record();
      const threads = await w.threadsOf();
      expect(threads).toHaveLength(1);
      expect(threads[0]!.signalIds).toHaveLength(1);
    });

    it('どちらも追記の前に状態を読み終えている（記録が先に追記）', async () => {
      const w = await world(kind, async () => gateAppends(await make()));
      await Promise.all([w.record(), w.service.mirror(w.mirror())]);
      expect(await w.threadsOf()).toHaveLength(1);
    });

    it('どちらも追記の前に状態を読み終えている（写しが先に追記）', async () => {
      const w = await world(kind, async () => gateAppends(await make()));
      await Promise.all([w.service.mirror(w.mirror()), w.record()]);
      expect(await w.threadsOf()).toHaveLength(1);
    });

    it('同じ写しが同時に 2 回届いても（通知と見回り）1 本', async () => {
      const w = await world(kind, async () => gateAppends(await make()));
      await Promise.all([w.service.mirror(w.mirror()), w.service.mirror(w.mirror())]);
      expect(await w.threadsOf()).toHaveLength(1);
    });
  });
});
