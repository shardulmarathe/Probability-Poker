/**
 * A real 404.
 *
 * `App.tsx` used to map `*` to `<Home />`, so a mistyped URL rendered the
 * landing page at an address that was not the landing page: the browser kept
 * the wrong URL, "Take a seat" appeared to work, and sharing the link sent
 * someone else to the same nowhere. A missing page should say so and then be
 * useful about it.
 */

import { Link, useLocation } from "react-router-dom";
import { ButtonLink } from "../ui";
import { PageBody, PageHeader } from "./PageHeader";

export default function NotFound() {
  const { pathname } = useLocation();
  return (
    <main
      className="relative min-h-[100svh] overflow-x-hidden text-ivory"
      data-testid="not-found"
    >
      <PageBody width="narrow">
        <PageHeader
          title="No table at this address"
          lede={
            <>
              Nothing is served at <code className="font-mono text-gold-soft/80">{pathname}</code>.
              It may have been a typo, or a link from a version of the site that
              laid its pages out differently.
            </>
          }
        />

        {/*
         * One button. Three of equal weight is the catalog's CTA duplication —
         * they all looked like the thing to do, so none of them did.
         */}
        <div className="mt-8">
          <ButtonLink to="/table" variant="primary" size="lg">
            Go to the table
            <span aria-hidden className="text-gold">
              →
            </span>
          </ButtonLink>
        </div>

        <p className="mt-6 text-sm text-ivory/50">
          Or{" "}
          <Link to="/" className="text-gold-soft underline-offset-4 hover:underline">
            choose a different table
          </Link>{" "}
          and{" "}
          <Link
            to="/profile"
            className="text-gold-soft underline-offset-4 hover:underline"
          >
            read your profile
          </Link>
          .
        </p>
      </PageBody>
    </main>
  );
}
