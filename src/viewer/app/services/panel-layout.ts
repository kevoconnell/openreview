// @ts-nocheck
import { useEffect, useRef, useState } from "react";

export const INSPECTOR_WIDTH_KEY = "openreview:inspector-width:v3";
export const DEFAULT_INSPECTOR_WIDTH = 420;

const MIN_INSPECTOR_WIDTH = 320;
const MAX_INSPECTOR_WIDTH = 760;
const MIN_LEFT_PANEL_WIDTH = 96;
const MAX_LEFT_PANEL_WIDTH = 420;

function getPanelWidthMax({ direction }) {
  if (typeof window === "undefined") {
    return direction === "left" ? MAX_LEFT_PANEL_WIDTH : MAX_INSPECTOR_WIDTH;
  }

  const hardMax =
    direction === "left" ? MAX_LEFT_PANEL_WIDTH : MAX_INSPECTOR_WIDTH;
  const viewportRatio = direction === "left" ? 0.4 : 0.7;
  const hardMin =
    direction === "left" ? MIN_LEFT_PANEL_WIDTH : MIN_INSPECTOR_WIDTH;
  return Math.max(
    hardMin,
    Math.min(hardMax, Math.floor(window.innerWidth * viewportRatio)),
  );
}

function clampPanelWidth(width, { direction }) {
  const hardMin =
    direction === "left" ? MIN_LEFT_PANEL_WIDTH : MIN_INSPECTOR_WIDTH;
  return Math.max(hardMin, Math.min(getPanelWidthMax({ direction }), width));
}

export function useResizablePanel({ storageKey, defaultWidth, direction }) {
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem(storageKey));
      return Number.isFinite(stored)
        ? clampPanelWidth(stored, { direction })
        : defaultWidth;
    } catch {
      return defaultWidth;
    }
  });
  const dragRef = useRef(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, String(width));
    } catch {
      // Ignore storage errors.
    }
  }, [storageKey, width]);

  useEffect(() => {
    const updateWidth = (clientX) => {
      if (!dragRef.current || typeof clientX !== "number") {
        return;
      }

      const delta =
        direction === "left"
          ? clientX - dragRef.current.startX
          : dragRef.current.startX - clientX;
      setWidth(
        clampPanelWidth(dragRef.current.startWidth + delta, { direction }),
      );
    };

    const onPointerMove = (event) => {
      updateWidth(event.clientX);
    };

    const onMouseMove = (event) => {
      updateWidth(event.clientX);
    };

    const stopDragging = () => {
      if (!dragRef.current) {
        return;
      }

      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    const onResize = () => {
      setWidth((currentWidth) => clampPanelWidth(currentWidth, { direction }));
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
    window.addEventListener("mouseup", stopDragging);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
      window.removeEventListener("mouseup", stopDragging);
      window.removeEventListener("resize", onResize);
      stopDragging();
    };
  }, [direction]);

  const startDragging = (clientX) => {
    dragRef.current = { startX: clientX, startWidth: width };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const onPointerDown = (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    startDragging(event.clientX);
  };

  const onMouseDown = (event) => {
    event.preventDefault();
    event.stopPropagation();
    startDragging(event.clientX);
  };

  return {
    panelStyle: {
      width: `${width}px`,
      minWidth: `${width}px`,
      flex: `0 0 ${width}px`,
    },
    handleProps: {
      onPointerDown,
      onMouseDown,
    },
  };
}
