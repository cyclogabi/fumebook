interface Props {
  className?: string;
}

/**
 * Fumebook logo rendered from `/logo.png` (the Heisenberg sketch icon).
 */
export default function FumebookLogo({ className = "w-7 h-7" }: Props) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/logo.png"
      alt="Fumebook Logo"
      className={`rounded-md bg-white object-contain ${className}`}
    />
  );
}
