import { bindDrag, dragThreshold } from '@ui-sdk/core';
import {
  Actions,
  Model,
  TabSetNode,
  type DropInfo,
  type TabNode,
} from 'flexlayout-react';

type DockNode = TabNode | TabSetNode;

type DockModel = Model & {
  findDropTargetNode?: (
    layoutId: string,
    source: DockNode,
    x: number,
    y: number,
    excludeCenter: boolean,
  ) => DropInfo | undefined;
};

export type DockPreview = {
  x: number;
  y: number;
  width: number;
  height: number;
  className: string;
};

type MoveCallbacks = {
  onStart: () => void;
  onPreview: (preview: DockPreview | null) => void;
  onFinish: () => void;
};

export function startDockMove(
  model: Model,
  layout: HTMLElement,
  source: DockNode,
  handle: HTMLElement,
  event: PointerEvent,
  { onStart, onPreview, onFinish }: MoveCallbacks,
): (() => void) | undefined {
  // FlexLayout 0.11.1 uses this hit test for its native drag and drop.
  const findDropTarget = (model as DockModel).findDropTargetNode;
  if (
    typeof findDropTarget !== 'function' ||
    !source.isEnableDrag() ||
    source.getLayoutId() !== Model.MAIN_LAYOUT_ID
  ) return;

  const targetAt = (clientX: number, clientY: number) => {
    if (!layout.isConnected || model.getNodeById(source.getId()) !== source) return;
    const bounds = layout.getBoundingClientRect();
    const x = clientX - bounds.left;
    const y = clientY - bounds.top;
    if (x < 0 || x >= bounds.width || y < 0 || y >= bounds.height) return;

    const excludeCenter = source instanceof TabSetNode &&
      (!source.isEnableClose() || source.getTabNodes().some((tab) => tab.isPinned()));
    return findDropTarget.call(model, Model.MAIN_LAYOUT_ID, source, x, y, excludeCenter);
  };

  let started = false;
  return bindDrag(handle, event, {
    threshold: dragThreshold,
    cancelOnEscape: true,
    onStart() {
      started = true;
      onStart();
    },
    onMove({ x, y }) {
      const target = targetAt(x, y);
      onPreview(target ? { ...target.rect.toJson(), className: target.className } : null);
    },
    onEnd(end, canceled) {
      try {
        const target = started && !canceled ? targetAt(end.clientX, end.clientY) : undefined;
        if (target) {
          model.doAction(Actions.moveNode(
            source.getId(),
            target.node.getId(),
            target.location,
            target.index,
          ));
        }
      } finally {
        if (started) onPreview(null);
        onFinish();
      }
    },
  });
}
