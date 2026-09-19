// Shared surface for the chat-landing context pills above the composer
// (machine, project, branch/worktree). Light mode: white with a hairline
// border and a soft drop shadow; dark mode keeps the translucent fill.
export const CONTEXT_PILL_SURFACE_CLASS =
  'border-[0.5px] border-border bg-white shadow-[0px_0.5px_1px_1px_rgba(0,0,0,0.03)] dark:border-transparent dark:bg-foreground/[0.08] dark:shadow-none';

export const CONTEXT_PILL_HOVER_CLASS =
  'hover:bg-hover hover:text-foreground data-[state=open]:bg-hover data-[state=open]:text-foreground dark:hover:bg-foreground/[0.12] dark:data-[state=open]:bg-foreground/[0.12]';
