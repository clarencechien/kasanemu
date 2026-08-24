import type { Tier } from './models';
import type { DomainState, Settings, UnitFailure, UnitRequest, UnitResult } from './types';

/** content → worker */
export type ToWorker =
  | { type: 'enqueue'; pageKey: string; tier: Tier; units: UnitRequest[] }
  | { type: 'drop-page'; pageKey: string }
  | { type: 'get-settings' }
  | { type: 'set-settings'; patch: Partial<Settings> }
  | { type: 'get-domain-state'; host: string }
  | { type: 'set-domain-state'; host: string; patch: Partial<DomainState> }
  | { type: 'get-spend' }
  | { type: 'validate-models' }
  | { type: 'clear-cache' }
  | { type: 'page-status'; pageKey: string };

/** worker → content */
export type ToContent =
  | { type: 'results'; pageKey: string; results: UnitResult[] }
  | { type: 'failures'; pageKey: string; failures: UnitFailure[] }
  | { type: 'notice'; pageKey: string; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'domain-state'; host: string; state: DomainState }
  | { type: 'command'; command: 'toggle-enabled' | 'toggle-mode' };

export interface PageStatus {
  queued: number;
  inFlight: number;
  done: number;
  failed: number;
  tokensUsed: number;
  capped: boolean;
}
