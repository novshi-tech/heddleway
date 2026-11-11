import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// FC-IS の境界をテストで縛る: src/domain（関数型コア）は IO に依存しない。

const DOMAIN = join(import.meta.dirname, '../src/domain');
const files = readdirSync(DOMAIN).filter((f) => f.endsWith('.ts'));

describe('関数型コア（src/domain）の純粋性', () => {
  it.each(files)('%s は zod と domain 内のモジュールしか import しない', (file) => {
    const src = readFileSync(join(DOMAIN, file), 'utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    for (const spec of imports) expect(spec === 'zod' || spec.startsWith('./')).toBe(true);
  });

  it.each(files)('%s は時計・乱数・ネットワーク・Workers API を使わない', (file) => {
    const src = readFileSync(join(DOMAIN, file), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const banned of [/Date\.now\(/, /new Date\(\)/, /Math\.random\(/, /crypto\./, /\bfetch\(/, /\bprocess\./, /\bconsole\./, /\benv\./]) {
      expect(src).not.toMatch(banned);
    }
  });
});

// vertical slice（0023 の決定 7）: ゲートウェイと 1 つの Worker で動いても、Murmur のコードが
// ゲートウェイの実装・秘密・グローバルに直に触れないことを縛る。

const SRC = join(import.meta.dirname, '../src');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

const sources = walk(SRC).map((path) => ({
  path,
  rel: path.slice(SRC.length + 1),
  code: readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1'),
}));
const importsOf = (code: string) => [...code.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((m) => m[1]!);

describe('vertical slice（0023 の決定 7）', () => {
  it('ports/ は型と取り決めだけ（何も import しない）', () => {
    for (const s of sources.filter((s) => s.rel.startsWith('ports/'))) expect(importsOf(s.code)).toEqual([]);
  });

  it('Murmur のどのファイルも env と cloudflare:workers に触れない（入口はゲートウェイの側。秘密は入口が必要な分だけ設定で渡す）', () => {
    const offenders = sources
      .filter((s) => /\benv\.[A-Z_]+/.test(s.code) || importsOf(s.code).includes('cloudflare:workers'))
      .map((s) => s.rel);
    expect(offenders).toEqual([]);
  });

  it('実行時の依存は許可リストだけ（Murmur は依存を足さない）', () => {
    const allowed = /^(zod|drizzle-orm(\/[\w-]+)?)$/;
    const bare = sources.flatMap((s) => importsOf(s.code).filter((spec) => !spec.startsWith('.')).map((spec) => `${s.rel}: ${spec}`));
    expect(bare.filter((x) => !allowed.test(x.split(': ')[1]!))).toEqual([]);
  });

  it('グローバル（globalThis・fetch・crypto）を書き換えない', () => {
    const offenders = sources
      .filter((s) => /globalThis\s*(\.\w+|\[[^\]]+\])\s*=[^=]|(^|[^.\w])(fetch|crypto)\s*=[^=]|Object\.defineProperty\(\s*globalThis/m.test(s.code))
      .map((s) => s.rel);
    expect(offenders).toEqual([]);
  });
});

// ゲートウェイの側（0023 の段取り 3）: ゲートウェイの中核は Murmur の実装を import しない。
// Murmur を組み立てるのはゲートウェイの入口（index.ts と murmur-feature.ts）だけで、
// 中核が Murmur から読んでよいのは口の取り決め（ports/gateway.ts）だけ。Murmur はゲートウェイを import しない。

const GATEWAY_SRC = join(import.meta.dirname, '../../src');
const gatewaySources = walk(GATEWAY_SRC).map((path) => ({ rel: path.slice(GATEWAY_SRC.length + 1), code: readFileSync(path, 'utf8') }));
const gatewayImports = (code: string) => [...code.matchAll(/(?:from|import)\s+"([^"]+)"/g)].map((m) => m[1]!);
const GATEWAY_ENTRY = ['index.ts', 'murmur-feature.ts'];

describe('vertical slice: ゲートウェイの側（0023 の段取り 3）', () => {
  it('Murmur の実装を import してよいのはゲートウェイの入口だけ。中核は口の取り決めだけ', () => {
    const offenders = gatewaySources
      .filter((s) => !GATEWAY_ENTRY.includes(s.rel))
      .flatMap((s) => gatewayImports(s.code).filter((spec) => spec.includes('murmur/') && !spec.endsWith('murmur/src/ports/gateway')).map((spec) => `${s.rel}: ${spec}`));
    expect(offenders).toEqual([]);
  });

  it('ゲートウェイの入口が Murmur から読むのは、組み立て（feature.ts）と、入口で固定する読める口と取り決めだけ', () => {
    const allowed = /murmur\/src\/(feature|ports\/gateway|connectors\/graph\/scope|connectors\/jira\/api|connectors\/teams\/scope|connectors\/gmail\/scope|connectors\/gtasks\/scope|connectors\/graph\/jobs)$/;
    const offenders = gatewaySources
      .filter((s) => GATEWAY_ENTRY.includes(s.rel))
      .flatMap((s) => gatewayImports(s.code).filter((spec) => spec.includes('murmur/') && !allowed.test(spec)).map((spec) => `${s.rel}: ${spec}`));
    expect(offenders).toEqual([]);
  });

  it('Murmur はゲートウェイを import しない（相対の import は murmur/ の外へ出ない）', () => {
    const root = join(import.meta.dirname, '..');
    const offenders = sources.flatMap((s) =>
      importsOf(s.code)
        .filter((spec) => spec.startsWith('.') && !resolve(dirname(s.path), spec).startsWith(root + sep))
        .map((spec) => `${s.rel}: ${spec}`),
    );
    expect(offenders).toEqual([]);
  });
});
