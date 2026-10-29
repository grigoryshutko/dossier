import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

// This context is set at execution, not when work is queued. Jobs may start
// in a different async chain, and must check current consent at inference.
const execution = new AsyncLocalStorage<boolean>();

export function withAiBackgroundExecution<T>(callback: () => Promise<T>): Promise<T> {
  return execution.run(true, callback);
}

/** Reset inherited context for an explicitly user-initiated job. */
export function withAiUserExecution<T>(callback: () => Promise<T>): Promise<T> {
  return execution.run(false, callback);
}

export function isAiBackgroundExecution(): boolean {
  return execution.getStore() === true;
}
