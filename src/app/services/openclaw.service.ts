import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject, Observable, filter, map, timeout, firstValueFrom } from 'rxjs';
import {
  ConnectionStatus,
  GatewayEvent,
  GatewayMessage,
  GatewayRequest,
  GatewayResponse,
  OpenClawSettings,
  ChatMessage,
  ChatEventPayload,
  ConnectParams,
} from '../models/openclaw.models';
import { environment } from '../../environments/environment';

const STORAGE_KEY_KEYPAIR = 'openclaw_keypair';
const STORAGE_KEY_SETTINGS = 'openclaw_settings';
const PROTOCOL_VERSION = 3;
// Ed25519 SPKI DER prefix — strip to get raw 32-byte public key
const ED25519_SPKI_PREFIX_LEN = 12;

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
    string,
    { resolve: (v: GatewayResponse) => void; reject: (e: Error) => void }
  >();
  private events$ = new Subject<GatewayEvent>();
  private activeAgentMsgId: string | null = null;
  private sessionKey: string | null = null;

  private settings: OpenClawSettings = this.loadSettings();

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
      this.pendingRequests.forEach((p) => p.reject(new Error('Connection closed')));
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
      const res = await this.request('chat.send', {
        sessionKey: this.sessionKey ?? 'main',
        message: text,
        idempotencyKey: crypto.randomUUID(),
      });

      if (!res.ok) {
        this.updateMessage(agentMsg.id, {
          content: res.error?.message ?? 'Request failed.',
          status: 'error',
        });
      }
      // Streamed chunks arrive via chat events — see handleChatEvent()
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
    // hello-ok arrives as res payload for the connect request (id "0")
    if (res.id === '0' && res.ok && (res.payload as { type?: string })?.type === 'hello-ok') {
      const helloOk = res.payload as {
        snapshot?: { sessionDefaults?: { mainSessionKey?: string } };
      };
      this.sessionKey = helloOk.snapshot?.sessionDefaults?.mainSessionKey ?? null;
      this.setStatus('connected');
      this.addSystemMessage('Connected to OpenClaw Gateway.');
      return;
    }

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

      case 'chat':
        this.handleChatEvent(event.payload as ChatEventPayload);
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

  /** Step 2 of handshake: sign challenge with Ed25519 device key and send connect */
  private async performHandshake(challenge: { nonce: string; timestamp: number }): Promise<void> {
    const { deviceId, publicKeyBase64Url, privateKey } = await this.ensureKeyPair();

    const signedAt = Date.now();
    const scopes = ['operator.read', 'operator.write', 'operator.admin'];
    const token = this.settings.token ?? '';

    // Payload format defined by openclaw protocol v3:
    // v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily
    const payload = [
      'v3',
      deviceId,
      'webchat',
      'webchat',
      'operator',
      scopes.join(','),
      String(signedAt),
      token,
      challenge.nonce,
      'web',
      '',
    ].join('|');

    const sigBuffer = await crypto.subtle.sign(
      { name: 'Ed25519' },
      privateKey,
      new TextEncoder().encode(payload),
    );

    const params: ConnectParams = {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: 'webchat',
        version: '1.0.0',
        platform: 'web',
        mode: 'webchat',
        displayName: this.settings.deviceName || 'Angular Integration',
      },
      role: 'operator',
      scopes, // operator.read, operator.write, operator.admin
      device: {
        id: deviceId,
        publicKey: publicKeyBase64Url,
        signature: this.toBase64Url(new Uint8Array(sigBuffer)),
        signedAt,
        nonce: challenge.nonce,
      },
      ...(token ? { auth: { token } } : {}),
    };

    this.send({
      type: 'req',
      id: '0',
      method: 'connect',
      params: params as unknown as Record<string, unknown>,
    });
  }

  /** Load or generate a persistent Ed25519 keypair; derive device ID from public key */
  private async ensureKeyPair(): Promise<{
    deviceId: string;
    publicKeyBase64Url: string;
    privateKey: CryptoKey;
  }> {
    const stored = localStorage.getItem(STORAGE_KEY_KEYPAIR);
    if (stored) {
      try {
        const { privateJwk, publicJwk } = JSON.parse(stored);
        const privateKey = await crypto.subtle.importKey(
          'jwk',
          privateJwk,
          { name: 'Ed25519' },
          false,
          ['sign'],
        );
        const publicKey = await crypto.subtle.importKey(
          'jwk',
          publicJwk,
          { name: 'Ed25519' },
          true,
          ['verify'],
        );
        const { deviceId, publicKeyBase64Url } = await this.deriveDeviceInfo(publicKey);
        return { deviceId, publicKeyBase64Url, privateKey };
      } catch {
        /* fall through to regenerate */
      }
    }

    const keyPair = (await crypto.subtle.generateKey(
      { name: 'Ed25519' } as AlgorithmIdentifier,
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const [privateJwk, publicJwk] = await Promise.all([
      crypto.subtle.exportKey('jwk', keyPair.privateKey),
      crypto.subtle.exportKey('jwk', keyPair.publicKey),
    ]);
    localStorage.setItem(STORAGE_KEY_KEYPAIR, JSON.stringify({ privateJwk, publicJwk }));
    const { deviceId, publicKeyBase64Url } = await this.deriveDeviceInfo(keyPair.publicKey);
    return { deviceId, publicKeyBase64Url, privateKey: keyPair.privateKey };
  }

  private async deriveDeviceInfo(
    publicKey: CryptoKey,
  ): Promise<{ deviceId: string; publicKeyBase64Url: string }> {
    const spki = await crypto.subtle.exportKey('spki', publicKey);
    const rawKey = new Uint8Array(spki).slice(ED25519_SPKI_PREFIX_LEN);
    const publicKeyBase64Url = this.toBase64Url(rawKey);
    const hashBuf = await crypto.subtle.digest('SHA-256', rawKey);
    const deviceId = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return { deviceId, publicKeyBase64Url };
  }

  private toBase64Url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }

  /** Handle streamed chat response events (state = delta | final | aborted | error) */
  private handleChatEvent(payload: ChatEventPayload): void {
    if (!this.activeAgentMsgId) return;

    const { state, message, errorMessage } = payload;
    const text = message?.content?.[0]?.text;

    if (state === 'delta' && text !== undefined) {
      // text is cumulative — set, don't append
      this.updateMessage(this.activeAgentMsgId, { content: text });
    } else if (state === 'final') {
      this.updateMessage(this.activeAgentMsgId, {
        ...(text !== undefined ? { content: text } : {}),
        status: 'done',
      });
      this.activeAgentMsgId = null;
    } else if (state === 'error' || state === 'aborted') {
      this.updateMessage(this.activeAgentMsgId, {
        content: errorMessage ?? (state === 'aborted' ? 'Aborted.' : 'Error.'),
        status: 'error',
      });
      this.activeAgentMsgId = null;
    }
  }

  /** Generic RPC — returns a Promise resolved when the matching response arrives */
  private request(method: string, params?: Record<string, unknown>): Promise<GatewayResponse> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket not open'));
      }
      const id = String(this.reqId++);
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
    status: ChatMessage['status'],
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

  private updateMessage(id: string, patch: Partial<Pick<ChatMessage, 'content' | 'status'>>): void {
    this.messages$.next(this.messages$.value.map((m) => (m.id === id ? { ...m, ...patch } : m)));
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

  ngOnDestroy(): void {
    this.disconnect();
    this.events$.complete();
  }
}
