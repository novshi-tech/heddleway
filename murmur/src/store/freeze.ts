/**
 * 入れ子のオブジェクト・配列ごと凍らせる（isolate の写しを、コピーせずに複数の呼び手に渡すため）。
 * ES モジュールは strict なので、凍ったものを書き換えると TypeError になる（黙って写しを壊さない）
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const v of Object.values(value as object)) deepFreeze(v);
  return Object.freeze(value);
}
