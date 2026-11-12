import { bindDrag, dragThreshold } from '@ui-sdk/core';
import { Actions, Model, Orientation, RowNode, TabSetNode } from 'flexlayout-react';

type SplitterGeometry = {
  getSplitterInitials(index: number): {
    initialSizes: number[];
    sum: number;
    startPosition: number;
  };
  getSplitterBounds(index: number): number[];
  calculateSplit(
    index: number,
    position: number,
    initialSizes: number[],
    sum: number,
    startPosition: number,
  ): number[];
};

function getSplitterRow(model: Model, path: string) {
  let row: RowNode | undefined;
  model.visitLayoutNodes(Model.MAIN_LAYOUT_ID, (node) => {
    if (node instanceof RowNode && node.getPath() === path) row = node;
  });
  return row;
}

function supportsSplitterGeometry(row: RowNode): row is RowNode & SplitterGeometry {
  // FlexLayout 0.11.1 uses these runtime helpers in its own splitter.
  const geometry = row as RowNode & Partial<SplitterGeometry>;
  return (
    typeof geometry.getSplitterInitials === 'function' &&
    typeof geometry.getSplitterBounds === 'function' &&
    typeof geometry.calculateSplit === 'function'
  );
}

export function startDockResize(
  model: Model,
  root: HTMLElement,
  splitter: HTMLElement,
  event: PointerEvent,
  onFinish: (committed: boolean) => void,
): (() => void) | undefined {
  if (event.button !== 0 || !event.isPrimary || !root.contains(splitter)) return;

  const match = /^(.*)\/s(\d+)$/.exec(splitter.dataset.layoutPath ?? '');
  if (!match) return;
  const row = getSplitterRow(model, match[1]);
  if (!row || !supportsSplitterGeometry(row)) return;

  const index = Number(match[2]) + 1;
  const children = [...row.getChildren()];
  if (
    index >= children.length ||
    !children.every((child) => child instanceof RowNode || child instanceof TabSetNode)
  ) return;

  const { initialSizes, sum, startPosition } = row.getSplitterInitials(index);
  const [minimum, maximum] = row.getSplitterBounds(index);
  if (
    !Number.isFinite(sum) || sum <= 0 ||
    !Number.isFinite(startPosition) ||
    !Number.isFinite(minimum) || !Number.isFinite(maximum)
  ) return;

  const rowId = row.getId();
  const originalWeights = children.map((child) => child.getWeight());
  const horizontal = row.getOrientation() === Orientation.HORZ;
  const pointerStart = horizontal ? event.clientX : event.clientY;
  let position = startPosition;
  let draftWeights: number[] | undefined;
  let active = true;

  const isCurrentRow = () => {
    if (model.getNodeById(rowId) !== row) return false;
    const currentChildren = row.getChildren();
    return (
      children.length === currentChildren.length &&
      children.every((child, childIndex) => child === currentChildren[childIndex])
    );
  };

  function finish(canceled: boolean) {
    if (!active) return false;
    active = false;
    if (!draftWeights || position === startPosition || !isCurrentRow()) return false;
    if (canceled) {
      // FlexLayout writes draft sizes directly to the DOM, so rollback uses the same path.
      model.doAction(Actions.adjustWeights(rowId, originalWeights).setAdjusting(true));
      return false;
    }
    model.doAction(Actions.adjustWeights(rowId, draftWeights));
    return true;
  }

  const stopDrag = bindDrag(splitter, event, {
    threshold: dragThreshold,
    cancelOnEscape: true,
    onMove: ({ x, y }) => {
      const offset = (horizontal ? x : y) - pointerStart;
      const nextPosition = Math.max(minimum, Math.min(maximum, startPosition + offset));
      if (nextPosition === position || !isCurrentRow()) return;
      position = nextPosition;
      draftWeights = nextPosition === startPosition
        ? originalWeights
        : row.calculateSplit(index, nextPosition, initialSizes, sum, startPosition);
      model.doAction(Actions.adjustWeights(rowId, draftWeights).setAdjusting(true));
    },
    onEnd: (_event, canceled) => {
      onFinish(finish(canceled));
    },
  });

  return () => {
    stopDrag();
    finish(true);
  };
}
