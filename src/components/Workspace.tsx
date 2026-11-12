'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  Layout,
  Model,
  type IJsonModel,
  type IJsonTabSetNode,
} from 'flexlayout-react';
import { GripVertical } from 'lucide-react';
import 'flexlayout-react/style/dark.css';
import './workspace.css';

const paneTitles = {
  video: 'Video',
  transcript: 'Transcript',
  finding: 'Fact check',
  evidence: 'Evidence',
};
type Pane = keyof typeof paneTitles;
const storageKey = 'claim-by-claim:workspace:v1';

function tabset(pane: Pane, weight: number): IJsonTabSetNode {
  return {
    type: 'tabset',
    id: `group-${pane}`,
    weight,
    children: [
      { type: 'tab', id: pane, name: paneTitles[pane], component: pane },
    ],
  };
}

const defaults: IJsonModel = {
  global: {
    enableEdgeDock: true,
    tabEnableClose: false,
    tabEnableRename: false,
    tabEnableRenderOnDemand: false,
    tabSetMinWidth: 160,
    tabSetMinHeight: 114,
  },
  layout: {
    type: 'row',
    children: [
      tabset('video', 35),
      tabset('transcript', 35),
      {
        type: 'row',
        weight: 30,
        children: [tabset('finding', 57), tabset('evidence', 43)],
      },
    ],
  },
};

function restoreModel() {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return;
    const saved: IJsonModel = JSON.parse(stored);
    const model = Model.fromJson({
      global: defaults.global,
      layout: saved.layout,
    });
    const found = new Set<string>();
    let valid = true;
    model.visitNodes((node) => {
      if (node.getType() !== 'tab') return;
      const id = node.getId();
      if (!Object.hasOwn(paneTitles, id) || found.has(id)) valid = false;
      found.add(id);
    });
    if (valid && found.size === Object.keys(paneTitles).length) return model;
  } catch {
    // A corrupt or unavailable local preference should not prevent playback.
  }
}

export default function Workspace({
  panes,
  resetToken,
}: {
  panes: Record<Pane, ReactNode>;
  resetToken: number;
}) {
  const [model, setModel] = useState(() => Model.fromJson(defaults));

  useEffect(() => {
    if (resetToken === 0) {
      const saved = restoreModel();
      if (saved) setModel(saved);
      return;
    }
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* Preferences are optional. */
    }
    setModel(Model.fromJson(defaults));
  }, [resetToken]);

  return (
    <div className="dock-workspace">
      <Layout
        model={model}
        factory={(node) => panes[node.getId() as Pane]}
        supportsPopout={false}
        realtimeResize
        tabDragSpeed={0.12}
        onRenderTab={(node, values) => {
          values.leading = <GripVertical size={12} aria-hidden="true" />;
          values.content = (
            <span
              className="dock-title"
              title={`Drag ${paneTitles[node.getId() as Pane]} to move it`}
            >
              {paneTitles[node.getId() as Pane]}
            </span>
          );
        }}
        onModelChange={(updated) => {
          try {
            localStorage.setItem(storageKey, JSON.stringify(updated.toJson()));
          } catch {
            /* Preferences are optional. */
          }
        }}
      />
    </div>
  );
}
