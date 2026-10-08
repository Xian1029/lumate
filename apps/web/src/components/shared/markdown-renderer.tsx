"use client";

import { useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { buildMermaidFallbackText, hasRenderableMermaidContent, stabilizeMermaidCode } from "@/lib/markdown/mermaid";
import { t } from "@/lib/i18n";
import "katex/dist/katex.min.css";

type MermaidInstance = typeof import("mermaid")["default"];

let mermaidLoader: Promise<MermaidInstance> | null = null;

function getMermaid() {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: "default",
        suppressErrorRendering: true,
        htmlLabels: false,
        // Mermaid flowcharts otherwise put node labels in <foreignObject>.
        // The SVG is sanitized before insertion, which correctly removes those
        // embedded HTML nodes and used to leave only empty boxes. SVG <text>
        // labels survive sanitization and remain safe to render.
      });
      return mermaid;
    });
  }
  return mermaidLoader;
}

function createMermaidRenderId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `mermaid-${crypto.randomUUID()}`;
  }
  return `mermaid-${Math.random().toString(36).slice(2, 10)}`;
}

function MermaidBlock({ code }: { code: string }) {
  const renderIdRef = useRef<string | null>(null);
  const [svgMarkup, setSvgMarkup] = useState("");
  const [fallbackText, setFallbackText] = useState("");

  if (renderIdRef.current == null) {
    renderIdRef.current = createMermaidRenderId();
  }

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const mermaid = await getMermaid();
        const preparedCode = stabilizeMermaidCode(code);
        if (!hasRenderableMermaidContent(preparedCode)) {
          throw new Error("Diagram has no renderable nodes");
        }
        const renderId = renderIdRef.current ?? createMermaidRenderId();
        renderIdRef.current = renderId;
        const { svg } = await mermaid.render(renderId, preparedCode);
        if (!svg.includes("<svg")) {
          throw new Error("Mermaid returned an empty diagram");
        }
        if (!cancelled) {
          setSvgMarkup(DOMPurify.sanitize(svg));
          setFallbackText("");
        }
      } catch {
        if (!cancelled) {
          setSvgMarkup("");
          setFallbackText(buildMermaidFallbackText(code));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (svgMarkup) {
    return (
      <div
        className="my-4 flex justify-center overflow-x-auto [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: svgMarkup }}
      />
    );
  }

  if (fallbackText) {
    return (
      <div className="my-4">
        <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            {t("markdown.diagramFallback")}
          </p>
          <pre className="whitespace-pre-wrap text-sm text-foreground">{fallbackText}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="my-4">
      <div className="rounded-xl border border-border/40 bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
        {t("markdown.diagramRendering")}
      </div>
    </div>
  );
}

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export function normalizeMarkdownEmphasis(value: string): string {
  // Generated plans occasionally put a space immediately before the closing
  // marker (``**先看懂： **``). CommonMark treats that as plain text.
  const generallyNormalized = value
    // Older saved plans escaped Markdown punctuation before persistence.
    .replace(/\\\*\\\*/g, "**")
    // Normalize full-width stars occasionally returned by local models.
    .replace(/＊＊/g, "**")
    // Remove normal, non-breaking and zero-width whitespace before ``**``.
    .replace(/\*\*([^*\n]*?\S)[\s\u00a0\u200b]+\*\*/g, "**$1** ");
  return generallyNormalized.split("\n").map((line) => {
    if (!/^\s*[-*]\s*\[[ xX]\]\s+/.test(line)) return line;
    // Be deliberately tolerant inside generated task rows. Older plans may
    // contain repeated escaping, spaces between markers, or invisible spaces.
    const clean = line.replace(/\\+(?=\*)/g, "").replace(/＊/g, "*");
    const match = clean.match(/^(\s*[-*]\s*\[[ xX]\]\s+)\*\*\s*(.*?)\s*\*\*\s*(.*)$/);
    if (!match) return clean;
    return `${match[1]}**${match[2].trim()}** ${match[3].trimStart()}`;
  }).join("\n");
}

export function MarkdownRenderer({
  content,
  className,
}: MarkdownRendererProps) {
  const normalizedContent = normalizeMarkdownEmphasis(content);

  return (
    <div role="article" className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          input({ type, checked, ...props }) { return <input type={type} checked={checked} readOnly {...props} />; },
          h1({ children }) {
            return <h1 className="mb-4 mt-2 border-b border-brand/20 pb-2 text-xl font-bold tracking-tight text-foreground">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="mb-2 mt-6 flex items-center gap-2 text-base font-bold text-foreground before:block before:h-5 before:w-1 before:rounded-full before:bg-brand">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="mb-2 mt-5 text-base font-bold text-foreground">{children}</h3>;
          },
          p({ children }) {
            return <p className="my-2 leading-7 text-foreground/90">{children}</p>;
          },
          ul({ children }) {
            return <ul className="my-3 space-y-1.5 rounded-xl bg-brand-muted/20 px-5 py-3 marker:text-brand">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="my-3 space-y-2 rounded-xl border border-border/60 bg-muted/20 px-7 py-3 marker:font-semibold marker:text-brand">{children}</ol>;
          },
          li({ children }) {
            return <li className="pl-1 leading-6 text-foreground/90">{children}</li>;
          },
          blockquote({ children }) {
            return <blockquote className="my-4 rounded-r-xl border-l-4 border-brand bg-brand-muted/20 px-4 py-3 text-foreground/90 shadow-sm">{children}</blockquote>;
          },
          hr() {
            return <hr className="my-6 border-border/60" />;
          },
          strong({ children }) {
            return <strong className="font-bold text-foreground">{children}</strong>;
          },
          code({ className: codeClassName, children, ...props }) {
            const match = /language-(\w+)/.exec(codeClassName || "");
            const language = match?.[1];

            if (language === "mermaid") {
              return <MermaidBlock code={String(children).trim()} />;
            }

            if (language) {
              return (
                <pre className="my-2 overflow-x-auto rounded-xl bg-muted/30 p-3.5 text-sm">
                  <code className={codeClassName} {...props}>
                    {children}
                  </code>
                </pre>
              );
            }

            return (
              <code className="rounded-md bg-muted/30 px-1 py-0.5 text-sm" {...props}>
                {children}
              </code>
            );
          },
          table({ children }) {
            return (
              <div
                role="region"
                aria-label={t("markdown.tableLabel")}
                tabIndex={0}
                className="my-4 max-w-full overflow-x-auto rounded-xl border border-border/60 bg-card shadow-sm"
              >
                <table className="w-full min-w-[36rem] table-auto border-collapse text-sm">
                  {children}
                </table>
              </div>
            );
          },
          th({ children }) {
            return (
              <th className="border-b border-r border-border/60 bg-emerald-50/65 px-4 py-2.5 text-left font-semibold text-foreground last:border-r-0">
                {children}
              </th>
            );
          },
          td({ children }) {
            return <td className="border-b border-r border-border/60 px-4 py-2.5 align-top leading-6 text-foreground/90 last:border-r-0">{children}</td>;
          },
        }}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
}
