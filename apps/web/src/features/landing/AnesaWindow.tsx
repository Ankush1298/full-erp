import type { CSSProperties } from 'react';
import { STEPS } from './motion';

/**
 * An illustrative Anesa window drawn from the real layout (purple navigation, white content, status pills) with obviously
 * sample data. It is decorative: no real person or record, and one text description is exposed by its wrapper. The scene
 * (which module is on screen) and the step (how far its sequence has played) come from the caller; the scrubbed progress
 * arrives as the CSS variable --sp on an ancestor, which drives the relationship lines.
 */

export const MENU = [
  'Home',
  'Notifications',
  'Documents',
  'Students',
  'Academics',
  'Organisation',
  'Users',
  'Roles & access',
] as const;
/** Menu row highlighted for each scene: Administration -> Home, Academics -> Academics, Students -> Students. */
export const SCENE_MENU = [0, 4, 3] as const;

const SETUP = [
  'Organisation and campuses',
  'Academic year',
  'Term and cohort periods',
  'Sections and offerings',
  'Teacher assignments',
];
const ROLES: ReadonlyArray<[string, string]> = [
  ['Department admin', 'Sciences'],
  ['Teacher', 'Assigned classes'],
  ['Campus admin', 'Main campus'],
];
const NODES = ['Term', 'Section', 'Offering', 'Teacher'] as const;
const SLOTS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;
const SLOT_LABELS = [
  'Course A',
  'Lab',
  'Course B',
  'Elective',
  'Course A',
  'Course B',
  'Lab',
  'Elective',
];
const STUDENTS: ReadonlyArray<[string, string]> = [
  ['S-0101', 'BSc Sample'],
  ['S-0102', 'BSc Sample'],
  ['S-0103', 'BA Sample'],
  ['S-0104', 'BSc Sample'],
];
const TIMELINE = [
  'Admitted',
  'Programme assigned',
  'Term enrolment',
  'Course registered',
  'Active',
];

const k = (n: number): CSSProperties => ({ '--k': n }) as CSSProperties;
const pos = (scene: number, i: number): 'past' | 'on' | 'next' =>
  i < scene ? 'past' : i === scene ? 'on' : 'next';

export interface AnesaWindowProps {
  scene: number;
  step: number;
  /** Hero mode: the setup ticks play once on entrance by CSS animation, instead of following scroll. */
  intro?: boolean;
  className?: string;
}

export function AnesaWindow({ scene, step, intro = false, className = '' }: AnesaWindowProps) {
  const done = intro ? 3 : step;
  return (
    <div
      className={`aw ${className}`}
      data-intro={intro || undefined}
      style={{ '--nav': SCENE_MENU[scene] ?? 0 } as CSSProperties}
    >
      <div className="aw-chrome">
        <i />
        <i />
        <i />
      </div>
      <div className="aw-body">
        <nav className="aw-nav">
          <b>Anesa</b>
          <span className="aw-nav-slider" />
          {MENU.map((m, i) => (
            <span
              key={m}
              className="aw-nav-item"
              data-on={i === (SCENE_MENU[scene] ?? 0) || undefined}
            >
              {m}
            </span>
          ))}
        </nav>
        <div className="aw-main">
          {/* 0: Administration */}
          <section className="aw-mod" data-pos={pos(scene, 0)}>
            <h4>Academic setup</h4>
            <ul className="aw-check">
              {SETUP.map((label, i) => {
                const state = i < done ? 'done' : i === done ? 'doing' : 'todo';
                return (
                  <li key={label} data-state={state} style={k(i)}>
                    <i />
                    <span>{label}</span>
                    <em>
                      {state === 'done' ? 'Done' : state === 'doing' ? 'In progress' : 'To do'}
                    </em>
                  </li>
                );
              })}
            </ul>
            <div className="aw-roles">
              {ROLES.map(([role, scope], i) => (
                <span key={role} data-on={intro || step >= i + 2 || undefined} style={k(i)}>
                  <b>{role}</b>
                  {scope}
                </span>
              ))}
            </div>
          </section>

          {/* 1: Academics */}
          <section className="aw-mod" data-pos={pos(scene, 1)}>
            <h4>Term and offerings</h4>
            <div className="aw-graph">
              {NODES.map((n, i) => (
                <div className="aw-node-wrap" key={n} style={k(i)}>
                  <span className="aw-node" data-on={step > i || undefined}>
                    {n}
                  </span>
                  {i < NODES.length - 1 ? <span className="aw-link" aria-hidden="true" /> : null}
                </div>
              ))}
            </div>
            <div className="aw-grid">
              {SLOTS.map((d) => (
                <span key={d} className="aw-day">
                  {d}
                </span>
              ))}
              {SLOT_LABELS.map((label, i) => (
                <span
                  key={i}
                  className="aw-slot"
                  data-on={step > i * 0.6 || undefined}
                  style={{ gridColumn: (i % 5) + 1, gridRow: i < 5 ? 2 : 3 }}
                >
                  {label}
                </span>
              ))}
            </div>
            <p className="aw-alert" data-on={step >= 4 || undefined}>
              <b>Clash caught</b> Teacher already placed in another slot on Tue
            </p>
          </section>

          {/* 2: Student management */}
          <section className="aw-mod" data-pos={pos(scene, 2)}>
            <h4>Students</h4>
            <div className="aw-split">
              <table className="aw-table">
                <tbody>
                  {STUDENTS.map(([id, prog], i) => (
                    <tr key={id} data-sel={(i === 1 && step >= 1) || undefined} style={k(i)}>
                      <td>{id}</td>
                      <td>{prog}</td>
                      <td>
                        <span
                          className="aw-pill"
                          data-tone={i === 1 && step < STEPS ? 'info' : 'ok'}
                        >
                          {i === 1 && step < STEPS ? 'Admitted' : 'Active'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <aside className="aw-drawer" data-on={step >= 1 || undefined}>
                <strong>S-0102</strong>
                <small>Timeline</small>
                <ol>
                  {TIMELINE.map((t, i) => (
                    <li key={t} data-on={step >= i + 1 || undefined} style={k(i)}>
                      {t}
                    </li>
                  ))}
                </ol>
              </aside>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
