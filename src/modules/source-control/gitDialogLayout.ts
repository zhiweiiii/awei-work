export const gitDialogLayout = {
  content:
    "flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] flex-col gap-3 overflow-y-auto p-4 wrap-anywhere sm:p-6",
  body: "min-h-0 min-w-0 overflow-y-auto overscroll-contain",
  footer:
    "min-w-0 shrink-0 sm:flex-wrap [&>button]:h-auto [&>button]:min-h-9 [&>button]:max-w-full [&>button]:whitespace-normal",
} as const;
