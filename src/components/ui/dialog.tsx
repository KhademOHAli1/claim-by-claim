'use client';

import {
  DialogBackdrop,
  DialogContent as SdkDialogContent,
} from '@ui-sdk/react/dialog';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@ui-sdk/react/dialog';

export function DialogContent({
  className,
  ...props
}: Omit<ComponentProps<typeof SdkDialogContent>, 'className'> & {
  className?: string;
}) {
  return (
    <>
      <DialogBackdrop className="fixed inset-0 z-50 bg-black/50" />
      <SdkDialogContent
        {...props}
        className={cn(
          'fixed inset-0 z-50 m-auto h-fit overscroll-contain outline-none',
          className,
        )}
      />
    </>
  );
}
