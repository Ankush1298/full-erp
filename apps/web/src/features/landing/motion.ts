import { useEffect, useRef, useState, type RefObject } from 'react';

/** Steps inside one showcase scene (a checklist item ticks, a row appears, ...). */
export const STEPS = 5;

/** Motion is on only where scripting, IntersectionObserver and matchMedia exist and the visitor has not asked for less. */
export function motionAllowed(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    typeof IntersectionObserver !== 'undefined' &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export interface SceneState {
  scene: number;
  step: number;
}

/**
 * Scroll-scrubbed scenes for a tall section that contains a `position: sticky` stage. The page scrolls normally (nothing
 * is hijacked). While the section is near the viewport, one passive scroll listener (batched to animation frames) turns
 * the scroll position into:
 *   --p   0..1 progress through the whole section        (written to the stage element, no React render)
 *   --sp  0..1 progress through the current scene         (same)
 *   scene, step  discrete values, which re-render React only when they change.
 * Without motion the section is an ordinary block, `scene` is chosen by the tabs and every step is complete.
 */
export function useScrollScenes(
  section: RefObject<HTMLElement | null>,
  stage: RefObject<HTMLElement | null>,
  count: number,
  enabled: boolean,
) {
  const [state, setState] = useState<SceneState>({ scene: 0, step: enabled ? 0 : STEPS });

  useEffect(() => {
    const sec = section.current;
    const st = stage.current;
    if (!enabled || !sec || !st) return;
    let frame = 0;
    let listening = false;

    const update = () => {
      frame = 0;
      const r = sec.getBoundingClientRect();
      const total = Math.max(1, r.height - window.innerHeight);
      const p = Math.min(1, Math.max(0, -r.top / total));
      const scaled = p * count;
      const scene = Math.min(count - 1, Math.floor(scaled));
      const sp = Math.min(1, scaled - scene);
      st.style.setProperty('--p', p.toFixed(4));
      st.style.setProperty('--sp', sp.toFixed(4));
      // steps complete at ~85% of a scene, leaving a short dwell before the next one begins
      const step = Math.min(STEPS, Math.floor(sp * STEPS * 1.18));
      setState((prev) => (prev.scene === scene && prev.step === step ? prev : { scene, step }));
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    const attach = () => {
      if (listening) return;
      listening = true;
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);
      update();
    };
    const detach = () => {
      if (!listening) return;
      listening = false;
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
    const io = new IntersectionObserver(
      ([entry]) => (entry?.isIntersecting ? attach() : detach()),
      {
        rootMargin: '200px 0px',
      },
    );
    io.observe(sec);
    return () => {
      io.disconnect();
      detach();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [section, stage, count, enabled]);

  /** Tabs: scroll to the scene (motion), or just switch to it (static). */
  const select = (index: number) => {
    const sec = section.current;
    if (!enabled || !sec) {
      setState({ scene: index, step: STEPS });
      return;
    }
    const r = sec.getBoundingClientRect();
    const total = Math.max(1, r.height - window.innerHeight);
    const top = window.scrollY + r.top + ((index + 0.62) / count) * total;
    window.scrollTo({ top, behavior: 'smooth' });
  };

  return { state, select };
}

/**
 * Pointer depth: writes --mx and --my (-1..1) on the element while a fine pointer moves over it, and resets them
 * on leave. One listener, batched per frame, mouse only, never with reduced motion. CSS decides what moves.
 */
export function usePointerDepth(target: RefObject<HTMLElement | null>, enabled: boolean): void {
  const frame = useRef(0);
  useEffect(() => {
    const host = target.current;
    const el = host;
    if (!enabled || !el || !host) return;
    let x = 0;
    let y = 0;
    const apply = () => {
      frame.current = 0;
      el.style.setProperty('--mx', x.toFixed(3));
      el.style.setProperty('--my', y.toFixed(3));
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const r = host.getBoundingClientRect();
      x = ((e.clientX - r.left) / r.width) * 2 - 1;
      y = ((e.clientY - r.top) / r.height) * 2 - 1;
      if (!frame.current) frame.current = window.requestAnimationFrame(apply);
    };
    const leave = () => {
      x = 0;
      y = 0;
      if (!frame.current) frame.current = window.requestAnimationFrame(apply);
    };
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerleave', leave);
    return () => {
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerleave', leave);
      if (frame.current) window.cancelAnimationFrame(frame.current);
    };
  }, [target, enabled]);
}
