/**
 * The felt. One definition, mounted once, by the shell.
 *
 * There were five of these. Two differed only in texture opacity (.04 vs .05),
 * two more in whether they were `absolute` or `fixed` — which is why overscroll
 * on some routes revealed the page behind and on others did not. This one is
 * `fixed`, so the felt is the floor of the application rather than the
 * background of whichever page happens to be mounted.
 *
 * `flourish` adds what the landing page had that the product surfaces did not:
 * a brighter centre, an edge vignette, and the four suit watermarks. It is a
 * variant of the felt rather than a second felt, so the two cannot drift.
 */

export function FeltBackground({ flourish = false }: { flourish?: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          background: flourish
            ? "radial-gradient(130% 95% at 50% 30%, #1a4a32 0%, #123524 42%, #0b2218 80%, #050d09 100%)"
            : "radial-gradient(1100px 700px at 50% -10%, #0f3324 0%, transparent 60%), linear-gradient(180deg, #0a1c14 0%, #060f0a 100%)",
        }}
      />

      {/* Felt weave. Fine enough to be felt rather than seen. */}
      <div
        className="absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 25% 30%, #f4ede4 0.5px, transparent 0.6px), radial-gradient(circle at 75% 70%, #f4ede4 0.5px, transparent 0.6px)",
          backgroundSize: "26px 26px",
        }}
      />

      {flourish && (
        <>
          <div
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(120% 100% at 50% 45%, transparent 55%, rgba(0,0,0,0.55) 100%)",
            }}
          />
          <Suit className="left-4 top-2" glyph={"♠"} ink="rgba(244,237,228,0.14)" />
          <Suit className="right-5 top-2" glyph={"♥"} ink="rgba(122,0,25,0.30)" />
          <Suit className="bottom-2 left-5" glyph={"♦"} ink="rgba(122,0,25,0.30)" />
          <Suit className="bottom-2 right-4" glyph={"♣"} ink="rgba(244,237,228,0.14)" />
        </>
      )}
    </div>
  );
}

function Suit({
  className,
  glyph,
  ink,
}: {
  className: string;
  glyph: string;
  ink: string;
}) {
  return (
    <span
      className={`absolute select-none text-[clamp(4.5rem,9vw,8rem)] leading-none ${className}`}
      style={{ color: ink }}
    >
      {glyph}
    </span>
  );
}
