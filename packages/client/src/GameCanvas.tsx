import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./GameCanvas.css";

const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;

// The whole game UI is designed at a fixed 1920x1080 canvas (DESIGN_NOTES.md
// — a game-style fixed layout, not a fluid webpage) and scaled as a single
// unit to fit whatever viewport it's actually shown in, rather than
// reflowing region proportions at different sizes.
function useCanvasScale(): number {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    function updateScale() {
      const scaleX = window.innerWidth / CANVAS_WIDTH;
      const scaleY = window.innerHeight / CANVAS_HEIGHT;
      setScale(Math.min(scaleX, scaleY));
    }
    updateScale();
    window.addEventListener("resize", updateScale);
    return () => window.removeEventListener("resize", updateScale);
  }, []);

  return scale;
}

interface GameCanvasProps {
  readonly ribbon: ReactNode;
  readonly left: ReactNode;
  readonly center: ReactNode;
  readonly right: ReactNode;
  readonly bottom: ReactNode;
  readonly actionBox: ReactNode;
}

// Six fixed regions, evolved from DESIGN_NOTES.md's original screen-region
// table: ribbon (y 0-175, full width); left column (x 0-480, y 175-830,
// Card Viewer only now); center pane (x 480-1660, y 175-830, widened by
// however much the action-box column below borrows from its own row —
// see GameCanvas.css's 4-column layout); the Action Box (its own column
// immediately left of Chat/Log, y 830-1080 — the same row as, and same
// height as, the hand strip, so it lines up with wherever Game Chat's own
// bottom-of-column position falls); right column (x 1660-1920, full
// height, Game Log + Game Chat stacked); hand strip (x 0-[action box's
// left edge], y 830-1080 — starts at the screen's left edge now that the
// Action Box no longer shares the left column's lower half).
export function GameCanvas({ ribbon, left, center, right, bottom, actionBox }: GameCanvasProps) {
  const scale = useCanvasScale();
  const wrapperRef = useRef<HTMLDivElement>(null);

  return (
    <div className="canvas-wrapper" ref={wrapperRef}>
      <div className="game-canvas" style={{ transform: `scale(${scale})` }}>
        <div className="region-ribbon">{ribbon}</div>
        <div className="region-left">{left}</div>
        <div className="region-center">{center}</div>
        <div className="region-right">{right}</div>
        <div className="region-bottom">{bottom}</div>
        <div className="region-actionbox">{actionBox}</div>
      </div>
    </div>
  );
}
