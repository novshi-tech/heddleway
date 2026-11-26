export type DomainErrorCode = 'not_found' | 'forbidden' | 'invalid' | 'conflict';

/** コアが返す業務エラー。シェルが HTTP ステータスなどに写す */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
