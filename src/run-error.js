/** A refused or invalid run transition, with the HTTP status to answer. */
export class RunError extends Error {
  constructor(message, { status = 400, code = 'invalid-run-transition', detail } = {}) {
    super(message);
    this.name = 'RunError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}
