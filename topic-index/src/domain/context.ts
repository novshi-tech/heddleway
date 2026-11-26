import type { Directory } from './directory';

/**
 * コアへ渡す決定的な入力。時刻と ID はシェルが用意する
 * （コアは Date.now() も乱数も呼ばない）。
 */
export interface CoreContext {
  dir: Directory;
  now: string;
  newId: (prefix: string) => string;
}
