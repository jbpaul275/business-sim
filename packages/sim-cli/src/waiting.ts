/**
 * Something to look at while the model thinks.
 *
 * A terminal that has printed nothing for forty seconds is indistinguishable
 * from a terminal that has crashed — and after several runs that genuinely did
 * crash, the assumption goes the wrong way. This does not make anything
 * faster. It makes the difference between waiting and wondering.
 *
 * The elapsed count is deliberate rather than decorative: knowing a turn takes
 * twenty seconds is useful, and a spinner alone hides it.
 */

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export interface Waiting {
  stop(): void;
  /** Change what it says mid-wait, when the work changes underneath. */
  label(next: string): void;
}

/**
 * Only animates on a TTY. Piped output — tests, transcripts, CI — gets nothing,
 * because a stream of control characters in a log is worse than silence.
 */
export function waiting(label: string): Waiting {
  if (!process.stdout.isTTY) return { stop: () => {}, label: () => {} };

  const started = Date.now();
  let frame = 0;
  let text = label;

  const render = (): void => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    const elapsed = seconds > 2 ? ` ${seconds}s` : '';
    process.stdout.write(`\r${DIM}  ${FRAMES[frame % FRAMES.length]} ${text}${elapsed}${RESET}\x1b[K`);
    frame += 1;
  };

  render();
  const timer = setInterval(render, 90);
  // Do not hold the process open on this: a pending interval outliving the
  // interview would keep the CLI alive after it had nothing left to do.
  timer.unref?.();

  return {
    stop: () => {
      clearInterval(timer);
      process.stdout.write('\r\x1b[K');
    },
    label: (next: string) => {
      text = next;
    },
  };
}
