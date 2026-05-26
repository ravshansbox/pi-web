/**
 * Re-exports of pi's RPC contract types used by both the server and the client.
 *
 * All imports are type-only so this module is safe to import in frontend code —
 * Vite erases type imports at build time, so no Node.js runtime code is bundled.
 *
 * Only types exported directly from @earendil-works/pi-coding-agent are used here,
 * avoiding a dependency on the private sub-packages (pi-ai, pi-agent-core).
 */
export type {
  AgentSessionEvent,
  SessionStats,
  RpcCommand,
  RpcResponse,
} from '@earendil-works/pi-coding-agent';

/**
 * The union of all events that can arrive from the pi RPC process.
 * `model_changed` is emitted by pi's RPC mode but not yet in AgentSessionEvent.
 */
export type { RpcEvent } from './rpc-event.js';
