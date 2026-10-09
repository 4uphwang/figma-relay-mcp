import { DEFAULT_PORT, ServerToPluginSchema, decodeFrame, encodeFrame } from '@figma-mcp/protocol';
import type { MainToUi, UiToMain } from '../bridgeTypes';
import { nextDelay } from '../lib/backoff';

const WS_URL = `ws://127.0.0.1:${DEFAULT_PORT}`;
const CLOSE_BAD_TOKEN = 4001;

const statusEl = document.getElementById('status') as HTMLDivElement;
const tokenEl = document.getElementById('token') as HTMLInputElement;
const saveEl = document.getElementById('save') as HTMLButtonElement;

const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
let token = '';
let fileName = '';
let ws: WebSocket | undefined;
let attempt = 0;
let retryTimer: number | undefined;
const inbound = new Map<string, Uint8Array[]>();

const toMain = (m: UiToMain) => parent.postMessage({ pluginMessage: m }, '*');

function setStatus(text: string, tone: 'ok' | 'wait' | 'bad') {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function connect() {
  window.clearTimeout(retryTimer);
  if (!token) {
    setStatus('토큰을 붙여 넣으세요 (~/.figma-mcp/token)', 'bad');
    return;
  }
  setStatus('연결 중…', 'wait');
  const sock = new WebSocket(WS_URL);
  sock.binaryType = 'arraybuffer';
  ws = sock;

  sock.onopen = () => sock.send(JSON.stringify({ type: 'hello', token, sessionId, fileName }));

  sock.onmessage = (ev: MessageEvent) => {
    if (ev.data instanceof ArrayBuffer) {
      const { header, payload } = decodeFrame(new Uint8Array(ev.data));
      const parts = inbound.get(header.id) ?? [];
      parts[header.part] = payload;
      inbound.set(header.id, parts);
      return;
    }
    const parsed = ServerToPluginSchema.safeParse(JSON.parse(String(ev.data)));
    if (!parsed.success) return;
    const msg = parsed.data;
    if (msg.type === 'welcome') {
      attempt = 0;
      setStatus(`연결됨 · ${fileName}`, 'ok');
      return;
    }
    const binaries = inbound.get(msg.id) ?? [];
    inbound.delete(msg.id);
    toMain({ type: 'request', id: msg.id, method: msg.method, params: msg.params, binaries });
  };

  sock.onclose = (ev: CloseEvent) => {
    if (ws !== sock) return;
    ws = undefined;
    if (ev.code === CLOSE_BAD_TOKEN) {
      setStatus('토큰이 틀립니다. ~/.figma-mcp/token 내용을 붙여 넣으세요', 'bad');
      return;
    }
    const delay = nextDelay(attempt++);
    setStatus(`서버를 기다리는 중… ${Math.round(delay / 1000)}초 뒤 다시 연결`, 'wait');
    retryTimer = window.setTimeout(connect, delay);
  };
}

window.onmessage = (ev: MessageEvent) => {
  const msg = (ev.data as { pluginMessage?: MainToUi } | undefined)?.pluginMessage;
  if (!msg) return;
  if (msg.type === 'init') {
    token = msg.token;
    fileName = msg.fileName;
    tokenEl.value = token;
    connect();
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (msg.type === 'binary') ws.send(encodeFrame({ id: msg.id, part: msg.part }, msg.bytes) as Uint8Array<ArrayBuffer>);
  else ws.send(JSON.stringify(msg));
};

saveEl.onclick = () => {
  token = tokenEl.value.trim();
  toMain({ type: 'saveToken', token });
  const old = ws;
  ws = undefined;
  old?.close();
  attempt = 0;
  connect();
};
