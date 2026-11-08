export function Logo({ variant = 'default' }: { variant?: 'default' | 'light' }) {
  return (
    <span className={`logo logo--${variant}`}>
      <svg className="logo-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
        <circle cx="24" cy="13" r="6" fill="currentColor" />
        <path
          d="M24 22c-5.2 0-12 3.2-16 6.8v10.4c4-3.2 10.4-5.2 16-5.2s12 2 16 5.2V28.8c-4-3.6-10.8-6.8-16-6.8z"
          fill="currentColor"
        />
        <path
          d="M24 23.5v10.5"
          stroke="#ffffff"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      <span className="logo-text">Anesa</span>
    </span>
  );
}
