import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it } from 'vitest';
import { validateEnquiry, type EnquiryValues } from '../src/features/landing/EnquiryForm';
import { FEATURES, NAV_LINKS } from '../src/features/landing/content';
import { createFakeBackend } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

const anonymous = () => createFakeBackend({ session: false });
const open = () => renderApp(anonymous(), '/');

const valid: EnquiryValues = {
  name: 'Sample Person',
  institution: 'Sample College',
  type: 'College',
  email: 'person@sample.edu',
  phone: '+91 98765 43210',
  region: 'Sample City, Sample State',
  size: '',
  interests: [],
  message: '',
  ack: true,
};

describe('public landing page', () => {
  it('shows the hero, the primary calls to action and every section the navigation points to', async () => {
    open();
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'One connected campus. Endless possibilities.',
      }),
    ).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Public' });
    expect(within(nav).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(within(nav).getByRole('link', { name: 'Request a Demo' })).toHaveAttribute(
      'href',
      '#contact',
    );
    for (const link of NAV_LINKS) {
      const a = within(nav).getByRole('link', { name: link.label });
      expect(a).toHaveAttribute('href', link.href);
      if (link.href.startsWith('#')) {
        expect(document.getElementById(link.href.slice(1)), link.href).not.toBeNull();
      }
    }
    // hero: both calls to action, and the demo ones all lead to the same form
    expect(screen.getByRole('link', { name: 'Explore Platform' })).toHaveAttribute(
      'href',
      '#platform',
    );
    const demoLinks = screen.getAllByRole('link', { name: 'Request a Demo' });
    expect(demoLinks.length).toBeGreaterThanOrEqual(2);
    for (const a of demoLinks) expect(a).toHaveAttribute('href', '#contact');
    expect(document.getElementById('contact')).toContainElement(
      screen.getByRole('button', { name: 'Request a demo' }),
    );
  });

  it('is honest about readiness: no metrics, testimonials or certifications; statuses are labelled', async () => {
    open();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByText('Available in the current build')).toBeInTheDocument();
    expect(screen.getByText('Partly available')).toBeInTheDocument();
    expect(screen.getByText('In development')).toBeInTheDocument();
    expect(screen.getByText('Planned')).toBeInTheDocument();
    // attendance is described as in development, never as available
    expect(FEATURES.find((f) => f.title === 'Attendance')?.status).toBe('building');
    expect(screen.getByText(/no security certification/i)).toBeInTheDocument();
    expect(screen.getByText(/not in production/i)).toBeInTheDocument();
    const page = document.body.textContent ?? '';
    expect(page).not.toMatch(
      /\b(testimonial|trusted by|customers?|ISO ?27001|SOC ?2|GDPR compliant|99\.9)/i,
    );
  });

  it('showcase: three capabilities, the tabs switch scenes, and the copy, window and description follow', async () => {
    const user = userEvent.setup();
    open();
    const tablist = await screen.findByRole('tablist', { name: 'Product areas' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent?.replace(/^\d/, ''))).toEqual([
      'Administration',
      'Academics',
      'Student management',
    ]);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName(/Administration/);
    expect(screen.getByRole('img', { name: /academic setup checklist/i })).toBeInTheDocument();

    await user.click(within(tablist).getByRole('tab', { name: /Academics/ }));
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName(/Academics/);
    expect(
      screen.getByRole('img', { name: /term connected through a section/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: 'Connect terms, sections and teachers.' }),
    ).toBeVisible();

    await user.click(within(tablist).getByRole('tab', { name: /Student management/ }));
    expect(
      screen.getByRole('img', { name: /student list with one student opened/i }),
    ).toBeInTheDocument();
    // static mode (no scroll scrubbing): every step is already complete
    expect(document.querySelectorAll('#platform .aw-drawer li[data-on]')).toHaveLength(5);
  });

  it('showcase tabs support arrow, Home and End keys', async () => {
    const user = userEvent.setup();
    open();
    const tabs = within(await screen.findByRole('tablist', { name: 'Product areas' })).getAllByRole(
      'tab',
    );
    tabs[0]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveFocus();
    await user.keyboard('{End}');
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Home}');
    expect(tabs[0]).toHaveFocus();
  });

  it('hero headline is readable as one sentence, and the mobile menu is a button with aria-controls', async () => {
    open();
    const h1 = await screen.findByRole('heading', { level: 1 });
    expect(h1.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'One connected campus. Endless possibilities.',
    );
    const menu = screen.getByRole('button', { name: 'Menu' });
    expect(document.getElementById(menu.getAttribute('aria-controls') ?? '')).toBe(
      screen.getByRole('navigation', { name: 'Public' }),
    );
  });

  it('FAQ answers open and close with aria-expanded, one at a time', async () => {
    const user = userEvent.setup();
    open();
    const first = await screen.findByRole('button', { name: 'What is Anesa?' });
    const hosting = screen.getByRole('button', { name: 'Where would our data be hosted?' });
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(hosting).toHaveAttribute('aria-expanded', 'false');
    await user.click(hosting);
    expect(hosting).toHaveAttribute('aria-expanded', 'true');
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.getByRole('region', { name: 'Where would our data be hosted?' }),
    ).toHaveTextContent(/not been finalised/i);
    await user.click(hosting);
    expect(hosting).toHaveAttribute('aria-expanded', 'false');
  });

  it('mobile menu toggles with the button and closes with Escape', async () => {
    const user = userEvent.setup();
    open();
    const button = await screen.findByRole('button', { name: 'Menu' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('navigation', { name: 'Public' })).toHaveAttribute('data-open', 'true');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('Sign in still opens the dialog over the page, and Escape returns to the page', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('link', { name: 'Sign in' }));
    expect(await screen.findByRole('dialog', { name: 'Sign in' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'One connected campus. Endless possibilities.',
      }),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('has no detectable accessibility violations (page, and with the sign-in dialog open)', async () => {
    const page = open();
    await screen.findByRole('heading', { level: 1 });
    expect((await axe(page.container)).violations).toEqual([]);
    page.unmount();
    const withDialog = renderApp(anonymous(), '/login');
    await screen.findByRole('dialog', { name: 'Sign in' });
    expect((await axe(withDialog.container)).violations).toEqual([]);
  });
});

describe('demo enquiry form', () => {
  it('validates with friendly messages and focuses the first invalid field; nothing is sent', async () => {
    const user = userEvent.setup();
    const b = anonymous();
    renderApp(b, '/');
    await user.click(await screen.findByRole('button', { name: 'Request a demo' }));
    expect(screen.getByText('Enter your full name.')).toBeInTheDocument();
    expect(screen.getByText('Enter the name of your institution.')).toBeInTheDocument();
    expect(screen.getByText('Choose the type of institution.')).toBeInTheDocument();
    expect(screen.getByText('Enter your work email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter a phone number with the country code.')).toBeInTheDocument();
    expect(screen.getByText('Enter your city and state or region.')).toBeInTheDocument();
    expect(screen.getByText(/confirm that you have read the privacy notice/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Your name')).toHaveFocus();
    expect(screen.getByLabelText('Your name')).toHaveAttribute('aria-invalid', 'true');
    expect(b.callsTo('POST', '/enquiries')).toHaveLength(0);
  });

  it('a complete, valid form says plainly that nothing was sent and never claims success', async () => {
    const user = userEvent.setup();
    const b = anonymous();
    renderApp(b, '/');
    await user.type(await screen.findByLabelText('Your name'), valid.name);
    await user.type(screen.getByLabelText('Institution name'), valid.institution);
    await user.selectOptions(screen.getByLabelText('Institution type'), 'College');
    await user.type(screen.getByLabelText('Work email'), valid.email);
    await user.type(screen.getByLabelText('Phone, with country code'), valid.phone);
    await user.type(screen.getByLabelText('City and state or region'), valid.region);
    await user.click(screen.getByLabelText(/I have read the/));
    await user.click(screen.getByRole('button', { name: 'Request a demo' }));
    expect(screen.getByRole('status')).toHaveTextContent('Nothing was sent.');
    expect(document.body.textContent).not.toMatch(
      /thank you|we.ll be in touch|request received|submitted successfully/i,
    );
    // no network request of any kind was made for the enquiry
    expect(b.callsTo('POST', '/enquiries')).toHaveLength(0);
    expect(screen.queryByText('Enter your full name.')).not.toBeInTheDocument();
  });

  it('the validator accepts a complete enquiry and rejects specific problems', () => {
    expect(validateEnquiry(valid)).toEqual({});
    expect(validateEnquiry({ ...valid, email: 'not-an-email' }).email).toMatch(/valid email/);
    expect(validateEnquiry({ ...valid, phone: '98765 43210' }).phone).toMatch(/country code/);
    expect(validateEnquiry({ ...valid, phone: '+91 1' }).phone).toMatch(/country code/);
    expect(validateEnquiry({ ...valid, message: 'x'.repeat(1001) }).message).toMatch(/1,000/);
    expect(validateEnquiry({ ...valid, ack: false }).ack).toBeDefined();
    expect(validateEnquiry({ ...valid, size: '', interests: [], message: '' })).toEqual({}); // optional fields
  });
});

describe('motion preferences', () => {
  it('with reduced motion (and without IntersectionObserver) every section is visible immediately', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    const reduced = (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
      onchange: null,
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: reduced,
    });
    try {
      const view = open();
      await screen.findByRole('heading', { level: 1 });
      const hidden = view.container.querySelectorAll('[data-reveal]:not(.is-visible)');
      expect(hidden).toHaveLength(0);
      expect(view.container.querySelector('.js-reveal')).toBeNull();
    } finally {
      if (original) Object.defineProperty(window, 'matchMedia', original);
      else Reflect.deleteProperty(window, 'matchMedia');
    }
  });
});
