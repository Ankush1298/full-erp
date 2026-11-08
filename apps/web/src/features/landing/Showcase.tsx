import { useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { AnesaWindow } from './AnesaWindow';
import { motionAllowed, STEPS, useScrollScenes } from './motion';

/** The three capabilities the showcase moves through, in order. Copy matches what the current build does. */
export const SCENES = [
  {
    id: 'administration',
    tab: 'Administration',
    eyebrow: '01 · Administration',
    title: 'Set up an institution in the right order.',
    text: 'A guided checklist takes an administrator from campuses and academic years to terms and offerings, while roles decide who may do what.',
    points: [
      'Guided academic setup checklist',
      'Roles scoped to a department, campus or institution',
      'Sensitive changes recorded',
    ],
    alt: 'Illustration of the Anesa administration screen: an academic setup checklist whose items complete one by one, and role assignments with their scope. Sample data.',
  },
  {
    id: 'academics',
    tab: 'Academics',
    eyebrow: '02 · Academics',
    title: 'Connect terms, sections and teachers.',
    text: 'Terms, sections, course offerings, teachers and timetable slots are modelled together, so clashes and capacity limits surface as they are entered.',
    points: [
      'Terms and cohort periods',
      'Offerings with teachers and timetable slots',
      'Electives and registrations',
    ],
    alt: 'Illustration of the Anesa academics screen: a term connected through a section and an offering to a teacher, and timetable slots filling a weekly grid. Sample data.',
  },
  {
    id: 'students',
    tab: 'Student management',
    eyebrow: '03 · Student management',
    title: 'Follow each student across the term.',
    text: 'One record carries programme, enrolment, guardians and documents, with a dated timeline and a status history.',
    points: [
      'Directory search and student profiles',
      'Enrolment, placement and registration',
      'A timeline of what changed and when',
    ],
    alt: 'Illustration of the Anesa student screen: a student list with one student opened to show a timeline from admission to active status. Sample data.',
  },
] as const;

/**
 * Immersive showcase. In motion mode the section is tall and its stage is pinned with `position: sticky`; scrolling plays
 * the scenes (module swaps, the navigation highlight travelling, steps completing, lines drawing). The page keeps scrolling
 * normally. With reduced motion, or without scripting support, it is an ordinary block: the tabs choose the scene and
 * every step is already complete.
 */
export function Showcase() {
  const section = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [motion] = useState(motionAllowed);
  const { state, select } = useScrollScenes(section, stage, SCENES.length, motion);
  const base = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = SCENES[state.scene] ?? SCENES[0];

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, n: number) => {
    const last = SCENES.length - 1;
    const moves: Record<string, number> = {
      ArrowRight: n === last ? 0 : n + 1,
      ArrowLeft: n === 0 ? last : n - 1,
      ArrowDown: n === last ? 0 : n + 1,
      ArrowUp: n === 0 ? last : n - 1,
      Home: 0,
      End: last,
    };
    const next = moves[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(next);
    tabs.current[next]?.focus();
  };

  return (
    <section
      className="lp-show"
      id="platform"
      aria-labelledby="platform-title"
      ref={section}
      data-mode={motion ? 'scroll' : 'static'}
    >
      <div
        className="show-stage"
        ref={stage}
        data-scene={state.scene}
        style={{ '--scenes': SCENES.length } as CSSProperties}
      >
        <div className="show-glow" aria-hidden="true" />
        <div className="lp-container show-grid">
          <div className="show-copy">
            <p className="show-eyebrow">The platform</p>
            <h2 id="platform-title" className="show-heading">
              One system, three ways in.
            </h2>

            <div
              className="show-tabs"
              role="tablist"
              aria-label="Product areas"
              aria-orientation="horizontal"
            >
              {SCENES.map((s, n) => (
                <button
                  key={s.id}
                  ref={(el) => {
                    tabs.current[n] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`${base}-tab-${s.id}`}
                  aria-selected={state.scene === n}
                  aria-controls={`${base}-panel`}
                  tabIndex={state.scene === n ? 0 : -1}
                  onClick={() => select(n)}
                  onKeyDown={(e) => onKey(e, n)}
                >
                  <span className="show-tab-n" aria-hidden="true">
                    {n + 1}
                  </span>
                  {s.tab}
                </button>
              ))}
              <span className="show-rail" aria-hidden="true">
                <i />
              </span>
            </div>

            <div
              className="show-panel"
              role="tabpanel"
              id={`${base}-panel`}
              aria-labelledby={`${base}-tab-${current.id}`}
            >
              {SCENES.map((s, n) => (
                <div
                  key={s.id}
                  className="show-scene"
                  data-on={state.scene === n || undefined}
                  aria-hidden={state.scene === n ? undefined : true}
                >
                  <p className="show-scene-eyebrow">{s.eyebrow}</p>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                  <ul>
                    {s.points.map((p, i) => (
                      <li key={p} data-on={state.step > i * 1.5 || undefined}>
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          <div className="show-visual">
            <div className="show-window" role="img" aria-label={current.alt}>
              <span className="show-layer" data-d="2" aria-hidden="true" />
              <span className="show-layer" data-d="1" aria-hidden="true" />
              <div aria-hidden="true">
                <AnesaWindow scene={state.scene} step={motion ? state.step : STEPS} />
              </div>
            </div>
            <p className="show-caption" aria-hidden="true">
              Illustrative interface with sample data.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
