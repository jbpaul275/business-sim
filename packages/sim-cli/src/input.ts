import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fromDisplay, type Money } from '@bizsim/money';

/**
 * A terminal and a pipe need different readers.
 *
 * `readline` pauses its stream between questions, so on a pipe it consumes one
 * line and the stream then ends underneath it — the pending question never
 * settles, the event loop drains, and the process exits mid-session with status
 * 0 as though nothing were wrong. A truncated run that looks successful is the
 * worst of both. So a non-TTY reads its input up front and replays it, which
 * also makes every flow scriptable.
 */
export interface LineSource {
  next(prompt: string): Promise<string | undefined>;
  close(): void;
}

function ttySource(): LineSource {
  const rl = createInterface({ input: stdin, output: stdout });
  let closed = false;
  rl.on('close', () => {
    closed = true;
  });
  return {
    async next(prompt) {
      if (closed) return undefined;
      try {
        return await rl.question(prompt);
      } catch {
        return undefined;
      }
    },
    close: () => rl.close(),
  };
}

async function pipedSource(): Promise<LineSource> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  const lines = Buffer.concat(chunks).toString('utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let i = 0;
  return {
    async next(prompt) {
      if (i >= lines.length) return undefined;
      const line = lines[i++] ?? '';
      // Echo, so a scripted transcript reads the same as a live one.
      console.log(`${prompt}${line}`);
      return line;
    },
    close: () => {},
  };
}

export const openInput = async (): Promise<LineSource> =>
  stdin.isTTY ? ttySource() : pipedSource();

/** Accepts `45`, `12000`, `12k`, `1.5m`, `$40,000`. */
export function parseMoney(raw: string): Money | undefined {
  const cleaned = raw.trim().replace(/[$,]/g, '').toLowerCase();
  const match = /^(-?\d*\.?\d+)([km])?$/.exec(cleaned);
  if (!match) return undefined;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return undefined;
  const scale = match[2] === 'k' ? 1_000 : match[2] === 'm' ? 1_000_000 : 1;
  return fromDisplay(base * scale);
}

/** Ask until the answer parses. A blank line takes the default. */
export async function ask<T>(
  input: LineSource,
  prompt: string,
  fallback: T,
  parse: (raw: string) => T | undefined,
): Promise<T> {
  while (true) {
    const raw = await input.next(prompt);
    if (raw === undefined) return fallback; // end of input — take the default
    if (raw.trim() === '') return fallback;
    const parsed = parse(raw);
    if (parsed !== undefined) return parsed;
    console.log('  Could not read that. Try again, or press enter for the default.');
  }
}

export const parseNumber = (raw: string): number | undefined => {
  const n = Number(raw.trim().replace(/[,_]/g, ''));
  return Number.isFinite(n) ? n : undefined;
};
