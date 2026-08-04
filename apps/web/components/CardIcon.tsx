/**
 * One line glyph per business, hand-drawn — recognition aids, not decoration.
 *
 * Inline SVG rather than an icon library: twelve small paths do not justify a
 * dependency, and a single stroke style (1.6px, currentColor, round caps) is
 * what keeps them reading as one system. They inherit the muted ink so they
 * anchor the eye without competing with the title.
 */

import type { ReactElement } from 'react';

const PATHS: Record<string, ReactElement> = {
  restaurant: (
    // Fork and knife.
    <>
      <path d="M7 3v5a2.5 2.5 0 0 0 5 0V3" />
      <path d="M9.5 3v18" />
      <path d="M17 3c-1.5 2.5-1.5 6.5 0 9v9" />
    </>
  ),
  qsr: (
    // Burger.
    <>
      <path d="M4 10a8 5 0 0 1 16 0" />
      <path d="M3.5 13.5h17" />
      <path d="M4 17h16a0 2 0 0 1-2 3H6a0 2 0 0 1-2-3z" />
    </>
  ),
  coffee: (
    // Cup with handle.
    <>
      <path d="M4 8h13v7a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8z" />
      <path d="M17 9h1.5a3 3 0 0 1 0 6H17" />
      <path d="M8 4.5v1.5M12 4.5v1.5" />
    </>
  ),
  retail: (
    // Shopping bag.
    <>
      <path d="M6.5 7.5 8 4h8l1.5 3.5" />
      <path d="M5 7.5h14l-1 12a1.8 1.8 0 0 1-1.8 1.5H7.8A1.8 1.8 0 0 1 6 19.5l-1-12z" />
      <path d="M9.5 10.5a2.5 2.5 0 0 0 5 0" />
    </>
  ),
  services: (
    // Briefcase.
    <>
      <rect x="3" y="8" width="18" height="12" rx="2" />
      <path d="M9 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      <path d="M3 13h18" />
    </>
  ),
  agency: (
    // Megaphone.
    <>
      <path d="M4 10v4l14 6V4L4 10z" />
      <path d="M4 14v3a2 2 0 0 0 2 2h2" />
      <path d="M21 10v4" />
    </>
  ),
  ecommerce: (
    // Parcel.
    <>
      <path d="M12 3 4 7v10l8 4 8-4V7l-8-4z" />
      <path d="M4 7l8 4 8-4" />
      <path d="M12 11v9" />
    </>
  ),
  saas: (
    // Cloud.
    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
  ),
  gym: (
    // Dumbbell.
    <>
      <path d="M6.5 6.5v11M17.5 6.5v11" />
      <path d="M3 9.5v5M21 9.5v5" />
      <path d="M6.5 12h11" />
    </>
  ),
  storage: (
    // Roll-up unit door.
    <>
      <path d="M3 21V8l9-5 9 5v13" />
      <path d="M7 21v-9h10v9" />
      <path d="M7 15h10M7 18h10" />
    </>
  ),
  contractor: (
    // Framed building.
    <>
      <path d="M4 21V5l8-3 8 3v16" />
      <path d="M2 21h20" />
      <path d="M9 9h2M13 9h2M9 13h2M13 13h2M9 17h2M13 17h2" />
    </>
  ),
  trades: (
    // Wrench.
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  ),
  describe: (
    // Speech bubble.
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10z" />
  ),
};

export function CardIcon({ kind }: { kind: string }) {
  const glyph = PATHS[kind];
  if (!glyph) return null;
  return (
    <svg
      className="card-icon"
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}
