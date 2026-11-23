import { GatewayError } from '../../src/ports/gateway';
import { LineNotReadable, type LineApi, type LineEvent, type LineEventsResult, type LineOrganization } from '../../src/connectors/line/api';

/** 受け口（業務システム）の LINE の原本。だれの接続で読んでも同じもの（組織に 1 つ） */
export class FakeLineStore {
  readonly events: (LineEvent & { receivedAt: string })[] = [];
  private n = 0;

  /** 保存の順のカーソル（受け口と同じ形: 固定長の UTC 時刻 + '|' + ID） */
  static cursorOf(e: { receivedAt: string; id: string }): string {
    return `${new Date(e.receivedAt).toISOString()}|${e.id}`;
  }

  add(e: Partial<LineEvent> & { at: string; receivedAt?: string }): LineEvent {
    const id = e.id ?? `ev${++this.n}`;
    const { at, receivedAt, ...rest } = e;
    const event = { id, direction: 'INBOUND' as const, type: 'message', messageType: 'text', occurredAt: at, ...rest, receivedAt: receivedAt ?? at };
    this.events.push(event);
    this.events.sort((a, b) => FakeLineStore.cursorOf(a).localeCompare(FakeLineStore.cursorOf(b)));
    return event;
  }
}

/** 1 人の接続（API キー）で見た受け口 */
export class FakeLine implements LineApi {
  readable = true;
  /** ゲートウェイが一時的に落ちている */
  down = false;
  readonly calls: string[] = [];

  constructor(
    readonly store: FakeLineStore,
    readonly organization: LineOrganization = { id: 'org_ubs', name: 'アーバン' },
  ) {}

  async probe(): Promise<LineOrganization> {
    this.calls.push('probe');
    if (this.down) throw new GatewayError('upstream timeout', 502);
    if (!this.readable) throw new LineNotReadable('bm-next: AUTH_NOT_AUTHORIZED');
    return this.organization;
  }

  async events(opts: { after: string | null; since: string; first?: number }): Promise<LineEventsResult> {
    this.calls.push(`events ${opts.after ?? `since ${opts.since}`}`);
    if (this.down) throw new GatewayError('upstream timeout', 502);
    if (!this.readable) throw new LineNotReadable('bm-next: AUTH_NOT_AUTHORIZED');
    const from = opts.after ?? new Date(opts.since).toISOString();
    const first = opts.first ?? 100;
    const after = this.store.events.filter((e) => FakeLineStore.cursorOf(e) > from);
    const page = after.slice(0, first);
    const last = page.at(-1);
    return {
      events: page.map(({ receivedAt: _r, ...e }) => e),
      endCursor: last ? FakeLineStore.cursorOf(last) : null,
      hasMore: after.length > first,
    };
  }
}
