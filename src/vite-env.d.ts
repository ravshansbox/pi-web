/// <reference types="vite/client" />
declare const __APP_VERSION__: string;

interface WebSocket {
  /** Heartbeat interval handle (see connect() in App.tsx) */
  __heartbeatTimer: number | null;
}
