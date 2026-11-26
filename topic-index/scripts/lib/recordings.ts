import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Recording, RecordingStore } from '../../src/ingest/llm';

/** fixtures/<scenario>/recordings/<key>.json に Claude の入出力を置く */
export class FsRecordingStore implements RecordingStore {
  constructor(private readonly dir: string) {}

  async get(key: string): Promise<Recording | undefined> {
    const path = join(this.dir, `${key}.json`);
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Recording) : undefined;
  }

  async put(rec: Recording): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${rec.key}.json`), JSON.stringify(rec, null, 2) + '\n');
  }

  count(): number {
    return existsSync(this.dir) ? readdirSync(this.dir).filter((f) => f.endsWith('.json')).length : 0;
  }
}
