import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { urlKey } from '@/utils/url';
import { remarkCitations } from './citations';
import type { Cite } from '@/types/citations';

// Sanitized rendering (spec 9.2): raw HTML is dropped (skipHtml, and no
// rehype-raw), images are removed, and react-markdown's default URL transform
// strips javascript: and other unsafe link targets. A link renders only when
// its URL is one of the exchange's sources; any other link shows as plain text.

type Props = {
  text: string;
  cites?: ReadonlyMap<string, Cite>;
  /** urlKey of every source read for this answer. */
  allowedUrls?: ReadonlySet<string>;
};

export function Markdown({ text, cites = new Map(), allowedUrls = new Set() }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkCitations(cites)]}
      skipHtml
      disallowedElements={['img']}
      components={{
        a: ({ href, title, children }) => {
          const key = href ? urlKey(href) : null;
          if (!key || !allowedUrls.has(key)) return <span>{children}</span>;
          return (
            <a href={href} title={title} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
