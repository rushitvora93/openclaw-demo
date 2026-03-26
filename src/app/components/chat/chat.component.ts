import {
  Component,
  OnInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  AfterViewChecked,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { OpenClawService } from '../../services/openclaw.service';
import { ChatMessage, ConnectionStatus, OpenClawSettings } from '../../models/openclaw.models';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.scss',
})
export class ChatComponent implements OnInit, OnDestroy, AfterViewChecked {
  @ViewChild('messageList') messageListRef!: ElementRef<HTMLDivElement>;
  @ViewChild('input') inputRef!: ElementRef<HTMLTextAreaElement>;

  messages: ChatMessage[] = [];
  status: ConnectionStatus = 'disconnected';
  error: string | null = null;
  inputText = '';
  sending = false;
  showSettings = false;
  healthInfo: unknown = null;

  settings: OpenClawSettings;

  private readonly openclaw = inject(OpenClawService);
  private subs = new Subscription();
  private shouldScrollBottom = false;

  constructor() {
    this.settings = this.openclaw.getSettings();
  }

  ngOnInit(): void {
    this.subs.add(
      this.openclaw.messages$.subscribe((msgs) => {
        this.messages = msgs;
        this.shouldScrollBottom = true;
      }),
    );
    this.subs.add(this.openclaw.status$.subscribe((s) => (this.status = s)));
    this.subs.add(this.openclaw.error$.subscribe((e) => (this.error = e)));
  }

  ngAfterViewChecked(): void {
    if (this.shouldScrollBottom) {
      this.scrollToBottom();
      this.shouldScrollBottom = false;
    }
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  // ─── Connection ───────────────────────────────────────────────────────────

  connect(): void {
    this.openclaw.connect();
  }

  disconnect(): void {
    this.openclaw.disconnect();
  }

  // ─── Messaging ────────────────────────────────────────────────────────────

  async send(): Promise<void> {
    const text = this.inputText.trim();
    if (!text || this.sending || this.status !== 'connected') return;

    this.inputText = '';
    this.sending = true;
    try {
      await this.openclaw.sendMessage(text);
    } catch (err) {
      console.error('[Chat] Send error:', err);
    } finally {
      this.sending = false;
    }
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  clearChat(): void {
    this.openclaw.clearMessages();
  }

  // ─── Health Check ─────────────────────────────────────────────────────────

  async checkHealth(): Promise<void> {
    try {
      this.healthInfo = await this.openclaw.getHealth();
    } catch (err) {
      this.healthInfo = { error: String(err) };
    }
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  saveSettings(): void {
    this.openclaw.saveSettings(this.settings);
    this.showSettings = false;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  get isConnected(): boolean {
    return this.status === 'connected';
  }

  get statusLabel(): string {
    const labels: Record<ConnectionStatus, string> = {
      disconnected: 'Disconnected',
      connecting: 'Connecting...',
      authenticating: 'Authenticating...',
      connected: 'Connected',
      error: 'Error',
    };
    return labels[this.status];
  }

  get statusClass(): string {
    return this.status;
  }

  trackById(_: number, msg: ChatMessage): string {
    return msg.id;
  }

  private scrollToBottom(): void {
    const el = this.messageListRef?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }
}
