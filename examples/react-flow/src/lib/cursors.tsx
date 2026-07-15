import { useCallback, useEffect, useRef, useState } from "react";
import { useReactFlow, useStore } from "@xyflow/react";
import { trackPointer, stepSpring, isSpringAtRest } from "teleportal/cursors";
import type { SpringState } from "teleportal/cursors";
import type { Awareness } from "y-protocols/awareness";

import type { CursorComponentProps, CursorsProps } from "./types";

const SPRING_PARAMS = { stiffness: 180, damping: 24 };
const REST_DELTA = 0.5;
const REST_SPEED = 0.5;
const MAX_TIME_STEP = 0.064;
const STALE_TIMEOUT = 5000;

interface CursorAnimState {
  targetX: number;
  targetY: number;
  springX: SpringState;
  springY: SpringState;
  name?: string;
  color?: string;
  lastSeen: number;
}

function DefaultCursor({ x, y, name, color }: CursorComponentProps) {
  const cursorColor = color ?? "#6b7280";

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        transform: `translate(${x}px, ${y}px)`,
        pointerEvents: "none",
        zIndex: 1000,
        transition: "opacity 0.3s",
      }}
    >
      <svg
        width="16"
        height="20"
        viewBox="0 0 16 20"
        fill="none"
        style={{ display: "block" }}
      >
        <path
          d="M0.928955 0.291992L15.071 12.292H6.5L0.928955 18.708V0.291992Z"
          fill={cursorColor}
          stroke="white"
          strokeWidth="1"
        />
      </svg>
      {name && (
        <div
          style={{
            position: "absolute",
            top: 16,
            left: 10,
            background: cursorColor,
            color: "white",
            fontSize: "11px",
            lineHeight: "1",
            padding: "2px 6px",
            borderRadius: "3px",
            whiteSpace: "nowrap",
            fontWeight: 500,
          }}
        >
          {name}
        </div>
      )}
    </div>
  );
}

export function Cursors({ provider, components }: CursorsProps) {
  const { awareness } = provider;
  const reactFlow = useReactFlow();
  const viewport = useStore((s) => ({
    x: s.transform[0],
    y: s.transform[1],
    zoom: s.transform[2],
  }));

  const [renderedCursors, setRenderedCursors] = useState<
    Map<number, { x: number; y: number; name?: string; color?: string }>
  >(new Map());

  const animState = useRef<Map<number, CursorAnimState>>(new Map());
  const rafId = useRef(0);
  const lastFrameTime = useRef(0);

  const animate = useCallback(() => {
    const now = performance.now();
    const dt = Math.min((now - lastFrameTime.current) / 1000, MAX_TIME_STEP);
    lastFrameTime.current = now;

    let anyActive = false;
    const updated = new Map<number, { x: number; y: number; name?: string; color?: string }>();

    for (const [clientId, state] of animState.current) {
      if (now - state.lastSeen > STALE_TIMEOUT) {
        animState.current.delete(clientId);
        continue;
      }

      state.springX = stepSpring(state.springX, state.targetX, dt, SPRING_PARAMS);
      state.springY = stepSpring(state.springY, state.targetY, dt, SPRING_PARAMS);

      const atRestX = isSpringAtRest(state.springX, state.targetX, REST_DELTA, REST_SPEED);
      const atRestY = isSpringAtRest(state.springY, state.targetY, REST_DELTA, REST_SPEED);

      if (atRestX && atRestY) {
        state.springX.position = state.targetX;
        state.springY.position = state.targetY;
        state.springX.velocity = 0;
        state.springY.velocity = 0;
      } else {
        anyActive = true;
      }

      updated.set(clientId, {
        x: state.springX.position,
        y: state.springY.position,
        name: state.name,
        color: state.color,
      });
    }

    setRenderedCursors(updated);

    if (anyActive) {
      rafId.current = requestAnimationFrame(animate);
    } else {
      rafId.current = 0;
    }
  }, []);

  const startAnimation = useCallback(() => {
    if (rafId.current === 0) {
      lastFrameTime.current = performance.now();
      rafId.current = requestAnimationFrame(animate);
    }
  }, [animate]);

  useEffect(() => {
    const onChange = () => {
      const states = awareness.getStates();

      for (const [clientId, state] of states) {
        if (clientId === awareness.clientID) continue;
        const user = state.user as
          | { cursor?: { x: number; y: number } | null; name?: string; color?: string }
          | undefined;
        if (!user?.cursor) {
          animState.current.delete(clientId);
          continue;
        }

        const existing = animState.current.get(clientId);
        if (existing) {
          existing.targetX = user.cursor.x;
          existing.targetY = user.cursor.y;
          existing.name = user.name;
          existing.color = user.color;
          existing.lastSeen = performance.now();
        } else {
          animState.current.set(clientId, {
            targetX: user.cursor.x,
            targetY: user.cursor.y,
            springX: { position: user.cursor.x, velocity: 0 },
            springY: { position: user.cursor.y, velocity: 0 },
            name: user.name,
            color: user.color,
            lastSeen: performance.now(),
          });
        }
      }

      for (const clientId of animState.current.keys()) {
        if (!states.has(clientId)) {
          animState.current.delete(clientId);
        }
      }

      startAnimation();
    };

    awareness.on("change", onChange);
    onChange();

    return () => {
      awareness.off("change", onChange);
      if (rafId.current) {
        cancelAnimationFrame(rafId.current);
        rafId.current = 0;
      }
    };
  }, [awareness, startAnimation]);

  useEffect(() => {
    const pane = document.querySelector(".react-flow__pane") as HTMLElement | null;
    if (!pane) return;

    return trackPointer({
      awareness: awareness as Awareness,
      target: pane,
      getPosition: (event: PointerEvent) =>
        reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      throttleMs: 50,
    });
  }, [awareness, reactFlow]);

  const CursorComponent = components?.Cursor ?? DefaultCursor;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 5,
        overflow: "hidden",
      }}
    >
      {Array.from(renderedCursors).map(([clientId, cursor]) => {
        const screenX = cursor.x * viewport.zoom + viewport.x;
        const screenY = cursor.y * viewport.zoom + viewport.y;

        return (
          <CursorComponent
            key={clientId}
            clientId={clientId}
            x={screenX}
            y={screenY}
            name={cursor.name}
            color={cursor.color}
          />
        );
      })}
    </div>
  );
}
