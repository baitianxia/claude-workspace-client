import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const languages = {
  bash,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  php,
  plaintext,
  powershell,
  python,
  ruby,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

for (const [name, definition] of Object.entries(languages)) {
  hljs.registerLanguage(name, definition);
}

const extensionLanguages: Record<string, string> = {
  bash: "bash",
  c: "cpp",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  diff: "diff",
  dockerfile: "dockerfile",
  go: "go",
  h: "cpp",
  hpp: "cpp",
  htm: "xml",
  html: "xml",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  less: "css",
  md: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  patch: "diff",
  php: "php",
  properties: "ini",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "css",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  vue: "xml",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

const filenameLanguages: Record<string, string> = {
  dockerfile: "dockerfile",
  gemfile: "ruby",
  makefile: "plaintext",
};

export function languageForPath(path: string): string {
  const filename = path.split("/").at(-1)?.toLocaleLowerCase() ?? "";
  const filenameLanguage = filenameLanguages[filename];
  if (filenameLanguage) {
    return filenameLanguage;
  }
  const extension = filename.includes(".") ? filename.split(".").at(-1) ?? "" : "";
  return extensionLanguages[extension] ?? "plaintext";
}

export function isMarkdownPath(path: string): boolean {
  return ["md", "mdx", "markdown"].some((extension) =>
    path.toLocaleLowerCase().endsWith(`.${extension}`),
  );
}

export function HighlightedCode({
  content,
  language,
  className = "",
}: {
  content: string;
  language: string;
  className?: string;
}) {
  const supportedLanguage = hljs.getLanguage(language) ? language : "plaintext";
  const highlighted = hljs.highlight(content, {
    language: supportedLanguage,
    ignoreIllegals: true,
  }).value;
  return (
    <pre className={`code-viewer ${className}`.trim()}>
      <code
        className={`hljs language-${supportedLanguage}`}
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </pre>
  );
}

export function DiffViewer({ content }: { content: string }) {
  const lines = content ? content.split("\n") : [];
  return (
    <pre className="diff-viewer" aria-label="文件对比内容">
      <code>
        {lines.map((line, index) => {
          const kind = line.startsWith("+") && !line.startsWith("+++")
            ? "added"
            : line.startsWith("-") && !line.startsWith("---")
              ? "removed"
              : line.startsWith("@@")
                ? "hunk"
                : line.startsWith("diff ") || line.startsWith("index ")
                  ? "meta"
                  : "context";
          return (
            <span className={`diff-line diff-line--${kind}`} key={`${index}-${line}`}>
              <span className="diff-line-number" aria-hidden="true">{index + 1}</span>
              <span className="diff-line-content">{line || " "}</span>
            </span>
          );
        })}
      </code>
    </pre>
  );
}
