export function copyButton(readText: () => string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-btn";
  button.textContent = "复制";
  button.setAttribute("aria-label", "复制内容");
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await copyText(readText());
      button.textContent = "已复制";
    } catch {
      button.textContent = "复制失败";
    }
    window.setTimeout(() => {
      button.textContent = "复制";
    }, 2000);
  });
  return button;
}

export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // LAN HTTP pages need the legacy clipboard path.
  }
  const active = document.activeElement;
  const selection =
    active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
      ? ([
          active.selectionStart,
          active.selectionEnd,
          active.selectionDirection,
        ] as const)
      : null;
  const field = document.createElement("textarea");
  field.value = text;
  field.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
  document.body.appendChild(field);
  let copied = false;
  try {
    field.select();
    copied = document.execCommand("copy");
  } finally {
    field.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
    if (
      (active instanceof HTMLTextAreaElement ||
        active instanceof HTMLInputElement) &&
      selection &&
      selection[0] !== null &&
      selection[1] !== null
    )
      active.setSelectionRange(
        selection[0],
        selection[1],
        selection[2] ?? undefined,
      );
  }
  if (!copied) throw new Error("Clipboard unavailable");
}
