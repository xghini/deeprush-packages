// Passive watch on one page over a CDP connection of its own: page and child-frame lifecycle and network,
// as events. It only listens: Page and Network are enabled on this connection alone (the page cannot see
// it), out-of-process frames are auto-attached, nothing is clicked or evaluated.
//
// From 1426 千窗's Arena human-check watch (2026-10-06/07):
// - Page.* events arrive only after Page.enable on this connection (screencast does not enable them);
// - cross-site iframes (reCAPTCHA) are separate targets: Target.setAutoAttach with flatten, then
//   Page/Network enabled on each child session; a child's URL can arrive empty and follow in
//   Target.targetInfoChanged;
// - a request can start on the parent's session and finish on the child's: requests are keyed by
//   requestId alone (unique across the page and its frames);
// - the connection is reopened after RETRY_MS when it drops, for as long as the watch is open.
//
// Needs a global WebSocket (Node 22+).

export type PageWatchEvent =
  | {type: 'open'}
  | {type: 'mainNavigated'; url: string}
  | {type: 'load'; child?: string}
  | {type: 'childAttached'; session: string; url: string; kind: string}
  | {type: 'childUrl'; session: string; url: string}
  | {type: 'childDetached'; session: string; url: string}
  | {type: 'request'; requestId: string; url: string; method: string; child?: string}
  | {type: 'response'; requestId: string; url: string; status: number; child?: string}
  | {type: 'loadingFailed'; requestId: string; url: string; errorText: string; canceled: boolean; child?: string};

export type PageWatchOptions = {
  /** The page's CDP WebSocket URL now (null when the page cannot be found; retried later). */
  resolveWsUrl: () => Promise<string | null>;
  onEvent: (event: PageWatchEvent) => void;
  /** Only requests whose URL passes are tracked (default: all). */
  trackRequest?: (url: string) => boolean;
  retryMs?: number;
};

export type PageWatch = {close: () => void};

export function watchPage(options: PageWatchOptions): PageWatch {
  const retryMs = options.retryMs ?? 30_000;
  let socket: WebSocket | null = null;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let nextId = 0;
  const childUrl = new Map<string, string>();
  const sessionOfTarget = new Map<string, string>();
  // requestId -> URL and the child session it runs on (dropped with that session: a removed frame's
  // requests never finish, and reCAPTCHA swaps its frame every 20 s).
  const requests = new Map<string, {url: string; session?: string}>();
  const emit = (event: PageWatchEvent) => {
    try {
      options.onEvent(event);
    } catch {
      // A consumer's error must not stop the watch.
    }
  };
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({id: ++nextId, method, params, ...(sessionId ? {sessionId} : {})}));
  };
  const retry = () => {
    if (closed) return;
    childUrl.clear();
    sessionOfTarget.clear();
    requests.clear();
    retryTimer = setTimeout(() => void open(), retryMs);
  };
  const onMessage = (msg: any) => {
    const p = msg.params || {};
    const sid: string | undefined = msg.sessionId || undefined;
    const child = sid ? childUrl.get(sid) ?? '' : undefined;
    switch (msg.method) {
      case 'Target.attachedToTarget':
        childUrl.set(p.sessionId, p.targetInfo?.url || '');
        sessionOfTarget.set(p.targetInfo?.targetId, p.sessionId);
        send('Network.enable', {}, p.sessionId);
        send('Page.enable', {}, p.sessionId);
        send('Runtime.runIfWaitingForDebugger', {}, p.sessionId);
        emit({type: 'childAttached', session: p.sessionId, url: p.targetInfo?.url || '', kind: p.targetInfo?.type || ''});
        break;
      case 'Target.targetInfoChanged': {
        const session = sessionOfTarget.get(p.targetInfo?.targetId);
        if (session) {
          childUrl.set(session, p.targetInfo.url || '');
          emit({type: 'childUrl', session, url: p.targetInfo.url || ''});
        }
        break;
      }
      case 'Target.detachedFromTarget': {
        const url = childUrl.get(p.sessionId) || '';
        childUrl.delete(p.sessionId);
        for (const [target, session] of sessionOfTarget) if (session === p.sessionId) sessionOfTarget.delete(target);
        for (const [requestId, request] of requests) if (request.session === p.sessionId) requests.delete(requestId);
        emit({type: 'childDetached', session: p.sessionId, url});
        break;
      }
      case 'Page.frameNavigated':
        if (!sid && !p.frame?.parentId) emit({type: 'mainNavigated', url: p.frame?.url || ''});
        break;
      case 'Page.loadEventFired':
        emit(sid ? {type: 'load', child} : {type: 'load'});
        break;
      case 'Network.requestWillBeSent': {
        const url: string = p.request?.url || '';
        if (options.trackRequest && !options.trackRequest(url)) break;
        requests.set(p.requestId, {url, session: sid});
        emit({type: 'request', requestId: p.requestId, url, method: p.request?.method || '', ...(sid ? {child} : {})});
        break;
      }
      case 'Network.responseReceived': {
        const request = requests.get(p.requestId);
        if (!request) break;
        requests.delete(p.requestId);
        emit({type: 'response', requestId: p.requestId, url: request.url, status: Number(p.response?.status), ...(sid ? {child} : {})});
        break;
      }
      case 'Network.loadingFailed': {
        const request = requests.get(p.requestId);
        if (!request) break;
        requests.delete(p.requestId);
        emit({type: 'loadingFailed', requestId: p.requestId, url: request.url, errorText: p.errorText || '', canceled: Boolean(p.canceled), ...(sid ? {child} : {})});
        break;
      }
    }
  };
  const open = async () => {
    // A resolver or URL that throws is retried like a page not found (and never rejects unhandled).
    const wsUrl = await Promise.resolve().then(() => options.resolveWsUrl()).catch(() => null);
    if (closed) return;
    if (!wsUrl) return retry();
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      return retry();
    }
    socket = ws;
    ws.onopen = () => {
      send('Page.enable');
      send('Network.enable');
      send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: false, flatten: true});
      emit({type: 'open'});
    };
    ws.onmessage = (event) => {
      try {
        onMessage(JSON.parse(String(event.data)));
      } catch {
        // Not JSON: ignore.
      }
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      retry();
    };
    ws.onerror = () => {};
  };
  void open();
  return {
    close: () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      socket = null;
    },
  };
}
