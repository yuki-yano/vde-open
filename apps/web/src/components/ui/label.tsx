import * as React from 'react';
import { cn } from 'cn';

function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    // 入力欄との関連付けは、呼び出し側で行う（htmlForか、入力欄をlabelの中に置く）。
    // oxlint-disable-next-line jsx-a11y/label-has-associated-control
    <label
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Label };
