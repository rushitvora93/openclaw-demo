import { Injectable, OnDestroy } from '@angular/core';
import {
  BehaviorSubject,
  Subject,
  Observable,
  filter,
  map,
  timeout,
  firstValueFrom,
} from 'rxjs';
import {
  ConnectionStatus,
  GatewayEvent,
  GatewayMessage,
  GatewayRequest,
  GatewayResponse,
  OpenClawSettings,
  ChatMessage,
  AgentEventPayload,
  ConnectParams,
} from '../models/openclaw.models';
import { environment } from '../../environments/environment';

const STORAGE_KEY_DEVICE_ID = 'openclaw_device_id';
const STORAGE_KEY_SETTINGS = 'openclaw_settings';
const PROTOCOL_VERSION = 1;

@Injectable({ providedIn: 'root' })
export class OpenClawService implements OnDestroy {
  // ─── Public State ────────────────────────────────────────────────────────

  readonly status$ = new BehaviorSubject<ConnectionStatus>('disconnected');
  readonly messages$ = new BehaviorSubject<ChatMessage[]>([]);
  readonly error$ = new BehaviorSubject<string | null>(null);

  // ─── Private ──────────────────────────────────────────────────────────────

  private ws: WebSocket | null = null;
  private reqId = 1;
  private pendingRequests = new Map<
    number,
    { resolve: (v: GatewayResponse) => void; reject: (e: Error) => void }
  >();
  private events$ = new Subject<GatewayEvent>();
  private activeAgentMsgId: string | null = null;

  private settings: OpenClawSettings = this.loadSettings();
  private deviceId: string = this.loadOrCreateDeviceId();

  // ─── Settings ─────────────────────────────────────────────────────────────

  getSettings(): OpenClawSettings {
    return { ...this.settings };
  }

  saveSettings(settings: OpenClawSettings): void {
    this.settings = { ...settings };
    localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(this.settings));
  }

  // ─── Connection ───────────────────────────────────────────────────────────

  connect(): void {
    if (this.ws) this.disconnect();

    this.setStatus('connecting');
    this.error$.next(null);

    try {
      this.ws = new WebSocket(this.settings.gatewayUrl);
    } catch {
      this.setError('Invalid Gateway URL.');
      return;
    }

    this.ws.onopen = () => {
      // Status moves to 'authenticating' once we receive the challenge
      // For local (loopback) connections, the server may send hello-ok directly
      this.setStatus('authenticating');
    };

    this.ws.onmessage = (event) => this.handleRaw(event.data as string);

    this.ws.onerror = () => {
      this.setError('WebSocket error — is the OpenClaw Gateway running?');
    };

    this.ws.onclose = () => {
      if (this.status$.value !== 'error') {
        this.setStatus('disconnected');
      }
      this.ws = null;
      this.pendingRequests.forEach((p) =>
        p.reject(new Error('Connection closed'))
      );
      this.pendingRequests.clear();
    };
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this.setStatus('disconnected');
  }

  // ─── Send a message to the agent ─────────────────────────────────────────

  async sendMessage(text: string): Promise<void> {
    if (this.status$.value !== 'connected') {
      throw new Error('Not connected to Gateway.');
    }

    const userMsg = this.addMessage('user', text, 'done');
    const agentMsg = this.addMessage('agent', '', 'streaming');
    this.activeAgentMsgId = agentMsg.id;

    try {
      const res = await this.request('agent.run', {
        message: text,
        stream: true,
      });

      if (!res.ok) {
        this.updateMessage(agentMsg.id, {
          content: res.error ?? 'Request failed.',
          status: 'error',
        });
      }
      // Streamed chunks arrive via agent events — see handleEvent()
    } catch (err) {
      this.updateMessage(agentMsg.id, {
        content: String(err),
        status: 'error',
      });
    }

    return void userMsg; // suppress unused var warning
  }

  // ─── Gateway RPC ──────────────────────────────────────────────────────────

  async getHealth(): Promise<unknown> {
    return (await this.request('gateway.health')).payload;
  }

  async getStatus(): Promise<unknown> {
    return (await this.request('gateway.status')).payload;
  }

  // ─── Events (public stream) ───────────────────────────────────────────────

  onEvent(eventName: string): Observable<GatewayEvent> {
    return this.events$.pipe(filter((e) => e.event === eventName));
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async handleRaw(data: string): Promise<void> {
    let msg: GatewayMessage;
    try {
      msg = JSON.parse(data) as GatewayMessage;
    } catch {
      console.warn('[OpenClaw] Non-JSON message:', data);
      return;
    }

    if (msg.type === 'res') {
      this.handleResponse(msg);
    } else if (msg.type === 'event') {
      await this.handleEvent(msg);
    }
  }

  private handleResponse(res: GatewayResponse): void {
    const pending = this.pendingRequests.get(res.id);
    if (pending) {
      this.pendingRequests.delete(res.id);
      pending.resolve(res);
    }
  }

  private async handleEvent(event: GatewayEvent): Promise<void> {
    this.events$.next(event);

    switch (event.event) {
      case 'connect.challenge':
        await this.performHandshake(event.payload as { nonce: string; timestamp: number });
        break;

      case 'hello-ok':
        this.setStatus('connected');
        this.addSystemMessage('Connected to OpenClaw Gateway.');
        break;

      case 'agent':
        this.handleAgentEvent(event.payload as AgentEventPayload);
        break;

      case 'heartbeat':
        // Silently acknowledged
        break;

      case 'shutdown':
        this.setError('Gateway is shutting down.');
        this.disconnect();
        break;
    }
  }

  /** Step 2 of handshake: respond to server's challenge */
  private async performHandshake(challenge: { nonce: string; timestamp: number }): Promise<void> {
    const signature = await this.signNonce(challenge.nonce, this.settings.token);

    const params: ConnectParams = {
      version: PROTOCOL_VERSION,
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      device: {
        id: this.deviceId,
        name: this.settings.deviceName || 'Angular Integration',
        platform: 'web',
      },
      ...(this.settings.token ? { token: this.settings.token } : {}),
      challenge: signature,
    };

    this.send({ type: 'req', id: 0, method: 'connect', params: params as unknown as Record<string, unknown> });
  }

  /** HMAC-SHA256 sign of nonce using token as key */
  private async signNonce(nonce: string, key: string): Promise<string> {
    if (!key) return nonce; // No token — pass nonce as-is for localhost auto-approval

    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(nonce));
    return Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /** Handle streamed agent response chunks */
  private handleAgentEvent(payload: AgentEventPayload): void {
    if (!this.activeAgentMsgId) return;

    const { delta, content, status } = payload;

    if (delta) {
      // Append streaming chunk
      const current = this.messages$.value.find(
        (m) => m.id === this.activeAgentMsgId
      );
      this.updateMessage(this.activeAgentMsgId, {
        content: (current?.content ?? '') + delta,
      });
    }

    if (status === 'ok' || status === 'error') {
      this.updateMessage(this.activeAgentMsgId, {
        ...(content ? { content } : {}),
        status: status === 'ok' ? 'done' : 'error',
      });
      this.activeAgentMsgId = null;
    }
  }

  /** Generic RPC — returns a Promise resolved when the matching response arrives */
  private request(
    method: string,
    params?: Record<string, unknown>
  ): Promise<GatewayResponse> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket not open'));
      }
      const id = this.reqId++;
      this.pendingRequests.set(id, { resolve, reject });
      this.send({ type: 'req', id, method, params });

      // Timeout after 30 s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request "${method}" timed out`));
        }
      }, 30_000);
    });
  }

  private send(msg: GatewayRequest): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ─── Message Helpers ──────────────────────────────────────────────────────

  private addMessage(
    role: ChatMessage['role'],
    content: string,
    status: ChatMessage['status']
  ): ChatMessage {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      role,
      content,
      status,
      timestamp: new Date(),
    };
    this.messages$.next([...this.messages$.value, msg]);
    return msg;
  }

  private addSystemMessage(content: string): void {
    this.addMessage('system', content, 'done');
  }

  private updateMessage(
    id: string,
    patch: Partial<Pick<ChatMessage, 'content' | 'status'>>
  ): void {
    this.messages$.next(
      this.messages$.value.map((m) => (m.id === id ? { ...m, ...patch } : m))
    );
  }

  clearMessages(): void {
    this.messages$.next([]);
  }

  // ─── State Helpers ────────────────────────────────────────────────────────

  private setStatus(status: ConnectionStatus): void {
    this.status$.next(status);
  }

  private setError(msg: string): void {
    this.error$.next(msg);
    this.setStatus('error');
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private loadSettings(): OpenClawSettings {
    const stored = localStorage.getItem(STORAGE_KEY_SETTINGS);
    if (stored) {
      try {
        return JSON.parse(stored) as OpenClawSettings;
      } catch {}
    }
    return {
      gatewayUrl: environment.openclawGatewayUrl,
      token: '',
      deviceName: 'Angular Integration',
    };
  }

  private loadOrCreateDeviceId(): string {
    let id = localStorage.getItem(STORAGE_KEY_DEVICE_ID);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(STORAGE_KEY_DEVICE_ID, id);
    }
    return id;
  }

  ngOnDestroy(): void {
    this.disconnect();
    this.events$.complete();
  }
}
