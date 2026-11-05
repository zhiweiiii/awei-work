import type { LspCustomServer } from "@/modules/settings/store";

export type LspPreset = {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** languageResolver id -> LSP languageId */
  languages: Record<string, string>;
  rootMarkers: string[];
  initializationOptions?: unknown;
  env?: Record<string, string>;
  maxMemoryMb?: number;
  /** Absent for user-defined servers. */
  install?: { command?: string; docsUrl: string };
};

export const LSP_PRESETS: LspPreset[] = [
  {
    id: "typescript",
    name: "TypeScript",
    command: "typescript-language-server",
    args: ["--stdio"],
    languages: {
      ts: "typescript",
      tsx: "typescriptreact",
      js: "javascript",
      jsx: "javascriptreact",
    },
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
    initializationOptions: { maxTsServerMemory: 3072 },
    install: {
      command: "npm install -g typescript-language-server typescript",
      docsUrl:
        "https://github.com/typescript-language-server/typescript-language-server",
    },
  },
  {
    id: "rust-analyzer",
    name: "Rust",
    command: "rust-analyzer",
    args: [],
    languages: { rs: "rust" },
    rootMarkers: ["Cargo.toml"],
    // Measured: default profile settles at ~3 GB resident, this one at ~1 GB,
    // trading analysis inside proc macros and cargo-check diagnostics.
    initializationOptions: {
      cachePriming: { enable: false },
      lru: { capacity: 32 },
      checkOnSave: false,
      procMacro: { enable: false },
      cargo: { buildScripts: { enable: false } },
      diagnostics: {
        disabled: ["unresolved-proc-macro", "unresolved-macro-call"],
      },
    },
    env: { CARGO_BUILD_JOBS: "2" },
    maxMemoryMb: 3072,
    install: {
      command: "rustup component add rust-analyzer",
      docsUrl: "https://rust-analyzer.github.io/book/installation.html",
    },
  },
  {
    id: "pyright",
    name: "Python",
    command: "pyright-langserver",
    args: ["--stdio"],
    languages: { py: "python" },
    rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"],
    install: {
      command: "npm install -g pyright",
      docsUrl: "https://microsoft.github.io/pyright/#/installation",
    },
  },
  {
    id: "ruff",
    name: "Ruff",
    command: "ruff",
    args: ["server"],
    languages: { py: "python" },
    rootMarkers: [
      "pyproject.toml",
      "ruff.toml",
      ".ruff.toml",
      "setup.py",
      "requirements.txt",
    ],
    install: {
      command: "pip install ruff",
      docsUrl: "https://docs.astral.sh/ruff/editors/",
    },
  },
  {
    id: "gopls",
    name: "Go",
    command: "gopls",
    args: [],
    languages: { go: "go" },
    rootMarkers: ["go.mod", "go.work"],
    install: {
      command: "go install golang.org/x/tools/gopls@latest",
      docsUrl: "https://pkg.go.dev/golang.org/x/tools/gopls#section-readme",
    },
  },
  {
    id: "clangd",
    name: "C/C++",
    command: "clangd",
    args: [],
    languages: { c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp" },
    rootMarkers: [
      "compile_commands.json",
      "CMakeLists.txt",
      "Makefile",
      ".clangd",
    ],
    install: {
      docsUrl: "https://clangd.llvm.org/installation",
    },
  },
  {
    id: "jdtls",
    name: "Java",
    command: "jdtls",
    // The launcher is a thin Python script that execs the JVM, so the memwatch
    // in session.rs would only ever see the wrapper's RSS — no maxMemoryMb here,
    // -Xmx is the only cap that reaches the process actually holding the heap.
    args: ["--jvm-arg=-Xmx2G"],
    languages: { java: "java" },
    // The native launcher supplies a cache keyed by the full project path.
    rootMarkers: [
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts",
      ".project",
      "mvnw",
      "gradlew",
    ],
    // Default is "interactive", which parks the classpath behind a client prompt
    // we never show — the build file would silently stop matching the index.
    initializationOptions: {
      settings: {
        java: {
          configuration: { updateBuildConfiguration: "automatic" },
          import: {
            exclusions: [
              "**/node_modules/**",
              "**/.metadata/**",
              "**/archetype-resources/**",
              "**/META-INF/maven/**",
              "**/.git/**",
              "**/.idea/**",
              "**/target/**",
              "**/build/**",
              "**/dist/**",
              "**/out/**",
            ],
          },
          project: {
            resourceFilters: [
              "node_modules",
              "\\.git",
              "\\.idea",
              "\\.metadata",
            ],
          },
          references: { includeDecompiledSources: false },
        },
      },
    },
    install: {
      docsUrl: "https://github.com/eclipse-jdtls/eclipse.jdt.ls#installation",
    },
  },
  {
    id: "zls",
    name: "Zig",
    command: "zls",
    args: [],
    languages: { zig: "zig" },
    rootMarkers: ["build.zig"],
    install: {
      docsUrl: "https://zigtools.org/zls/install/",
    },
  },
  {
    id: "lua-ls",
    name: "Lua",
    command: "lua-language-server",
    args: [],
    languages: { lua: "lua" },
    rootMarkers: [".luarc.json", ".luarc.jsonc"],
    install: {
      docsUrl: "https://luals.github.io/#install",
    },
  },
  {
    id: "ruby-lsp",
    name: "Ruby",
    command: "ruby-lsp",
    args: [],
    languages: { rb: "ruby" },
    rootMarkers: ["Gemfile"],
    install: {
      command: "gem install ruby-lsp",
      docsUrl: "https://shopify.github.io/ruby-lsp/",
    },
  },
  {
    id: "intelephense",
    name: "PHP",
    command: "intelephense",
    args: ["--stdio"],
    languages: { php: "php" },
    rootMarkers: ["composer.json"],
    install: {
      command: "npm install -g intelephense",
      docsUrl: "https://intelephense.com",
    },
  },
  {
    id: "yaml-ls",
    name: "YAML",
    command: "yaml-language-server",
    args: ["--stdio"],
    languages: { yaml: "yaml", yml: "yaml" },
    rootMarkers: [".git"],
    install: {
      command: "npm install -g yaml-language-server",
      docsUrl: "https://github.com/redhat-developer/yaml-language-server",
    },
  },
  {
    id: "bash-ls",
    name: "Shell",
    command: "bash-language-server",
    args: ["start"],
    languages: { sh: "shellscript", bash: "shellscript", zsh: "shellscript" },
    rootMarkers: [".git"],
    install: {
      command: "npm install -g bash-language-server",
      docsUrl: "https://github.com/bash-lsp/bash-language-server",
    },
  },
  {
    id: "json-ls",
    name: "JSON",
    command: "vscode-json-language-server",
    args: ["--stdio"],
    languages: { json: "json" },
    rootMarkers: [".git"],
    install: {
      command: "npm install -g vscode-langservers-extracted",
      docsUrl: "https://github.com/hrsh7th/vscode-langservers-extracted",
    },
  },
  {
    id: "css-ls",
    name: "CSS",
    command: "vscode-css-language-server",
    args: ["--stdio"],
    languages: { css: "css", scss: "scss", less: "less" },
    rootMarkers: ["package.json", ".git"],
    install: {
      command: "npm install -g vscode-langservers-extracted",
      docsUrl: "https://github.com/hrsh7th/vscode-langservers-extracted",
    },
  },
  {
    id: "html-ls",
    name: "HTML",
    command: "vscode-html-language-server",
    args: ["--stdio"],
    languages: { html: "html" },
    rootMarkers: ["package.json", ".git"],
    install: {
      command: "npm install -g vscode-langservers-extracted",
      docsUrl: "https://github.com/hrsh7th/vscode-langservers-extracted",
    },
  },
  {
    id: "svelte-ls",
    name: "Svelte",
    command: "svelteserver",
    args: ["--stdio"],
    languages: { svelte: "svelte" },
    rootMarkers: ["svelte.config.js", "package.json"],
    install: {
      command: "npm install -g svelte-language-server",
      docsUrl: "https://github.com/sveltejs/language-tools",
    },
  },
  {
    id: "vue-ls",
    name: "Vue",
    command: "vue-language-server",
    args: ["--stdio"],
    languages: { vue: "vue" },
    rootMarkers: ["vite.config.ts", "vite.config.js", "package.json"],
    install: {
      command: "npm install -g @vue/language-server",
      docsUrl: "https://github.com/vuejs/language-tools",
    },
  },
  {
    id: "sourcekit",
    name: "Swift",
    command: "sourcekit-lsp",
    args: [],
    languages: { swift: "swift" },
    rootMarkers: ["Package.swift"],
    install: {
      docsUrl: "https://github.com/swiftlang/sourcekit-lsp",
    },
  },
];

function fromCustom(server: LspCustomServer): LspPreset {
  return {
    id: server.id,
    name: server.name,
    command: server.command,
    args: server.args,
    languages: server.languages,
    rootMarkers: server.rootMarkers,
  };
}

export function allServers(custom: LspCustomServer[]): LspPreset[] {
  return [...LSP_PRESETS, ...custom.map(fromCustom)];
}

export function serversForLanguage(
  langId: string | null,
  custom: LspCustomServer[],
): LspPreset[] {
  if (!langId) return [];
  return allServers(custom).filter((p) => langId in p.languages);
}

// Several presets can claim a language (pyright and ruff both take `py`).
// The enabled one wins; among untouched candidates the first non-dismissed
// is offered by the statusbar hint. Preset order breaks remaining ties.
export function serverForLanguage(
  langId: string | null,
  custom: LspCustomServer[],
  activation?: Record<string, string | undefined>,
): LspPreset | null {
  const candidates = serversForLanguage(langId, custom);
  if (candidates.length === 0) return null;
  if (activation) {
    const enabled = candidates.find((p) => activation[p.id] === "enabled");
    if (enabled) return enabled;
    const fresh = candidates.find((p) => activation[p.id] !== "dismissed");
    if (fresh) return fresh;
  }
  return candidates[0];
}
