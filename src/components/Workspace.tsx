'use client';

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from 'react';
import {
  Layout,
  Model,
  TabNode,
  TabSetNode,
  type IJsonModel,
  type IJsonTabSetNode,
} from 'flexlayout-react';
import { GripVertical } from 'lucide-react';
import { startDockMove, type DockPreview } from './dock-move';
import { startDockResize } from './dock-resize';
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

function saveModel(model: Model) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(model.toJson()));
  } catch {
    /* Preferences are optional. */
  }
}

function tabAtPointer(model: Model, target: Element) {
  if (target.closest('button, a, input')) return;
  const tabElement = target.closest<HTMLElement>('.flexlayout__tab_button');
  if (tabElement) {
    const title = tabElement.querySelector<HTMLElement>('[data-dock-pane]');
    const tab = title?.dataset.dockPane && model.getNodeById(title.dataset.dockPane);
    if (tab instanceof TabNode && tab.isEnableDrag()) return { tab, element: tabElement };
    return;
  }

  const strip = target.closest<HTMLElement>('[data-layout-path$="/tabstrip"]');
  if (!strip) return;
  const path = strip.dataset.layoutPath?.slice(0, -'/tabstrip'.length);
  let tabset: TabSetNode | undefined;
  model.visitNodes((node) => {
    if (node instanceof TabSetNode && node.getPath() === path) tabset = node;
  });
  if (tabset?.isEnableDrag()) return { tab: tabset, element: strip };
}

export default function Workspace({
  panes,
  resetToken,
}: {
  panes: Record<Pane, ReactNode>;
  resetToken: number;
}) {
  const [model, setModel] = useState(() => Model.fromJson(defaults));
  const layoutRef = useRef<React.ComponentRef<typeof Layout>>(null);
  const gesture = useRef<{ kind: 'move' | 'resize'; stop: () => void } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropPreview, setDropPreview] = useState<DockPreview | null>(null);

  useEffect(() => () => {
    gesture.current?.stop();
    gesture.current = null;
  }, [model]);

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
    setDragging(false);
    setDropPreview(null);
    setModel(Model.fromJson(defaults));
  }, [resetToken]);

  function startGesture(event: PointerEvent<HTMLDivElement>) {
    if (gesture.current || event.button !== 0 || !event.isPrimary) return;
    const root = layoutRef.current?.getRootDiv();
    const target = event.target;
    if (!root || !(target instanceof Element) || !root.contains(target)) return;

    const splitter = target.closest<HTMLElement>('.flexlayout__splitter[role="separator"]');
    if (splitter) {
      const stop = startDockResize(model, root, splitter, event.nativeEvent, (committed) => {
        gesture.current = null;
        if (committed) saveModel(model);
      });
      if (!stop) return;
      gesture.current = { kind: 'resize', stop };
      event.stopPropagation();
      return;
    }

    const source = tabAtPointer(model, target);
    if (!source) return;
    const stop = startDockMove(model, root, source.tab, source.element, event.nativeEvent, {
      onStart: () => setDragging(true),
      onPreview: setDropPreview,
      onFinish: () => {
        gesture.current = null;
        setDragging(false);
        setDropPreview(null);
      },
    });
    if (stop) gesture.current = { kind: 'move', stop };
  }

  return (
    <div
      className="dock-workspace"
      data-dragging={dragging || undefined}
      onPointerDownCapture={startGesture}
      onDragStartCapture={(event) => {
        if (gesture.current?.kind !== 'move') return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <Layout
        ref={layoutRef}
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
              data-dock-pane={node.getId()}
              title={`Drag ${paneTitles[node.getId() as Pane]} to move it`}
            >
              {paneTitles[node.getId() as Pane]}
            </span>
          );
        }}
        onModelChange={(updated, action) => {
          if (!action.isAdjusting() && gesture.current?.kind !== 'resize') saveModel(updated);
        }}
      />
      {dragging && model.isEnableEdgeDock() && model.isEnableEdgeDockIndicators() && (
        <div className="dock-edge-markers" aria-hidden="true">
          <i /><i /><i /><i />
        </div>
      )}
      {dropPreview && (
        <div
          className={`dock-drop-preview ${dropPreview.className}`}
          style={{
            left: dropPreview.x,
            top: dropPreview.y,
            width: dropPreview.width,
            height: dropPreview.height,
          }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
