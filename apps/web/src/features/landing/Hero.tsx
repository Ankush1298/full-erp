import { useRef, type CSSProperties } from 'react';
import { AnesaWindow } from './AnesaWindow';
import { HeroFlora } from './HeroFlora';
import { motionAllowed, usePointerDepth } from './motion';

const i = (n: number): CSSProperties => ({ '--i': n }) as CSSProperties;

/** Headline words rise out of a mask one after another. Whitespace between words keeps the heading readable as text. */
function Words({
  words,
  start,
}: {
  words: ReadonlyArray<{ t: string; accent?: boolean }>;
  start: number;
}) {
  return (
    <>
      {words.map((w, n) => (
        <span key={`${w.t}-${n}`}>
          <span className="hw">
            <span className={w.accent ? 'hw-in hw-accent' : 'hw-in'} style={i(start + n)}>
              {w.t}
            </span>
          </span>{' '}
        </span>
      ))}
    </>
  );
}

export function Hero({ onDemo }: { onDemo: () => void }) {
  const ref = useRef<HTMLElement>(null);
  usePointerDepth(ref, motionAllowed());

  return (
    <section className="lp-hero" id="top" aria-labelledby="hero-title" ref={ref}>
      <div className="hero-glow" aria-hidden="true" />
      <HeroFlora />
      <div className="lp-container hero-grid">
        <div className="hero-copy">
          <p className="hero-badge" style={i(0)}>
            <span aria-hidden="true" />
            Now in active development
          </p>
          <h1
            id="hero-title"
            className="hero-title"
            aria-label="One connected campus. Endless possibilities."
          >
            <span aria-hidden="true">
              <Words start={1} words={[{ t: 'One' }, { t: 'connected' }, { t: 'campus.' }]} />
              <Words start={4} words={[{ t: 'Endless' }, { t: 'possibilities.', accent: true }]} />
            </span>
          </h1>
          <p className="hero-lead" style={i(7)}>
            Anesa brings student records, academics, attendance and institutional operations
            together in one thoughtfully designed platform.
          </p>
          <div className="hero-cta" style={i(8)}>
            <a href="#contact" className="hero-btn hero-btn-primary" onClick={onDemo}>
              Request a Demo
            </a>
            <a href="#platform" className="hero-btn hero-btn-ghost">
              Explore Platform
              <span aria-hidden="true">↓</span>
            </a>
          </div>
          <p className="hero-note" style={i(9)}>
            Not yet piloted with an institution.
          </p>
        </div>

        <div
          className="hero-visual"
          role="img"
          aria-label="Illustration of the Anesa administration screen, with a setup checklist, a student list and a term timeline, using sample data."
        >
          <div className="hv-back" aria-hidden="true">
            <div className="hv-mini">
              <small>Students</small>
              {['S-0101', 'S-0102', 'S-0103'].map((s, n) => (
                <p key={s} style={{ '--k': n } as CSSProperties}>
                  <b>{s}</b>
                  <span>Active</span>
                </p>
              ))}
            </div>
          </div>
          <div className="hv-main" aria-hidden="true">
            <AnesaWindow scene={0} step={3} intro />
          </div>
          <div className="hv-front" aria-hidden="true">
            <div className="hv-mini hv-term">
              <small>Term timeline</small>
              <span className="hv-bar">
                <i />
              </span>
              <p>
                <b>Term</b>
                <b>Sections</b>
                <b>Offerings</b>
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
