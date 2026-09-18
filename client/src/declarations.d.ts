declare module 'markdown-it-task-lists' {
  import type { MarkdownIt } from 'markdown-it';
  const p: (md: MarkdownIt, opts?: { enabled?: boolean; label?: boolean; labelAfter?: boolean }) => void;
  export default p;
}
declare module 'markdown-it-footnote' { import type { MarkdownIt } from 'markdown-it'; const p: (md: MarkdownIt) => void; export default p; }
declare module 'markdown-it-deflist' { import type { MarkdownIt } from 'markdown-it'; const p: (md: MarkdownIt) => void; export default p; }
declare module 'markdown-it-sub' { import type { MarkdownIt } from 'markdown-it'; const p: (md: MarkdownIt) => void; export default p; }
declare module 'markdown-it-sup' { import type { MarkdownIt } from 'markdown-it'; const p: (md: MarkdownIt) => void; export default p; }
declare module 'markdown-it-mark' { import type { MarkdownIt } from 'markdown-it'; const p: (md: MarkdownIt) => void; export default p; }
declare module 'markdown-it-container' {
  import type { MarkdownIt, Token } from 'markdown-it';
  const p: (md: MarkdownIt, name: string, opts?: { validate?: (params: string) => boolean; render?: (tokens: Token[], idx: number) => string; marker?: string }) => void;
  export default p;
}
declare module 'markdown-it-emoji' {
  import type { MarkdownIt } from 'markdown-it';
  type EmojiPlugin = (md: MarkdownIt, opts?: { defs?: Record<string, string>; enabled?: string[]; shortcuts?: Record<string, string | string[]> }) => void;
  export const full: EmojiPlugin;
  export const light: EmojiPlugin;
  export const bare: EmojiPlugin;
}
