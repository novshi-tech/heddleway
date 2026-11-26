import type { ReadScope } from '../../ports/gateway';

// 本体が受け口（業務システム）に対して呼べる口（0049 の決定 2、0023 の決定 4）。GET の GraphQL だけ。
// 受け口の GraphQL サーバは GET で mutation を受けない（HotChocolate の既定）ので、GET に限れば送信（sendLineMessage）は通らない。
// 照合はパスだけなので、クエリの文字列は口では絞れない。本体が組み立てるクエリは api.ts の固定の文字列だけ（POST の口は持たない）
export const LINE_SCOPE: ReadScope = Object.freeze([['GET', /^\/graphql$/]] as const);
