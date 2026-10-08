"use client";

import { NMRium } from "nmrium";
import "./nmr-room.css";

/**
 * Lives in its own module so that NMRium *and* its stylesheets (Blueprint +
 * preflight isolation, see nmr-room.css) are one lazily loaded chunk, only
 * fetched when the NMR room is opened. Import it via `next/dynamic` only.
 */
export default function NmrWorkspace() {
  // "default" = the full professional workspace (peak picking, integration, 2D, …).
  return <NMRium workspace="default" />;
}
