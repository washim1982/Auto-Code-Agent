import React from "react";
import { parseBlocks, safeHref, type Block, type Inline } from "./markdown.ts";

/**
 * Renders a model reply.
 *
 * Everything is built from the parsed tree rather than from HTML, so there is
 * no path by which model output becomes markup — the only thing a link can do
 * is carry an href, and even that is restricted below.
 */
export function Markdown({ source }: { source: string }): JSX.Element {
  return <div className="md">{parseBlocks(source).map(renderBlock)}</div>;
}

function renderBlock(block: Block, key: number): JSX.Element {
  switch (block.type) {
    case "heading": {
      const Tag = `h${Math.min(block.level + 2, 6)}` as "h3";
      return <Tag key={key}>{block.children.map(renderInline)}</Tag>;
    }
    case "code":
      return (
        <pre key={key}>
          {block.lang && <span className="lang">{block.lang}</span>}
          <code>{block.value}</code>
        </pre>
      );
    case "list":
      return block.ordered ? (
        <ol key={key}>
          {block.items.map((item, n) => (
            <li key={n}>{item.map(renderInline)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key}>
          {block.items.map((item, n) => (
            <li key={n}>{item.map(renderInline)}</li>
          ))}
        </ul>
      );
    case "quote":
      return <blockquote key={key}>{block.children.map(renderInline)}</blockquote>;
    case "table":
      return (
        // Wide tables scroll inside the message rather than stretching it.
        <div className="tw" key={key}>
          <table>
            <thead>
              <tr>
                {block.head.map((cell, n) => (
                  <th key={n}>{cell.map(renderInline)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, n) => (
                <tr key={n}>
                  {row.map((cell, m) => (
                    <td key={m}>{cell.map(renderInline)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr key={key} />;
    default:
      return <p key={key}>{block.children.map(renderInline)}</p>;
  }
}

function renderInline(node: Inline, key: number): JSX.Element {
  switch (node.type) {
    case "code":
      return <code key={key}>{node.value}</code>;
    case "strong":
      return <strong key={key}>{node.children.map(renderInline)}</strong>;
    case "em":
      return <em key={key}>{node.children.map(renderInline)}</em>;
    case "strike":
      return <s key={key}>{node.children.map(renderInline)}</s>;
    case "link":
      // Model output is untrusted, so only ordinary web links survive; a
      // javascript: or data: href renders as inert text.
      return safeHref(node.href) ? (
        <a key={key} href={node.href} target="_blank" rel="noreferrer noopener">
          {node.children.map(renderInline)}
        </a>
      ) : (
        <span key={key}>{node.children.map(renderInline)}</span>
      );
    default:
      return <React.Fragment key={key}>{node.value}</React.Fragment>;
  }
}
