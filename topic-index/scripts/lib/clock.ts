import type { Clock } from '../../src/app/service';

export class ManualClock implements Clock {
  constructor(public current = '2026-10-16T09:00:00.000Z') {}
  now() {
    return this.current;
  }
  set(v: string) {
    this.current = v;
  }
}

/** 決定的な ID（シナリオの再現とリプレイ比較のため） */
export function counterIds() {
  let n = 0;
  return (prefix: string) => `${prefix}_${++n}`;
}
