import type {
  AgentSessionEvent,
  RpcExtensionUIRequest,
  RpcResponse,
} from '@earendil-works/pi-coding-agent';

/**
 * The union of all events the pi RPC process emits on stdout.
 *
 * `model_changed` is emitted at runtime by pi's RPC mode but is not yet
 * part of the published AgentSessionEvent type.
 *
 * `extension_ui_request` carries extension UI calls (notify, select, confirm,
 * input, ...) emitted when an extension invokes ctx.ui.* in RPC mode.
 */
export type RpcEvent =
  | RpcResponse
  | AgentSessionEvent
  | RpcExtensionUIRequest
  | { type: 'model_changed'; model: unknown };
