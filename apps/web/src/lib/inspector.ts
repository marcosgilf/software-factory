import type { SessionEvent, SessionSnapshot } from '@factory/contracts';

export interface SseFrame {
  readonly id?: string;
  readonly event: string;
  readonly data: string;
}

/** Parse the event framing used by EventSource, including delimiters split across network chunks. */
export async function* parseSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = findEventBoundary(buffer);
      while (boundary !== undefined) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const frame = parseSseBlock(block);
        if (frame !== undefined) yield frame;
        boundary = findEventBoundary(buffer);
      }
    }

    buffer += decoder.decode();
    const finalFrame = parseSseBlock(buffer);
    if (finalFrame !== undefined) yield finalFrame;
  } finally {
    reader.releaseLock();
  }
}

export function parseSessionEvent(frame: SseFrame): SessionEvent | undefined {
  if (frame.id === undefined || frame.event.length === 0) return undefined;
  try {
    const candidate: unknown = JSON.parse(frame.data);
    if (typeof candidate !== 'object' || candidate === null) return undefined;
    const event = candidate as Partial<SessionEvent>;
    if (
      event.id !== frame.id ||
      event.type !== frame.event ||
      (event.type !== 'snapshot' && event.type !== 'update' && event.type !== 'resync') ||
      typeof event.snapshot !== 'object' ||
      event.snapshot === null
    ) {
      return undefined;
    }
    return event as SessionEvent;
  } catch {
    return undefined;
  }
}

/** Full snapshots make replay and resync deterministic; stale updates cannot roll the view back. */
export function applySessionEvent(
  current: SessionSnapshot | undefined,
  event: SessionEvent,
): SessionSnapshot | undefined {
  if (event.type === 'snapshot' || event.type === 'resync') return event.snapshot;
  if (
    current === undefined ||
    current.session.id !== event.snapshot.session.id ||
    event.snapshot.revision <= current.revision
  ) {
    return current;
  }
  return event.snapshot;
}

function findEventBoundary(value: string): { index: number; length: number } | undefined {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(value);
  return match === null ? undefined : { index: match.index, length: match[0].length };
}

function parseSseBlock(block: string): SseFrame | undefined {
  let id: string | undefined;
  let event = 'message';
  const data: string[] = [];

  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line.length === 0 || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id' && !value.includes('\0')) id = value;
  }

  if (data.length === 0) return undefined;
  return { ...(id === undefined ? {} : { id }), event, data: data.join('\n') };
}
