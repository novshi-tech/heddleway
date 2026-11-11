import type { Directory } from '../domain';

/** マスタ（Directory）を読む関数。見回り 1 回のあいだ使い回すために、最初の 1 回だけ読む形にして渡す */
export type DirectoryLoader = () => Promise<Directory>;

/** 最初に呼ばれたときだけ load を実行し、あとは同じ結果を返す（読み込みの失敗は覚えず、次の呼び出しでやり直す） */
export function onceDirectory(load: DirectoryLoader): DirectoryLoader {
  let loaded: Promise<Directory> | undefined;
  return () => {
    if (!loaded) {
      loaded = load().catch((err: unknown) => {
        loaded = undefined;
        throw err;
      });
    }
    return loaded;
  };
}
