import { randomUUID } from 'node:crypto';
import type { SessionEvent, SessionId, SessionSnapshot } from '@factory/contracts';
import type { CatalogSession } from '@factory/agent-runtime';

const HISTORY_LIMIT = 128;
const CLIENT_QUEUE_LIMIT = 32;

type Subscriber = {
  events: SessionEvent[];
  waiters: Array<() => void>;
  closed: boolean;
  resolveClosed: () => void;
};

export interface SessionEventSubscription {
  readonly initial: readonly SessionEvent[];
  readonly closed: boolean;
  readonly closedSignal: Promise<void>;
  next(): Promise<SessionEvent | undefined>;
  close(): void;
}

/** Per-process bounded replay log. Its epoch makes old cursors resync after a server restart. */
export class SessionEventHub {
  readonly #session: CatalogSession;
  readonly #epoch: string;
  readonly #history: SessionEvent[] = [];
  readonly #subscribers = new Set<Subscriber>();
  #latest: SessionSnapshot | undefined;
  #revision = 0;
  #readyPromise: Promise<void> | undefined;
  #unsubscribeSession: (() => void) | undefined;
  #dirtyDuringInitialization = false;
  #closed = false;

  constructor(session: CatalogSession, epoch = randomUUID()) {
    this.#session = session;
    this.#epoch = epoch;
  }

  async subscribe(lastEventId?: string): Promise<SessionEventSubscription> {
    await this.#ensureReady();
    if (this.#closed) throw new Error('Session event hub is closed.');
    const initial = this.#eventsAfter(lastEventId);
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
    const subscriber: Subscriber = { events: [], waiters: [], closed: false, resolveClosed };
    this.#subscribers.add(subscriber);

    return {
      initial,
      get closed() {
        return subscriber.closed;
      },
      closedSignal: closed,
      next: async () => {
        if (subscriber.events.length > 0) return subscriber.events.shift();
        if (subscriber.closed) return undefined;
        await new Promise<void>((resolve) => subscriber.waiters.push(resolve));
        if (subscriber.events.length > 0) return subscriber.events.shift();
        return undefined;
      },
      close: () => this.#closeSubscriber(subscriber),
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeSession?.();
    this.#unsubscribeSession = undefined;
    for (const subscriber of [...this.#subscribers]) this.#closeSubscriber(subscriber);
  }

  async #ensureReady(): Promise<void> {
    if (this.#closed) throw new Error('Session event hub is closed.');
    if (this.#readyPromise !== undefined) return this.#readyPromise;

    this.#readyPromise = (async () => {
      this.#unsubscribeSession = this.#session.observe((snapshot) => {
        if (this.#latest === undefined) {
          this.#dirtyDuringInitialization = true;
          return;
        }
        this.#acceptSnapshot(snapshot);
      });

      this.#latest = await this.#session.getSnapshot();
      if (this.#closed) return;
      this.#publish('snapshot', this.#latest);

      if (this.#dirtyDuringInitialization) {
        this.#dirtyDuringInitialization = false;
        this.#acceptSnapshot(await this.#session.getSnapshot());
      }
    })();
    return this.#readyPromise;
  }

  #closeSubscriber(subscriber: Subscriber): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    this.#subscribers.delete(subscriber);
    subscriber.resolveClosed();
    for (const wake of subscriber.waiters.splice(0)) wake();
  }

  #acceptSnapshot(snapshot: SessionSnapshot): void {
    if (this.#latest === undefined || snapshot.revision > this.#latest.revision) {
      this.#latest = snapshot;
      this.#publish('update', snapshot);
    }
  }

  #eventsAfter(lastEventId?: string): readonly SessionEvent[] {
    if (lastEventId === undefined || lastEventId.length === 0) {
      return [this.#publish('snapshot', this.#latest!)];
    }

    const cursor = this.#parseId(lastEventId);
    if (cursor === undefined || cursor > this.#revision) {
      return [this.#publish('resync', this.#latest!)];
    }

    const oldest = this.#history[0];
    const oldestRevision = oldest === undefined ? this.#revision : this.#parseId(oldest.id);
    if (oldestRevision === undefined || cursor < oldestRevision - 1) {
      return [this.#publish('resync', this.#latest!)];
    }

    return this.#history.filter((event) => (this.#parseId(event.id) ?? 0) > cursor);
  }

  #publish(type: SessionEvent['type'], snapshot: SessionSnapshot): SessionEvent {
    const event: SessionEvent = {
      type,
      id: `${this.#epoch}/${this.#session.id}/${++this.#revision}`,
      snapshot,
    };
    this.#history.push(event);
    if (this.#history.length > HISTORY_LIMIT) this.#history.shift();

    for (const subscriber of this.#subscribers) {
      if (subscriber.closed) continue;
      subscriber.events.push(event);
      if (subscriber.events.length > CLIENT_QUEUE_LIMIT) subscriber.events.shift();
      for (const wake of subscriber.waiters.splice(0)) wake();
    }
    return event;
  }

  #parseId(id: string): number | undefined {
    const [epoch, sessionId, revision, extra] = id.split('/');
    if (
      epoch !== this.#epoch ||
      sessionId !== this.#session.id ||
      extra !== undefined ||
      revision === undefined ||
      !/^[1-9][0-9]*$/.test(revision)
    ) {
      return undefined;
    }
    return Number(revision);
  }
}

export class SessionEventHubs {
  readonly #hubs = new Map<SessionId, SessionEventHub>();
  readonly #epoch = randomUUID();
  #closed = false;

  forSession(session: CatalogSession): SessionEventHub {
    if (this.#closed) throw new Error('Session event hubs are closed.');
    let hub = this.#hubs.get(session.id);
    if (hub === undefined) {
      hub = new SessionEventHub(session, this.#epoch);
      this.#hubs.set(session.id, hub);
    }
    return hub;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const hub of this.#hubs.values()) hub.close();
    this.#hubs.clear();
  }
}
