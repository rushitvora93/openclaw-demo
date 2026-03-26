# OpenClaw Angular Integration Sample

An Angular 19 chat interface that connects to a local [OpenClaw](https://openclaw.ai) Gateway via its WebSocket protocol.

## Prerequisites

1. **OpenClaw** installed and running:
   ```bash
   # Install
   iwr -useb https://openclaw.ai/install.ps1 | iex

   # First-time setup (~2 min)
   openclaw onboard --install-daemon

   # Start the Gateway
   openclaw gateway
   ```

2. **Node.js 18+** and **npm**

## Quick Start

```bash
npm install
npm start
```

Open `http://localhost:4200` in your browser.

## Configuration

Click **Settings** in the sidebar to configure:

| Setting | Default | Description |
|---|---|---|
| Gateway URL | `ws://127.0.0.1:18789` | OpenClaw WebSocket endpoint |
| Auth Token | *(empty)* | Set if `OPENCLAW_GATEWAY_TOKEN` is configured |
| Device Name | `Angular Integration` | Identifies this client in OpenClaw |

Settings are persisted in `localStorage`.

## How It Works

### WebSocket Protocol

OpenClaw uses a JSON-based RPC protocol over WebSocket with three message types:

| Type | Direction | Purpose |
|---|---|---|
| `req` | Client → Server | RPC call with `{ type, id, method, params }` |
| `res` | Server → Client | Response with `{ type, id, ok, payload/error }` |
| `event` | Server → Client | Push event with `{ type, event, payload }` |

### Connection Handshake

```
Client ──── WebSocket connect ────► Server
       ◄─── event: connect.challenge  (nonce + timestamp)
       ────► req: connect              (device identity + signed nonce + token)
       ◄─── event: hello-ok           (presence, health, stateVersion)
```

For **localhost** connections without a token, OpenClaw auto-approves the device.

### Agent Streaming

Responses stream as `agent` events with `delta` chunks:

```
Client ──► req: agent.run ────────► Server
       ◄── res: { ok, status:"accepted" }
       ◄── event: agent { delta:"Hello" }
       ◄── event: agent { delta:" there" }
       ◄── event: agent { status:"ok", content:"Hello there" }
```

## Project Structure

```
src/app/
├── models/
│   └── openclaw.models.ts      # All TypeScript interfaces
├── services/
│   └── openclaw.service.ts     # WebSocket service (connect, RPC, streaming)
└── components/
    └── chat/
        ├── chat.component.ts   # Chat UI logic
        ├── chat.component.html # Template
        └── chat.component.scss # Styles
```

## Tech Stack

- **Angular 19** with standalone components
- **RxJS** for reactive WebSocket handling
- **TypeScript** with strict typing
- **SCSS** for styling

## License

MIT
