import type { DocumentFormat } from '@vde-open/shared';
import { FileCode, FileText, Image } from 'lucide-react';

import { cn } from '@/lib/utils';

// Markdown and HTML differ in both shape and color, so the format can be told at a glance and without color.
// The colors meet 3:1 against the background and the selected row in both themes (see --format-* in index.css).
export function FormatIcon({ format, className }: { format: DocumentFormat; className?: string }) {
  const Icon = format === 'image' ? Image : format === 'html' ? FileCode : FileText;
  return (
    <Icon
      className={cn(
        'size-4 shrink-0',
        format === 'image'
          ? 'text-foreground'
          : format === 'html'
            ? 'text-format-html'
            : 'text-format-markdown',
        className,
      )}
      data-format={format}
      aria-hidden="true"
    />
  );
}
