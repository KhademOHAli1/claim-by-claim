'use client';

import type { ComponentProps } from 'react';
import {
  Tabs as SdkTabs,
  TabsList as SdkTabsList,
  TabsPanel,
  TabsTab,
} from '@ui-sdk/react/tabs';
import { cn } from '@/lib/utils';

function Tabs<Value extends string>({
  className,
  ...props
}: ComponentProps<typeof SdkTabs<Value>>) {
  return <SdkTabs<Value> className={cn('group/tabs', className)} {...props} />;
}

function TabsList({ className, ...props }: ComponentProps<typeof SdkTabsList>) {
  return (
    <SdkTabsList
      className={cn(
        'inline-flex w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground',
        'group-data-[orientation=vertical]/tabs:flex-col',
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsTab>) {
  return (
    <TabsTab
      className={cn(
        'relative inline-flex flex-1 items-center justify-center whitespace-nowrap rounded-md text-sm font-medium',
        'text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
        'data-[selected]:text-foreground data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsPanel as TabsContent };
