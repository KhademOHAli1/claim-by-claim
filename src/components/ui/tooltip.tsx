'use client';

import type { ComponentProps } from 'react';
import {
  Tooltip as SdkTooltip,
  TooltipArrow,
  TooltipContent as SdkTooltipContent,
  TooltipTrigger,
} from '@ui-sdk/react/tooltip';
import { cn } from '@/lib/utils';

function Tooltip({ delay = 200, ...props }: ComponentProps<typeof SdkTooltip>) {
  return <SdkTooltip delay={delay} {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 5,
  children,
  ...props
}: ComponentProps<typeof SdkTooltipContent> & { children?: React.ReactNode }) {
  return (
    <SdkTooltipContent
      sideOffset={sideOffset}
      className={cn(
        'm-0 z-50 w-fit overflow-visible rounded-md border-0 bg-foreground px-3 py-1.5 text-xs text-balance text-background',
        'origin-(--transform-origin) motion-safe:transition-[opacity,scale] motion-safe:duration-150',
        'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 motion-safe:data-[starting-style]:scale-95 motion-safe:data-[ending-style]:scale-95 data-[instant]:transition-none',
        className,
      )}
      {...props}
    >
      {children}
      <TooltipArrow className="size-2 rotate-45 rounded-[2px] bg-foreground" />
    </SdkTooltipContent>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent };
