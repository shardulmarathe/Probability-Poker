/**
 * A heading for a page that cannot be given one.
 *
 * `/game` — the original heads-up match — renders no `<h1>`, so the document
 * outline for a whole route began at "Hand #1". The page itself is being
 * retired separately and is not this module's to edit, so the heading is
 * supplied by the route instead. It is one line, above the page's own `<main>`,
 * and it disappears with the page.
 */

import type { ReactNode } from "react";
import { PageHeader } from "./PageHeader";

export function LegacyRoute({
  title,
  lede,
  children,
}: {
  title: string;
  lede?: string;
  children: ReactNode;
}) {
  return (
    <>
      <div className="relative z-10 mx-auto max-w-5xl px-3 pt-4 sm:px-4">
        <PageHeader compact title={title} lede={lede} />
      </div>
      {children}
    </>
  );
}
