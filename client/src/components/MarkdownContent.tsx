import { memo } from 'react';
import { Streamdown, type Components, type ControlsConfig } from 'streamdown';
import { code } from '@streamdown/code';
import 'streamdown/styles.css';

const plugins = { code };

const controls: ControlsConfig = {
  code: { copy: true, download: false },
  table: false,
  mermaid: false,
};

const components: Components = {
  a: ({ href, children, node: _node, ...props }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2 decoration-zinc-300 dark:decoration-zinc-600 hover:decoration-zinc-500 dark:hover:decoration-zinc-400 transition-colors"
      {...props}
    >
      {children}
    </a>
  ),
};

const compactMarkdownClassName = [
  'text-sm leading-relaxed text-zinc-700 dark:text-zinc-300',
  '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-base',
  '[&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-sm',
  '[&_h3]:mt-2.5 [&_h3]:mb-1 [&_h3]:text-sm',
  '[&_p]:mb-2 [&_p:last-child]:mb-0',
  '[&_ul]:mb-2 [&_ul:last-child]:mb-0 [&_ol]:mb-2 [&_ol:last-child]:mb-0',
  '[&_blockquote]:my-2',
  '[&_pre]:text-[13px] [&_code]:text-[13px]',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
].join(' ');

export const MarkdownContent = memo(function MarkdownContent({
  content,
  isStreaming = false,
}: {
  content: string;
  isStreaming?: boolean;
}) {
  return (
    <Streamdown
      animated={isStreaming}
      caret={isStreaming ? 'block' : undefined}
      className={compactMarkdownClassName}
      components={components}
      controls={controls}
      isAnimating={isStreaming}
      plugins={plugins}
    >
      {content}
    </Streamdown>
  );
});
