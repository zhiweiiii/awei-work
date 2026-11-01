import { memo } from "react";

export const PetSprite = memo(function PetSprite({
  phase,
}: {
  phase: "working" | "attention" | "idle";
}) {
  return (
    <div className={`pet-sprite pet-sprite-${phase}`} aria-hidden>
      <svg
        viewBox="94 40 324 426"
        className="pet-artwork"
        focusable="false"
        role="img"
        aria-label="Companion"
        aria-hidden
      >
        <path
          fill="#fff"
          stroke="#fff"
          strokeWidth="27"
          strokeLinejoin="round"
          d="M256 77C343 78 391 82 397 99L401 130Q403 147 377 153L361 413Q359 449 256 449Q153 449 151 413L135 153Q109 147 111 130L115 99C121 82 169 78 256 77Z"
        />
        <g
          stroke="#111718"
          strokeWidth="9"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path
            fill="#08B9EB"
            d="M135 150H377L361 413Q359 449 256 449Q153 449 151 413Z"
          />
          <path
            fill="#fff"
            d="M149.4 387C158 376 172 377 180 394S203 408 216 394S242 377 251 394S274 409 288 394S314 377 325 391S348 407 362.6 387L361 413Q359 449 256 449Q153 449 151 413Z"
          />
          <path
            fill="#F9D512"
            d="M115 99L111 130C109 148 174 158 256 158S403 148 401 130L397 99Z"
          />
          <ellipse cx="256" cy="99" rx="141" ry="22" fill="#F9D512" />
          <path
            fill="none"
            d={
              phase === "idle"
                ? "M185 278C194 316 220 333 256 333S318 316 327 278"
                : "M204 321Q256 268 308 321"
            }
          />
          {phase === "attention" ? (
            <path fill="none" d="M200 218L235 204M277 204L312 218" />
          ) : null}
          {phase === "idle" ? (
            <path
              fill="none"
              d="M175 281Q186 282 195 273M317 273Q326 282 337 281"
            />
          ) : null}
        </g>
        <g fill="#111718">
          <ellipse
            cx="219"
            cy="238"
            rx="13"
            ry={phase === "working" ? "14" : "19"}
          />
          <ellipse
            cx="293"
            cy="238"
            rx="13"
            ry={phase === "working" ? "14" : "19"}
          />
        </g>
      </svg>
    </div>
  );
});
