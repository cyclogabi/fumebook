interface Props {
  className?: string;
}

/**
 * Fumebook logo: a pastel-pink rounded square with a bold white "f", circled by
 * two thin crossing orbital rings (an atom, a fluorine one, obviously).
 * Keep in sync with app/icon.svg.
 */
export default function FumebookLogo({ className = "size-8" }: Props) {
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label="Fumebook logo">
      <rect width="64" height="64" rx="15" fill="#f78fb8" />
      <g fill="none" stroke="#fff" strokeWidth="1.5" strokeOpacity="0.95">
        <ellipse cx="32" cy="32" rx="28" ry="11" transform="rotate(-30 32 32)" />
        <ellipse cx="32" cy="32" rx="28" ry="11" transform="rotate(30 32 32)" />
      </g>
      <g fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round">
        <path d="M38.5 16.5c-5.5-.9-9 1.6-9 7.6V48" strokeWidth="7" />
        <path d="M22 31h17" strokeWidth="6" />
      </g>
    </svg>
  );
}
