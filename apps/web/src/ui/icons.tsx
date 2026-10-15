// Tiny stroke icon set (inline SVG, currentColor). Add one by name; keep 24×24, 1.8 stroke.
import type { SVGProps } from "react";

const paths = {
  play: <path d="M7 5v14l12-7z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  chart: <path d="M4 19h16M6 15l4-4 3 3 5-6" />,
  split: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M12 5v14" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  link: <path d="M10 14l4-4M8.5 15.5l-1 1a3 3 0 01-4.2-4.2l3-3a3 3 0 014.2 0M15.5 8.5l1-1a3 3 0 014.2 4.2l-3 3a3 3 0 01-4.2 0" />,
  download: <path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  reject: <path d="M7 7l10 10M17 7L7 17" />,
  report: <path d="M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5" />,
  bolt: <path d="M13 3L5 14h6l-1 7 8-11h-6z" />,
  people: <path d="M9 11a3 3 0 100-6 3 3 0 000 6zM3 20a6 6 0 0112 0M17 11a2.5 2.5 0 100-5M21 20a5 5 0 00-4-4.9" />,
  replay: <path d="M4 12a8 8 0 108-8H8M8 1L5 4l3 3" />,
  info: <path d="M12 8h.01M11 12h1v5h1M12 21a9 9 0 100-18 9 9 0 000 18z" />,
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      {paths[name]}
    </svg>
  );
}
