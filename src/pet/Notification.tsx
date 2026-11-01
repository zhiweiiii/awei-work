import { type CSSProperties, useEffect, useState } from "react";

export function Notification({
  style,
  reminder = false,
  sentence,
  pending,
  onOpen,
  onDismiss,
  onPause,
}: {
  style?: CSSProperties;
  reminder?: boolean;
  sentence: string;
  pending: boolean;
  onOpen: () => void;
  onDismiss: () => void;
  onPause: (paused: boolean) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => onPause(hovered || focused), [hovered, focused, onPause]);
  useEffect(() => () => onPause(false), [onPause]);
  return (
    <div
      className="pet-notification"
      style={style}
      data-reminder={reminder}
      role="status"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
    >
      <button
        type="button"
        className="pet-notification-body"
        disabled={pending}
        onClick={onOpen}
      >
        <span className="pet-notification-sentence">{sentence}</span>
      </button>
      <button
        type="button"
        className="pet-icon-button"
        aria-label="关闭提醒"
        onClick={onDismiss}
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden
        >
          <title>关闭提醒</title>
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}
