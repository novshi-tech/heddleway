import { defineConfig } from 'drizzle-kit';

// マイグレーションの SQL を作るだけ（npm run db:generate）。当てるのはリポジトリのルートの npm run d1-migrate -- <名前>（MURMUR_DB に）
export default defineConfig({
  schema: './src/store/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
});
