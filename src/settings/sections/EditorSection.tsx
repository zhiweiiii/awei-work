import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  FORMATTER_LABELS,
  FORMATTERS,
} from "@/modules/editor/lib/externalFormat";
import { EXPOSED_LANGUAGES } from "@/modules/editor/lib/languageDefinitions";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AUTO_SAVE_DELAY_MAX,
  AUTO_SAVE_DELAY_MIN,
  clampAutoSaveDelay,
  EDITOR_FONT_SIZES,
  type EditorFormatter,
  setEditorAutoSave,
  setEditorAutoSaveDelay,
  setEditorCustomFormatCommand,
  setEditorFontSize,
  setEditorFormatOnSave,
  setEditorFormatter,
  setEditorFormatterByLang,
  setEditorWordWrap,
  setVimMode,
} from "@/modules/settings/store";
import { savePreference } from "@/settings/lib/savePreference";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { LspServersGroup } from "../components/LspServersGroup";
import { JavaIndexCaches } from "../components/JavaIndexCaches";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

const AUTO_SAVE_STEP = 100;

export function EditorSection() {
  const editorFontSize = usePreferencesStore((s) => s.editorFontSize);
  const vimMode = usePreferencesStore((s) => s.vimMode);
  const editorWordWrap = usePreferencesStore((s) => s.editorWordWrap);
  const editorAutoSave = usePreferencesStore((s) => s.editorAutoSave);
  const editorAutoSaveDelay = usePreferencesStore((s) => s.editorAutoSaveDelay);
  const editorFormatOnSave = usePreferencesStore((s) => s.editorFormatOnSave);
  const editorFormatter = usePreferencesStore((s) => s.editorFormatter);
  const editorFormatterByLang = usePreferencesStore(
    (s) => s.editorFormatterByLang,
  );
  const usesCustom =
    editorFormatter === "custom" ||
    Object.values(editorFormatterByLang).includes("custom");

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="编辑器"
        description="编辑行为、保存与语言服务器。"
      />

      <div className="flex flex-col gap-2">
        <Label>外观</Label>
        <SettingRow title="字号" description="代码编辑器文字大小。">
          <Select
            value={String(editorFontSize)}
            onValueChange={(v) => savePreference(setEditorFontSize(Number(v)))}
          >
            <SelectTrigger
              aria-label="编辑器字号"
              size="sm"
              className="h-8 w-28 text-[12px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EDITOR_FONT_SIZES.map((size) => (
                <SelectItem
                  key={size}
                  value={String(size)}
                  className="text-[12px]"
                >
                  {size} px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>编辑</Label>
        <SettingRow
          title="Vim 模式"
          description="在代码编辑器中启用 Vim 按键绑定。"
        >
          <Switch
            checked={vimMode}
            aria-label="编辑器 Vim 模式"
            onCheckedChange={(v) => savePreference(setVimMode(v))}
          />
        </SettingRow>
        <SettingRow
          title="自动换行"
          description="长行自动折行显示，而不是横向滚动。"
        >
          <Switch
            checked={editorWordWrap}
            aria-label="编辑器自动换行"
            onCheckedChange={(v) => savePreference(setEditorWordWrap(v))}
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>保存</Label>
        <SettingRow
          title="自动保存"
          description="检测到改动后，延迟一段时间自动保存文件。"
        >
          <Switch
            checked={editorAutoSave}
            aria-label="编辑器自动保存"
            onCheckedChange={(v) => savePreference(setEditorAutoSave(v))}
          />
        </SettingRow>
        {editorAutoSave && (
          <AutoSaveDelayInput
            value={editorAutoSaveDelay}
            onChange={(v) => savePreference(setEditorAutoSaveDelay(v))}
          />
        )}
        <SettingRow
          title="保存时格式化"
          description="手动保存 (Ctrl+S / :w) 时用下方选择的格式化工具格式化文件。"
        >
          <Switch
            checked={editorFormatOnSave}
            aria-label="保存时格式化"
            onCheckedChange={(v) => savePreference(setEditorFormatOnSave(v))}
          />
        </SettingRow>
        {editorFormatOnSave && (
          <>
            <SettingRow
              title="格式化工具"
              description="语言服务器在写入前格式化缓冲区；外部工具则从 PATH 调用，作用于已保存的文件。"
            >
              <FormatterSelect
                value={editorFormatter}
                onChange={(v) => savePreference(setEditorFormatter(v))}
              />
            </SettingRow>
            {usesCustom && <CustomFormatCommandInput />}
            <FormatterOverrides />
          </>
        )}
      </div>

      <LspServersGroup />
      <JavaIndexCaches />
    </div>
  );
}

const FORMATTER_OPTIONS: EditorFormatter[] = [
  "lsp",
  ...(Object.keys(FORMATTERS) as EditorFormatter[]),
  "custom",
];

function FormatterSelect({
  value,
  onChange,
}: {
  value: EditorFormatter;
  onChange: (v: EditorFormatter) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as EditorFormatter)}>
      <SelectTrigger aria-label="格式化工具" className="h-8 w-40 text-[12px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {FORMATTER_OPTIONS.map((id) => (
          <SelectItem key={id} value={id}>
            {FORMATTER_LABELS[id]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CustomFormatCommandInput() {
  const stored = usePreferencesStore((s) => s.editorCustomFormatCommand);
  const [draft, setDraft] = useState(stored);

  useEffect(() => {
    setDraft(stored);
  }, [stored]);

  return (
    <SettingRow
      title="自定义命令"
      description="作用于已保存的文件；{file} 会被替换为带引号的路径 (省略时自动追加到末尾)。"
    >
      <Input
        value={draft}
        aria-label="自定义格式化命令"
        placeholder="mytool --fix {file}"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== stored)
            savePreference(setEditorCustomFormatCommand(draft));
        }}
        onKeyDown={(e) => {
          if (
            !e.nativeEvent.isComposing &&
            e.keyCode !== 229 &&
            e.key === "Enter"
          )
            e.currentTarget.blur();
        }}
        className="h-8 w-64 font-mono text-[12px] md:text-[12px]"
      />
    </SettingRow>
  );
}

function FormatterOverrides() {
  const byLang = usePreferencesStore((s) => s.editorFormatterByLang);
  const entries = Object.entries(byLang);
  const unused = EXPOSED_LANGUAGES.filter((l) => !(l.ext in byLang));

  const update = (
    next: (
      current: Record<string, EditorFormatter>,
    ) => Record<string, EditorFormatter>,
  ) => savePreference(setEditorFormatterByLang(next));

  return (
    <>
      <SettingRow
        title="按语言覆盖"
        description="为特定语言指定不同的格式化工具 (例如 Python 用 Ruff)。"
      >
        <button
          type="button"
          disabled={unused.length === 0}
          className="h-8 rounded-md border border-border px-3 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          onClick={() => {
            const first = unused[0];
            if (first)
              update((current) => ({
                ...current,
                [first.ext]: current[first.ext] ?? "lsp",
              }));
          }}
        >
          添加覆盖规则
        </button>
      </SettingRow>
      {entries.map(([lang, formatter]) => (
        <div
          key={lang}
          className="flex items-center justify-end gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-1.5"
        >
          <Select
            value={lang}
            onValueChange={(nextLang) => {
              if (nextLang === lang) return;
              update((current) => {
                if (!(lang in current) || nextLang in current) return current;
                const next = { ...current };
                delete next[lang];
                next[nextLang] = current[lang];
                return next;
              });
            }}
          >
            <SelectTrigger
              aria-label="格式化规则语言"
              className="h-7 w-44 text-[12px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPOSED_LANGUAGES.filter(
                (l) => l.ext === lang || !(l.ext in byLang),
              ).map((l) => (
                <SelectItem key={l.ext} value={l.ext}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormatterSelect
            value={formatter}
            onChange={(v) =>
              update((current) =>
                lang in current ? { ...current, [lang]: v } : current,
              )
            }
          />
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="移除覆盖规则"
            onClick={() => {
              update((current) => {
                const next = { ...current };
                delete next[lang];
                return next;
              });
            }}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
          </button>
        </div>
      ))}
    </>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}

function AutoSaveDelayInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const clamped = clampAutoSaveDelay(n);
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <SettingRow
      title="自动保存延迟"
      description="未保存的改动在多久之后自动写入磁盘。"
    >
      <div className="flex items-center gap-2">
        <Input
          type="number"
          aria-label="自动保存延迟（毫秒）"
          min={AUTO_SAVE_DELAY_MIN}
          max={AUTO_SAVE_DELAY_MAX}
          step={AUTO_SAVE_STEP}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229 &&
              e.key === "Enter"
            ) {
              e.currentTarget.blur();
            }
          }}
          className="h-8 w-20 rounded-md border border-border bg-background px-2.5 text-right text-[12px] md:text-[12px] tabular-nums outline-none focus:border-foreground/40 focus-visible:ring-0 focus-visible:border-foreground/40 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        <span className="text-[11px] text-muted-foreground">毫秒</span>
      </div>
    </SettingRow>
  );
}
