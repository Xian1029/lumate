"use client";

import type { ContentNode } from "@/lib/api";
import { MarkdownRenderer } from "@/components/shared/markdown-renderer";

interface ContentNodeItemProps {
  node: ContentNode;
  depth?: number;
}

export function ContentNodeItem({ node, depth = 0 }: ContentNodeItemProps) {
  const headingLevel = Math.min(node.level + 1, 6);

  const headingClass = `font-semibold mb-1 ${
    headingLevel === 1
      ? "text-xl"
      : headingLevel === 2
        ? "text-lg"
        : headingLevel === 3
          ? "text-base"
          : "text-sm"
  }`;

  return (
    <div
      id={`content-${node.id}`}
      className="mb-6 min-w-0"
      style={{ marginInlineStart: depth > 0 ? `${Math.min(depth, 3) * 12}px` : undefined }}
    >
      {(() => {
        const Tag = `h${headingLevel}` as keyof React.JSX.IntrinsicElements;
        return <Tag className={headingClass}>{node.title}</Tag>;
      })()}
      {node.content ? (
        <MarkdownRenderer
          content={node.content}
          className="max-w-none min-w-0 break-words text-sm leading-7"
        />
      ) : null}
      {node.children?.map((child) => (
        <ContentNodeItem key={child.id} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}
