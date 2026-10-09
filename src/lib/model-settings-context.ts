import { AsyncLocalStorage } from 'node:async_hooks';
import type { ReasoningEffort } from './model-registry';

export interface ModelExecutionSettings {
  preferredModel?: string;
  reasoningEffort?: ReasoningEffort;
}
// Never use process-global mutable model preferences: missions run concurrently.
const settings = new AsyncLocalStorage<ModelExecutionSettings>();
export function withModelSettings<T>(value: ModelExecutionSettings, work: () => T): T {
  return settings.run(value, work);
}
export function currentModelSettings(): ModelExecutionSettings | undefined {
  return settings.getStore();
}
