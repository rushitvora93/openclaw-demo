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
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface GatewayResponse {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
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
  minProtocol: number;
  maxProtocol: number;
  client: {
    id: 'webchat';
    version: string;
    platform: string;
    mode: 'webchat';
    displayName?: string;
  };
  role?: string;
  scopes?: string[];
  device?: {
    id: string;
    publicKey: string; // base64url raw Ed25519 public key (32 bytes)
    signature: string; // base64url Ed25519 signature of payload
    signedAt: number; // timestamp ms
    nonce: string; // must match challenge nonce
  };
  auth?: {
    token?: string;
  };
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

export interface ChatEventPayload {
  runId: string;
  sessionKey: string;
  seq: number;
  state: 'delta' | 'final' | 'aborted' | 'error';
  message?: { role: string; content: { type: string; text: string }[]; timestamp: number };
  errorMessage?: string;
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
