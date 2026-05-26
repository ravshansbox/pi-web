import type { AgentSessionEvent, RpcResponse } from '@earendil-works/pi-coding-agent';

/**
 * The union of all events the pi RPC process emits on stdout.
 *
 * `model_changed` is emitted at runtime by pi's RPC mode but is not yet
 * part of the published AgentSessionEvent type.
 */
export type RpcEvent = RpcResponse | AgentSessionEvent | { type: 'model_changed'; model: unknown };
