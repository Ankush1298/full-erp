import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { Link, useNavigate } from 'react-router';
import { Footer } from '../../components/Footer';
import { Logo } from '../../components/Logo';
import { usePageTitle } from '../../components/usePageTitle';
import { LoginForm } from '../auth/LoginForm';
import {
  CHALLENGES,
  FAQ,
  FEATURES,
  NAV_LINKS,
  SECURITY_FACTS,
  SOLUTIONS,
  STATUS_LABEL,
  STEPS,
  type FeatureStatus,
} from './content';
import { EnquiryForm } from './EnquiryForm';
import { Hero } from './Hero';
import { Showcase } from './Showcase';
import './landing.css';
import './landing-hero.css';

const TITLE = 'Anesa: one connected campus platform for schools, colleges and universities';
const DESCRIPTION =
  'Anesa brings student records, academics, enrolment, people and access together in one secure platform. See what is available today and what is still in development.';

const index = (i: number): CSSProperties => ({ '--i': i }) as CSSProperties;

/** Sets the page description and social-preview tags while the landing page is mounted, then restores them. */
function useSocialMeta(): void {
  useEffect(() => {
    const touched: Array<{ el: HTMLMetaElement; previous: string | null; created: boolean }> = [];
    const set = (attr: 'name' | 'property', key: string, content: string) => {
      let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
      const created = !el;
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, key);
        document.head.appendChild(el);
      }
      touched.push({ el, previous: created ? null : el.getAttribute('content'), created });
      el.setAttribute('content', content);
    };
    set('name', 'description', DESCRIPTION);
    set('property', 'og:title', TITLE);
    set('property', 'og:description', DESCRIPTION);
    set('property', 'og:type', 'website');
    set('name', 'twitter:card', 'summary');
    return () => {
      for (const { el, previous, created } of touched) {
        if (created) el.remove();
        else if (previous !== null) el.setAttribute('content', previous);
      }
    };
  }, []);
}

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Scroll reveals: elements marked `data-reveal` fade and rise once, when they first enter the viewport. Without
 * IntersectionObserver, or with reduced motion, everything is simply visible. One observer for the whole page and
 * nothing runs on scroll events.
 */
function useReveal(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const targets = Array.from(host.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
      targets.forEach((t) => t.classList.add('is-visible'));
      return;
    }
    host.classList.add('js-reveal');
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.12 },
    );
    targets.forEach((t) => io.observe(t));
    return () => {
      io.disconnect();
      host.classList.remove('js-reveal');
    };
  }, [root]);
}

interface LandingPageProps {
  signInOpen?: boolean;
  from?: string;
  /** Overrides the document title (used when another overlay, such as the two-factor prompt, sits over the page). */
  pageTitle?: string;
  /** An overlay (dialog) rendered over the page instead of the sign-in dialog. */
  children?: ReactNode;
}

export function LandingPage({
  signInOpen = false,
  from = '/',
  pageTitle,
  children,
}: LandingPageProps) {
  usePageTitle(pageTitle ?? (signInOpen ? 'Sign in' : TITLE));
  useSocialMeta();
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLAnchorElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [onDark, setOnDark] = useState(true);
  const [scrolled, setScrolled] = useState(false);
  const darkZone = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useReveal(rootRef);

  // Smooth in-page navigation only while this page is mounted (the logged-in app keeps its own scrolling).
  useEffect(() => {
    document.documentElement.classList.add('landing-scroll');
    return () => document.documentElement.classList.remove('landing-scroll');
  }, []);

  const close = () => {
    void navigate('/', { replace: true });
    triggerRef.current?.focus();
  };

  // Sign-in dialog: Escape closes, Tab stays inside, and the page behind does not scroll.
  useEffect(() => {
    if (!signInOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void navigate('/', { replace: true });
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
    };
  }, [signInOpen, navigate]);

  // Navigation theme: transparent on the dark canvas, light and frosted once the page below it is reached.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const zone = darkZone.current;
      setOnDark(zone ? zone.getBoundingClientRect().bottom > 72 : false);
      setScrolled(window.scrollY > 24);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  // The full-screen mobile menu locks page scrolling while it is open.
  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [menuOpen]);

  // Mobile menu: Escape closes it.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  /** Every "Request a demo" button goes to the same enquiry form and puts the cursor in its first field. */
  const goToEnquiry = () => {
    setMenuOpen(false);
    window.setTimeout(() => {
      document
        .querySelector<HTMLInputElement>('#contact input[name="name"]')
        ?.focus({ preventScroll: true });
    }, 450);
  };

  return (
    <div className="landing" ref={rootRef}>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <header
        className="lp-bar"
        data-theme={onDark ? 'dark' : 'light'}
        data-scrolled={scrolled || undefined}
        data-menu={menuOpen || undefined}
      >
        <div className="lp-bar-inner">
          <a href="#top" className="lp-brand" aria-label="Anesa, back to top">
            <Logo variant={onDark || menuOpen ? 'light' : 'default'} />
          </a>
          <button
            type="button"
            className="lp-menu-button"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <span className="lp-menu-icon" aria-hidden="true" />
            <span>{menuOpen ? 'Close' : 'Menu'}</span>
          </button>
          <nav id={menuId} className="lp-nav" aria-label="Public" data-open={menuOpen || undefined}>
            <ul>
              {NAV_LINKS.map((l, n) => (
                <li key={l.label} style={{ '--n': n } as CSSProperties}>
                  {l.href.startsWith('#') ? (
                    <a href={l.href} onClick={() => setMenuOpen(false)}>
                      {l.label}
                    </a>
                  ) : (
                    <Link to={l.href} onClick={() => setMenuOpen(false)}>
                      {l.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
            <div className="lp-nav-actions">
              <Link ref={triggerRef} to="/login" className="lp-signin">
                Sign in
              </Link>
              <a href="#contact" className="lp-demo" onClick={goToEnquiry}>
                Request a Demo
              </a>
            </div>
          </nav>
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        {/* A. Hero and B. immersive showcase share one dark canvas */}
        <div className="lp-dark-zone" ref={darkZone}>
          <Hero onDemo={goToEnquiry} />
          <Showcase />
        </div>

        {/* B. Why Anesa */}
        <section className="lp-section" id="why" aria-labelledby="why-title">
          <div className="lp-container">
            <header className="lp-head" data-reveal>
              <p className="lp-eyebrow">Why Anesa</p>
              <h2 id="why-title">Institutions run on connected information.</h2>
              <p className="lp-sub">
                Most campuses juggle spreadsheets, paper and separate tools. Anesa is designed to
                bring the core of that work into one place.
              </p>
            </header>
            <ol className="lp-challenges">
              {CHALLENGES.map((c, i) => (
                <li key={c.problem} data-reveal style={index(i)}>
                  <span className="lp-index" aria-hidden="true">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <h3>{c.problem}</h3>
                    <p>{c.answer}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* D. Features */}
        <section className="lp-section" id="features" aria-labelledby="features-title">
          <div className="lp-container">
            <header className="lp-head" data-reveal>
              <p className="lp-eyebrow">Platform features</p>
              <h2 id="features-title">What exists today, and what does not yet.</h2>
              <p className="lp-sub">
                Anesa is under active development and has not yet been validated with a real
                institution. Each capability is labelled with its honest status.
              </p>
            </header>
            {(['available', 'partial', 'building', 'planned'] as FeatureStatus[]).map((status) => (
              <div className="lp-feature-group" key={status} data-reveal>
                <h3 className="lp-status" data-status={status}>
                  {STATUS_LABEL[status]}
                </h3>
                <ul>
                  {FEATURES.filter((f) => f.status === status).map((f) => (
                    <li key={f.title}>
                      <h4>{f.title}</h4>
                      <p>{f.text}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* F. Solutions */}
        <section className="lp-section lp-tint" id="solutions" aria-labelledby="solutions-title">
          <div className="lp-container">
            <header className="lp-head" data-reveal>
              <p className="lp-eyebrow">Solutions</p>
              <h2 id="solutions-title">One platform, shaped to your kind of institution.</h2>
              <p className="lp-sub">
                The same foundations adapt to how each type of institution works. Specific needs are
                confirmed in a consultation, not assumed.
              </p>
            </header>
            <div className="lp-solutions">
              {SOLUTIONS.map((s, i) => (
                <article
                  key={s.id}
                  className="lp-solution"
                  data-tone={s.id}
                  data-reveal
                  style={index(i)}
                >
                  <h3>{s.name}</h3>
                  <p className="lp-solution-lead">{s.lead}</p>
                  <ul>
                    {s.points.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* G. How it works */}
        <section className="lp-section" id="how" aria-labelledby="how-title">
          <div className="lp-container">
            <header className="lp-head" data-reveal>
              <p className="lp-eyebrow">How Anesa works</p>
              <h2 id="how-title">From first conversation to daily use.</h2>
              <p className="lp-sub">
                This is how an institution would be set up. Steps marked “Proposed process” are
                intended, not yet tested with a real institution.
              </p>
            </header>
            <ol className="lp-steps" data-reveal>
              {STEPS.map((s, i) => (
                <li key={s.title} style={index(i)}>
                  <span className="lp-step-marker" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div>
                    <h3>{s.title}</h3>
                    <p>{s.text}</p>
                    <span className="lp-note">{s.note}</span>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* H. Security */}
        <section className="lp-section lp-dark" id="security" aria-labelledby="security-title">
          <div className="lp-container">
            <header className="lp-head" data-reveal>
              <p className="lp-eyebrow">Security and privacy</p>
              <h2 id="security-title">Built with access and accountability in mind.</h2>
              <p className="lp-sub">
                These describe how the software is built. They are not certifications.
              </p>
            </header>
            <ul className="lp-security">
              {SECURITY_FACTS.map((f, i) => (
                <li key={f.title} data-reveal style={index(i)}>
                  <h3>{f.title}</h3>
                  <p>{f.text}</p>
                </li>
              ))}
            </ul>
            <p className="lp-disclaimer" data-reveal>
              Anesa has no security certification and has not had an independent security audit. It
              is not in production, and no real institutional data has been onboarded.
            </p>
          </div>
        </section>

        {/* I. FAQ */}
        <Faq />

        {/* J. Contact and demo */}
        <section className="lp-section lp-contact" id="contact" aria-labelledby="contact-title">
          <div className="lp-container lp-contact-grid">
            <div data-reveal>
              <p className="lp-eyebrow">Request a demo</p>
              <h2 id="contact-title">Talk to us about your institution.</h2>
              <p className="lp-sub">
                Tell us a little about your institution and what you would like to see. A demo is a
                walkthrough of the current build with sample data.
              </p>
              <ul className="lp-contact-points">
                <li>Used only to contact you about this enquiry.</li>
                <li>No real student data is needed or wanted.</li>
                <li>Pilot terms and hosting are not finalised.</li>
              </ul>
            </div>
            <div className="lp-contact-card" data-reveal>
              <EnquiryForm />
            </div>
          </div>
        </section>
      </main>

      <Footer />

      {children ? (
        children
      ) : signInOpen ? (
        <div
          role="presentation"
          className="modal-backdrop"
          onMouseDown={(e) => e.target === e.currentTarget && close()}
        >
          <div
            ref={dialogRef}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="signin-title"
          >
            <button type="button" className="modal-close" aria-label="Close" onClick={close}>
              ×
            </button>
            <LoginForm from={from} headingId="signin-title" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Accordion FAQ: buttons with aria-expanded; the answer height animates with a grid-row transition. */
function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  const base = useId();
  return (
    <section className="lp-section" id="faq" aria-labelledby="faq-title">
      <div className="lp-container lp-faq-wrap">
        <header className="lp-head" data-reveal>
          <p className="lp-eyebrow">FAQ</p>
          <h2 id="faq-title">Questions we expect.</h2>
        </header>
        <ul className="lp-faq" data-reveal>
          {FAQ.map((item, i) => {
            const isOpen = open === i;
            return (
              <li key={item.q} data-open={isOpen || undefined}>
                <h3>
                  <button
                    type="button"
                    id={`${base}-q${i}`}
                    aria-expanded={isOpen}
                    aria-controls={`${base}-a${i}`}
                    onClick={() => setOpen(isOpen ? null : i)}
                  >
                    <span>{item.q}</span>
                    <span className="lp-faq-icon" aria-hidden="true" />
                  </button>
                </h3>
                <div
                  className="lp-faq-answer"
                  id={`${base}-a${i}`}
                  role="region"
                  aria-labelledby={`${base}-q${i}`}
                >
                  <div>
                    <p>{item.a}</p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
