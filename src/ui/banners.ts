/**
 * Transient race banners/toasts (OVERTAKE, OVERRIDE ARMED, FINAL LAP, lap
 * complete). A tiny queue that fades one message at a time so overlapping race
 * events — lead flips fire 30-50x in a close 2026 duel — don't stack up.
 */
export type BannerKind = 'overtake' | 'override' | 'final' | 'lap' | 'info';

interface Banner {
  text: string;
  sub?: string;
  kind: BannerKind;
  ttl: number;
}

export interface BannerHandle {
  push(text: string, kind: BannerKind, sub?: string, ms?: number): void;
  tick(dt: number): void;
  clear(): void;
}

export function createBanners(container: HTMLElement): BannerHandle {
  const root = document.createElement('div');
  root.className = 'banners';
  container.appendChild(root);

  const el = document.createElement('div');
  el.className = 'banner';
  root.appendChild(el);

  const queue: Banner[] = [];
  let current: Banner | null = null;

  const showCurrent = (): void => {
    if (!current) { el.classList.remove('show'); return; }
    el.className = `banner show kind-${current.kind}`;
    el.innerHTML = current.sub
      ? `<span class="banner-main">${current.text}</span><span class="banner-sub">${current.sub}</span>`
      : `<span class="banner-main">${current.text}</span>`;
  };

  return {
    push(text, kind, sub, ms = 1800): void {
      // de-dupe: ignore an identical banner already showing/queued
      if (current?.text === text) return;
      if (queue.some((b) => b.text === text)) return;
      queue.push({ text, sub, kind, ttl: ms / 1000 });
    },
    tick(dt: number): void {
      if (!current && queue.length > 0) {
        current = queue.shift()!;
        showCurrent();
      }
      if (current) {
        current.ttl -= dt;
        if (current.ttl <= 0) {
          current = null;
          el.classList.remove('show');
        }
      }
    },
    clear(): void {
      queue.length = 0;
      current = null;
      el.classList.remove('show');
    },
  };
}
