import type { JSX } from "react";

type BrandLogoProps = {
  compact?: boolean;
  inverse?: boolean;
  className?: string;
};

/** Shared brand identity for desktop wordmark and mobile/sidebar compact usage. */
export function BrandLogo({
  compact = false,
  inverse = false,
  className = "",
}: BrandLogoProps): JSX.Element {
  return (
    <span className={`rf-brand ${className}`.trim()} role="img" aria-label="ReelForge">
      <img
        className="rf-brand__mark"
        src={inverse ? "/brand/reelforge-mark-inverse.svg" : "/brand/reelforge-mark.svg"}
        alt=""
        width={44}
        height={44}
        aria-hidden="true"
      />
      {!compact && (
        <span className="rf-brand__wordmark" aria-hidden="true">
          Reel<span>Forge</span>
        </span>
      )}
    </span>
  );
}
