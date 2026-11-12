'use client';

import { useId, type ReactNode } from 'react';
import { Maximize2, Minimize2, Rows2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import './mobile-workspace.css';

export const mobileMediaQuery =
  '(max-width: 740px), (max-width: 960px) and (max-height: 540px) and (pointer: coarse)';

const playerSizes = [
  { value: 'compact', label: 'Compact', Icon: Minimize2 },
  { value: 'balanced', label: 'Balanced', Icon: Rows2 },
  { value: 'expanded', label: 'Expanded', Icon: Maximize2 },
] as const;

const panels = [
  { value: 'transcript', label: 'Transcript' },
  { value: 'finding', label: 'Fact check' },
  { value: 'evidence', label: 'Sources' },
] as const;

export type PlayerSize = (typeof playerSizes)[number]['value'];
export type MobilePanel = (typeof panels)[number]['value'];

export default function MobileWorkspace({
  panes,
  playerSize,
  onPlayerSizeChange,
  panel,
  onPanelChange,
  currentClaim,
  caption,
}: {
  panes: Record<'video' | MobilePanel, ReactNode>;
  playerSize: PlayerSize;
  onPlayerSizeChange: (size: PlayerSize) => void;
  panel: MobilePanel | null;
  onPanelChange: (panel: MobilePanel | null) => void;
  currentClaim: ReactNode;
  caption: ReactNode;
}) {
  const id = useId();

  return (
    <div
      className="mobile-workspace"
      data-player-size={playerSize}
      data-panel={panel ?? 'closed'}
    >
      <div className="mobile-player-sizes" role="group" aria-label="Player size">
        {playerSizes.map(({ value, label, Icon }) => (
          <Button
            key={value}
            type="button"
            variant="ghost"
            aria-pressed={playerSize === value}
            aria-controls={`${id}-player`}
            onClick={() => onPlayerSizeChange(value)}
          >
            <Icon aria-hidden="true" />
            {label}
          </Button>
        ))}
      </div>
      <div className="mobile-playback" id={`${id}-player`}>
        <div className="mobile-player">
          {panes.video}
          {playerSize === 'balanced' && (
            <div className="mobile-player-context">{currentClaim}</div>
          )}
        </div>
        {playerSize === 'expanded' && caption && (
          <div className="mobile-caption">{caption}</div>
        )}
      </div>
      <nav className="mobile-panel-controls" aria-label="Claim information">
        {panels.map(({ value, label }) => (
          <Button
            key={value}
            type="button"
            variant="ghost"
            aria-pressed={panel === value}
            aria-controls={`${id}-${value}`}
            onClick={() =>
              onPanelChange(
                panel === value && playerSize === 'expanded' ? null : value,
              )
            }
          >
            {label}
          </Button>
        ))}
      </nav>
      {panels.map(({ value }) => (
        <div
          key={value}
          id={`${id}-${value}`}
          className="mobile-panel"
          hidden={panel !== value}
        >
          {panes[value]}
        </div>
      ))}
    </div>
  );
}
