import { useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/TextField';
import { ENQUIRY_LIVE, INSTITUTION_TYPES, INTERESTS, SIZE_BANDS } from './content';

export interface EnquiryValues {
  name: string;
  institution: string;
  type: string;
  email: string;
  phone: string;
  region: string;
  size: string;
  interests: string[];
  message: string;
  ack: boolean;
}

type Errors = Partial<Record<keyof EnquiryValues, string>>;

const EMPTY: EnquiryValues = {
  name: '',
  institution: '',
  type: '',
  email: '',
  phone: '',
  region: '',
  size: '',
  interests: [],
  message: '',
  ack: false,
};

// International format with the country code, for example +91 98765 43210.
const PHONE = /^\+[1-9]\d{0,2}[\s-]?\d[\d\s-]{5,13}\d$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Friendly, specific messages; the order is the order of the fields on screen. */
export function validateEnquiry(v: EnquiryValues): Errors {
  const e: Errors = {};
  const name = v.name.trim();
  if (name.length < 2) e.name = 'Enter your full name.';
  else if (name.length > 100) e.name = 'Keep your name under 100 characters.';
  const inst = v.institution.trim();
  if (inst.length < 2) e.institution = 'Enter the name of your institution.';
  else if (inst.length > 150) e.institution = 'Keep the institution name under 150 characters.';
  if (!v.type) e.type = 'Choose the type of institution.';
  if (!v.email.trim()) e.email = 'Enter your work email address.';
  else if (!EMAIL.test(v.email.trim()))
    e.email = 'Enter a valid email address, such as name@school.edu.';
  if (!v.phone.trim()) e.phone = 'Enter a phone number with the country code.';
  else if (!PHONE.test(v.phone.trim()))
    e.phone = 'Start with the country code, for example +91 98765 43210.';
  const region = v.region.trim();
  if (region.length < 2) e.region = 'Enter your city and state or region.';
  else if (region.length > 100) e.region = 'Keep this under 100 characters.';
  if (v.message.length > 1000) e.message = 'Keep your message under 1,000 characters.';
  if (!v.ack)
    e.ack = 'Please confirm that you have read the privacy notice and agree to be contacted.';
  return e;
}

/**
 * Demo / consultation enquiry. The backend that would receive it does not exist yet (no endpoint, storage, retention
 * policy or notification route is authorised), so this form validates fully and then says plainly that nothing was
 * sent. It never claims success. `ENQUIRY_LIVE` in content.ts is the single switch for when that changes.
 */
export function EnquiryForm() {
  const [values, setValues] = useState<EnquiryValues>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [blocked, setBlocked] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const institutionRef = useRef<HTMLInputElement>(null);
  const typeRef = useRef<HTMLSelectElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const regionRef = useRef<HTMLInputElement>(null);
  const id = useId();

  const set = <K extends keyof EnquiryValues>(key: K, value: EnquiryValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = validateEnquiry(values);
    setErrors(next);
    setBlocked(false);
    const order = [
      ['name', nameRef],
      ['institution', institutionRef],
      ['type', typeRef],
      ['email', emailRef],
      ['phone', phoneRef],
      ['region', regionRef],
    ] as const;
    const firstInvalid = order.find(([key]) => next[key]);
    if (firstInvalid) return firstInvalid[1].current?.focus();
    if (Object.keys(next).length > 0) return;
    if (!ENQUIRY_LIVE) setBlocked(true);
  }

  const toggleInterest = (item: string) =>
    set(
      'interests',
      values.interests.includes(item)
        ? values.interests.filter((i) => i !== item)
        : [...values.interests, item],
    );

  const typeErrorId = `${id}-type-error`;
  const ackErrorId = `${id}-ack-error`;

  return (
    <form className="enquiry" onSubmit={onSubmit} noValidate aria-describedby={`${id}-status`}>
      <div className="enquiry-notice" id={`${id}-status`} role={blocked ? 'status' : undefined}>
        {blocked ? (
          <>
            <strong>Nothing was sent.</strong> Demo requests are not open yet, because this form is
            not connected to a system that can receive and store it. Your details are still on this
            page only and will be lost when you leave it.
          </>
        ) : (
          <>
            <strong>Demo requests are not open yet.</strong> You can see how the form works, but
            submitting it will not send or store anything.
          </>
        )}
      </div>

      <div className="enquiry-grid">
        <TextField
          label="Your name"
          name="name"
          autoComplete="name"
          required
          value={values.name}
          onChange={(e) => set('name', e.target.value)}
          error={errors.name}
          inputRef={nameRef}
        />
        <TextField
          label="Institution name"
          name="institution"
          autoComplete="organization"
          required
          value={values.institution}
          onChange={(e) => set('institution', e.target.value)}
          error={errors.institution}
          inputRef={institutionRef}
        />
        <div className="field">
          <label htmlFor={`${id}-type`}>Institution type</label>
          <select
            id={`${id}-type`}
            ref={typeRef}
            required
            value={values.type}
            onChange={(e) => set('type', e.target.value)}
            aria-invalid={errors.type ? true : undefined}
            aria-describedby={errors.type ? typeErrorId : undefined}
          >
            <option value="">Choose one</option>
            {INSTITUTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {errors.type ? (
            <p id={typeErrorId} className="field-error">
              {errors.type}
            </p>
          ) : null}
        </div>
        <TextField
          label="Work email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={values.email}
          onChange={(e) => set('email', e.target.value)}
          error={errors.email}
          inputRef={emailRef}
        />
        <TextField
          label="Phone, with country code"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+91 98765 43210"
          required
          value={values.phone}
          onChange={(e) => set('phone', e.target.value)}
          error={errors.phone}
          inputRef={phoneRef}
        />
        <TextField
          label="City and state or region"
          name="region"
          autoComplete="address-level2"
          required
          value={values.region}
          onChange={(e) => set('region', e.target.value)}
          error={errors.region}
          inputRef={regionRef}
        />
        <div className="field">
          <label htmlFor={`${id}-size`}>Approximate size (optional)</label>
          <select
            id={`${id}-size`}
            value={values.size}
            onChange={(e) => set('size', e.target.value)}
          >
            <option value="">Prefer not to say</option>
            {SIZE_BANDS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="enquiry-interests">
        <legend>Areas of interest (optional)</legend>
        <div className="enquiry-chips">
          {INTERESTS.map((item) => (
            <label key={item} className="chip">
              <input
                type="checkbox"
                checked={values.interests.includes(item)}
                onChange={() => toggleInterest(item)}
              />
              <span>{item}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="field">
        <label htmlFor={`${id}-message`}>Message (optional)</label>
        <textarea
          id={`${id}-message`}
          rows={4}
          value={values.message}
          onChange={(e) => set('message', e.target.value)}
          aria-invalid={errors.message ? true : undefined}
          aria-describedby={errors.message ? `${id}-message-error` : undefined}
        />
        {errors.message ? (
          <p id={`${id}-message-error`} className="field-error">
            {errors.message}
          </p>
        ) : null}
      </div>

      <div className="field enquiry-ack">
        <label className="enquiry-ack-label">
          <input
            type="checkbox"
            checked={values.ack}
            onChange={(e) => set('ack', e.target.checked)}
            aria-invalid={errors.ack ? true : undefined}
            aria-describedby={errors.ack ? ackErrorId : undefined}
          />
          <span>
            I have read the <Link to="/privacy">privacy notice</Link> and agree that Anesa may use
            these details only to contact me about this enquiry.
          </span>
        </label>
        {errors.ack ? (
          <p id={ackErrorId} className="field-error">
            {errors.ack}
          </p>
        ) : null}
      </div>

      <Button type="submit" className="enquiry-submit">
        Request a demo
      </Button>
    </form>
  );
}
