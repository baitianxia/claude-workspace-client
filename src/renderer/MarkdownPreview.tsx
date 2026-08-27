import { useEffect, useId, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { HighlightedCode } from "./code-rendering";

let mermaidInitialized = false;

function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tooLarge = source.length > 100_000;

  useEffect(() => {
    let disposed = false;
    setSvg(null);
    setError(null);
    if (tooLarge) {
      return () => {
        disposed = true;
      };
    }
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        if (!mermaidInitialized) {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            suppressErrorRendering: true,
            theme: "dark",
            htmlLabels: false,
            fontFamily: 'Inter, "Segoe UI", sans-serif',
          });
          mermaidInitialized = true;
        }
        const diagramId = `workspace-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/gu, "")}`;
        return mermaid.render(diagramId, source);
      })
      .then((result) => {
        if (!disposed) {
          setSvg(result.svg);
        }
      })
      .catch((renderError: unknown) => {
        if (!disposed) {
          setError(
            renderError instanceof Error ? renderError.message : String(renderError),
          );
        }
      });
    return () => {
      disposed = true;
    };
  }, [reactId, source, tooLarge]);

  if (tooLarge) {
    return (
      <div className="mermaid-error" role="alert">
        <strong>Mermaid 图表过大</strong>
        <span>单个 Mermaid 代码块不能超过 100,000 个字符。</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mermaid-error" role="alert">
        <strong>Mermaid 图表无法渲染</strong>
        <span>{error}</span>
      </div>
    );
  }
  if (!svg) {
    return <div className="mermaid-loading">正在渲染 Mermaid 图表…</div>;
  }
  return (
    <div
      className="mermaid-diagram"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function MarkdownPreview({ content }: { content: string }) {
  return (
    <article className="markdown-preview">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a({ children, ...props }) {
            return (
              <a {...props} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
          code({ children, className, node: _node, ...props }) {
            const language = /language-([^\s]+)/u.exec(className ?? "")?.[1];
            const source = String(children).replace(/\n$/u, "");
            if (language === "mermaid") {
              return <MermaidDiagram source={source} />;
            }
            if (language || String(children).includes("\n")) {
              return (
                <HighlightedCode
                  content={source}
                  language={language ?? "plaintext"}
                  className="markdown-code-block"
                />
              );
            }
            return <code {...props} className={className}>{children}</code>;
          },
          pre({ children }) {
            return <>{children}</>;
          },
        }}
      >
        {content}
      </Markdown>
    </article>
  );
}
