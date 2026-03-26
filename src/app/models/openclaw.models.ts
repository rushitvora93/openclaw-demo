// ─── Connection State ────────────────────────────────────────────────────────

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'error';

// ─── Protocol Message Types ───────────────────────────────────────────────────

export interface GatewayRequest {
  type: 'req';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface GatewayResponse {
  type: 'res';
  id: number;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

export interface GatewayEvent {
  type: 'event';
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: number;
}

export type GatewayMessage = GatewayRequest | GatewayResponse | GatewayEvent;

// ─── Handshake ────────────────────────────────────────────────────────────────

export interface ConnectChallengePayload {
  nonce: string;
  timestamp: number;
}

export interface ConnectParams {
  version: number;
  role: 'operator' | 'node';
  scopes: string[];
  device: DeviceIdentity;
  token?: string;
  challenge?: string; // signed nonce
}

export interface DeviceIdentity {
  id: string;
  name: string;
  platform?: string;
}

export interface HelloOkPayload {
  presence: Record<string, unknown>;
  health: GatewayHealth;
  stateVersion: number;
  uptimeMs: number;
}

// ─── Health & Status ──────────────────────────────────────────────────────────

export interface GatewayHealth {
  ok: boolean;
  status: string;
  checks?: Record<string, boolean>;
}

// ─── Chat & Agent ─────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'agent' | 'system';
export type MessageStatus = 'sending' | 'streaming' | 'done' | 'error';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  timestamp: Date;
}

export interface AgentEventPayload {
  delta?: string;       // streamed text chunk
  content?: string;     // full content on completion
  status?: 'accepted' | 'streaming' | 'ok' | 'error';
  requestId?: string;
  error?: string;
}

export interface SendMessageParams {
  message: string;
  channel?: string;
  context?: Record<string, unknown>;
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export interface OpenClawSettings {
  gatewayUrl: string;
  token: string;
  deviceName: string;
}
