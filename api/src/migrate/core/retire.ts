import type { ServiceInfo } from './source';

export interface RetirePlan {
  /** Still running: stopped (and kept) in this order. */
  stop: string[];
  /** Every service of the old platform, to remove at the very end. Data is never touched. */
  remove: string[];
}

/** `services` comes from the source, already limited to the old platform's own and in stopping order. */
export function planRetire(services: ServiceInfo[]): RetirePlan {
  return {
    stop: services.filter((s) => s.replicas > 0).map((s) => s.name),
    remove: services.map((s) => s.name),
  };
}
