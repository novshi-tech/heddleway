import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadScenario } from './lib/scenario';
import { parseUserMap, renameUsers, seedSql } from './lib/seed';

// npm run seed <scenario> -- --deployment <名前> [--user <seed の User ID>=<ゲートウェイの User ID>]...
// ゲートウェイのデプロイ（リポジトリのルートの deployments/<名前>.jsonc）のトピック索引の D1（MURMUR_DB）を空にして
//（イベント・投影・ダミーのキューも）、fixtures/<scenario>/seed.json を入れる。
// SQL を作って wrangler d1 execute で流す（Cloudflare の認証は wrangler のもの）。シナリオは 1 つずつ回す（H7）

function main() {
  const [name, ...rest] = process.argv.slice(2);
  if (!name || name.startsWith('--')) {
    throw new Error('usage: npm run seed <scenario> -- --deployment <名前> [--user <seed の User ID>=<ゲートウェイの User ID>]...');
  }
  const deploymentAt = rest.indexOf('--deployment');
  const deployment = deploymentAt >= 0 ? rest[deploymentAt + 1] : undefined;
  if (!deployment) throw new Error('--deployment <名前>（リポジトリのルートの deployments/<名前>.jsonc）を指定する');
  const config = `../deployments/${deployment}.jsonc`;
  if (!existsSync(config)) throw new Error(`${config} がない`);
  const seed = renameUsers(loadScenario(name).seed, parseUserMap(rest));

  const dir = mkdtempSync(join(tmpdir(), 'topic-index-seed-'));
  try {
    const file = join(dir, 'seed.sql');
    writeFileSync(file, seedSql(seed));
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'MURMUR_DB', '--config', config, '--remote', `--file=${file}`], {
      stdio: 'inherit',
    });
    console.log(`${name}: users=${seed.users.map((u) => u.id).join(',')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
