import { keymap, EditorView } from "@codemirror/view";
import { toast } from "sonner";

export function startingNavigation(name: string) {
  const notify = () => {
    toast.info(`${name} 语言服务正在启动，请稍后重试跳转`, {
      id: "lsp-starting-navigation",
    });
    return true;
  };
  return [
    keymap.of(
      ["F12", "Mod-F12", "Alt-F12", "Shift-F12"].map((key) => ({
        key,
        preventDefault: true,
        run: notify,
      })),
    ),
    EditorView.domEventHandlers({
      mousedown(event) {
        if (event.button !== 0 || !(event.ctrlKey || event.metaKey))
          return false;
        event.preventDefault();
        return notify();
      },
    }),
  ];
}
