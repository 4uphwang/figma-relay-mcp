import { DEFAULT_PORT, ServerToPluginSchema, decodeFrame, encodeFrame } from '@figma-mcp/protocol';
import type { MainToUi, UiToMain } from '../bridgeTypes';
import { nextDelay } from '../lib/backoff';
import { HISTORY_LIMIT, type HistoryEntry, finishEntry, loadHistory, startEntry, toolName } from '../lib/history';

// Figma manifest는 devAllowedDomains에 127.0.0.1을 받지 않는다(docs/spike-results.md). 서버는 127.0.0.1에만 바인딩한다.
const WS_URL = `ws://localhost:${DEFAULT_PORT}`;
const CLOSE_BAD_TOKEN = 4001;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pillEl = $('pill');
const bannerEl = $('banner');
const bannerTitleEl = $('bannerTitle');
const bannerBodyEl = $('bannerBody');
const fileEl = $('file');
const serverEl = $('server');
const historyEl = $('history');
const historyTitleEl = $('historyTitle');
const entriesEl = $<HTMLOListElement>('entries');
const clearHistoryEl = $<HTMLButtonElement>('clearHistory');
const noteEl = $('note');
const retryEl = $<HTMLButtonElement>('retry');
const editTokenEl = $<HTMLButtonElement>('editToken');
const tokenFormEl = $<HTMLFormElement>('tokenForm');
const tokenEl = $<HTMLInputElement>('token');
const copyEl = $<HTMLButtonElement>('copy');
const cmdEl = $('cmd');

const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
let token = '';
let fileName = '';
let ws: WebSocket | undefined;
let attempt = 0;
let retryTimer: number | undefined;
let retryAt = 0;
const inbound = new Map<string, Uint8Array[]>();

type State = 'starting' | 'connecting' | 'connected' | 'waiting' | 'noToken' | 'badToken';
let state: State = 'starting';
let editingToken = false;
let history: HistoryEntry[] = [];
const pendingParams = new Map<string, unknown>();
const openEntries = new Set<string>();
let saveTimer: number | undefined;
let lastHeight = 0;

const toMain = (m: UiToMain) => parent.postMessage({ pluginMessage: m }, '*');

function ago(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 10) return '방금';
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  const d = new Date(Date.now() - ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const metaText = (e: HistoryEntry) =>
  `${e.ms === undefined ? '실행 중' : `${(e.ms / 1000).toFixed(1)}초`} · ${ago(Date.now() - e.at)}`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 기록이 바뀔 때만 다시 그린다(1초마다 그리면 펼친 코드의 스크롤·선택이 풀린다)
function renderHistory() {
  historyEl.hidden = history.length === 0;
  historyTitleEl.textContent = `활동 기록  ${history.length}`;
  entriesEl.replaceChildren(
    ...history.map((e) => {
      const item = el('li', 'entry');
      item.dataset.ok = e.ok === undefined ? 'pending' : String(e.ok);
      const expandable = Boolean(e.code || e.error);
      const open = expandable && openEntries.has(e.id);
      item.classList.toggle('expandable', expandable);
      item.classList.toggle('open', open);

      // 첫 줄: 도구·세션·시간, 둘째 줄: 요약·보기 (300px 창에 한 줄로 넣으면 요약이 사라진다)
      const top = el('div', 'entry-top');
      top.append(el('span', 'method', toolName(e.method)));
      if (e.client) top.append(el('span', 'client', e.client));
      const meta = el('span', 'meta', metaText(e));
      meta.dataset.entry = e.id;
      top.append(meta);
      item.append(top);

      const sub = el('div', 'entry-sub');
      sub.append(el('span', 'summary', e.summary));
      if (e.nodeIds.length) {
        const view = el('button', 'link', '보기');
        view.type = 'button';
        view.title = e.nodeIds.join(', ');
        view.onclick = (ev) => {
          ev.stopPropagation();
          toMain({ type: 'focusNodes', ids: e.nodeIds });
        };
        sub.append(view);
      }
      if (e.summary || e.nodeIds.length) item.append(sub);

      if (open) {
        if (e.error) item.append(el('div', 'entry-error', `${e.error.code} · ${e.error.message}`));
        if (e.code) {
          const pre = el('pre', '', e.code);
          pre.onclick = (ev) => ev.stopPropagation(); // 코드를 고르려고 누를 때 접히지 않게
          item.append(pre);
        }
      }
      if (expandable)
        item.onclick = () => {
          if (!openEntries.delete(e.id)) openEntries.add(e.id);
          renderHistory();
          render();
        };
      return item;
    }),
  );
}

function tickHistory() {
  for (const meta of entriesEl.querySelectorAll<HTMLElement>('.meta')) {
    const e = history.find((x) => x.id === meta.dataset.entry);
    if (e) meta.textContent = metaText(e);
  }
}

function saveHistory() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => toMain({ type: 'saveHistory', entries: history }), 500);
}

function updateHistory(next: HistoryEntry[]) {
  history = next.slice(0, HISTORY_LIMIT);
  renderHistory();
  render();
  saveHistory();
}

function render() {
  const tone = state === 'connected' ? 'ok' : state === 'noToken' || state === 'badToken' ? 'bad' : 'wait';
  document.body.dataset.tone = tone;
  pillEl.textContent = {
    starting: '시작 중',
    connecting: '연결 중',
    connected: '연결됨',
    waiting: '기다리는 중',
    noToken: '토큰 필요',
    badToken: '토큰 필요',
  }[state];

  const banner =
    state === 'waiting'
      ? ['서버에 연결하지 못했습니다', `Claude Code에서 figma-mcp 서버가 켜져 있는지 확인하세요. ${Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))}초 뒤 다시 시도합니다.`]
      : state === 'badToken'
        ? ['토큰이 맞지 않습니다', '터미널에서 아래 명령을 실행해 나온 값을 붙여 넣으세요.']
        : state === 'noToken'
          ? ['토큰을 넣어 주세요', '처음 연결할 때 한 번만 필요합니다. 터미널에서 아래 명령을 실행해 나온 값을 붙여 넣으세요.']
          : undefined;
  bannerEl.hidden = !banner;
  if (banner) [bannerTitleEl.textContent, bannerBodyEl.textContent] = banner;

  fileEl.textContent = fileName || '-';
  fileEl.title = fileName;
  serverEl.textContent = `localhost:${DEFAULT_PORT}`;

  const needsToken = state === 'noToken' || state === 'badToken';
  tokenFormEl.hidden = !(needsToken || editingToken);
  noteEl.hidden = state !== 'connected';
  retryEl.hidden = state !== 'waiting';
  editTokenEl.hidden = needsToken;
  editTokenEl.textContent = editingToken ? '닫기' : '토큰 변경';

  const height = Math.ceil(document.body.getBoundingClientRect().height);
  if (height !== lastHeight) toMain({ type: 'resize', height });
  lastHeight = height;
}

function setState(next: State) {
  state = next;
  render();
}

function connect() {
  window.clearTimeout(retryTimer);
  if (!token) {
    setState('noToken');
    return;
  }
  setState('connecting');
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
      editingToken = false;
      setState('connected');
      return;
    }
    const binaries = inbound.get(msg.id) ?? [];
    inbound.delete(msg.id);
    pendingParams.set(msg.id, msg.params);
    updateHistory([startEntry(msg.id, msg.method, msg.params, Date.now(), msg.client), ...history]);
    toMain({ type: 'request', id: msg.id, method: msg.method, params: msg.params, binaries });
  };

  sock.onclose = (ev: CloseEvent) => {
    if (ws !== sock) return;
    ws = undefined;
    if (ev.code === CLOSE_BAD_TOKEN) {
      setState('badToken');
      tokenEl.focus();
      return;
    }
    const delay = nextDelay(attempt++);
    retryAt = Date.now() + delay;
    retryTimer = window.setTimeout(connect, delay);
    setState('waiting');
  };
}

function reconnect() {
  const old = ws;
  ws = undefined;
  old?.close();
  attempt = 0;
  connect();
}

// 남은 초와 "N초 전"을 갱신한다
window.setInterval(() => {
  if (state === 'waiting') render();
  tickHistory();
}, 1000);

function recordResponse(msg: Extract<MainToUi, { type: 'response' }>) {
  const params = pendingParams.get(msg.id);
  pendingParams.delete(msg.id);
  const at = Date.now();
  updateHistory(history.map((e) => (e.id === msg.id ? finishEntry(e, params, msg, at) : e)));
}

window.onmessage = (ev: MessageEvent) => {
  const msg = (ev.data as { pluginMessage?: MainToUi } | undefined)?.pluginMessage;
  if (!msg) return;
  if (msg.type === 'init') {
    token = msg.token;
    fileName = msg.fileName;
    tokenEl.value = token;
    history = loadHistory(msg.history);
    renderHistory();
    connect();
    return;
  }
  if (msg.type === 'response') recordResponse(msg);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (msg.type === 'binary') ws.send(encodeFrame({ id: msg.id, part: msg.part }, msg.bytes) as Uint8Array<ArrayBuffer>);
  else ws.send(JSON.stringify(msg));
};

tokenFormEl.onsubmit = (ev) => {
  ev.preventDefault();
  token = tokenEl.value.trim();
  toMain({ type: 'saveToken', token });
  reconnect();
};

retryEl.onclick = reconnect;

clearHistoryEl.onclick = () => {
  openEntries.clear();
  updateHistory([]);
};

editTokenEl.onclick = () => {
  editingToken = !editingToken;
  render();
  if (editingToken) tokenEl.focus();
};

// 플러그인 iframe에서는 navigator.clipboard가 막혀 있어 execCommand를 쓴다
copyEl.onclick = () => {
  const area = document.createElement('textarea');
  area.value = cmdEl.textContent ?? '';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  area.remove();
  copyEl.textContent = '복사됨';
  window.setTimeout(() => (copyEl.textContent = '복사'), 1500);
};
