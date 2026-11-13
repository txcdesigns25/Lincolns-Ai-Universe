/** Thrown when a policy, limit, or control blocks an action. Never retried. */
export class PolicyDenied extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "PolicyDenied";
  }
}

/** Thrown for transient failures (network, rate limit, 5xx). Safe to retry. */
export class RetryableError extends Error {
  constructor(message: string, public retryAfterMs?: number) {
    super(message);
    this.name = "RetryableError";
  }
}

/** The task cannot continue until a human decides. Not a failure. */
export class AwaitingApproval extends Error {
  constructor(public approvalId: string, message: string) {
    super(message);
    this.name = "AwaitingApproval";
  }
}
