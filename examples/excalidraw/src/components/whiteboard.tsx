import { useEffect, useRef, useState } from "react";

import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { Provider } from "teleportal/providers";
import { ExcalidrawBinding, yjsToExcalidraw } from "y-excalidraw";
import * as Y from "yjs";

import "@excalidraw/excalidraw/index.css";

interface WhiteboardProps {
  provider: Provider;
}

export function Whiteboard({ provider }: WhiteboardProps) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [binding, setBindings] = useState<ExcalidrawBinding | null>(null);
  const excalidrawRef = useRef<HTMLDivElement>(null);
  const yElements = provider.doc.getArray<Y.Map<any>>("elements");
  const yAssets = provider.doc.getMap("assets");

  useEffect(() => {
    if (!api || !excalidrawRef.current) return;

    let binding: ExcalidrawBinding | null = null;

    binding = new ExcalidrawBinding(
      yElements,
      yAssets,
      api,
      provider.awareness,
      {
        excalidrawDom: excalidrawRef.current,
        undoManager: new Y.UndoManager(yElements),
      },
    );
    setBindings(binding);

    return () => {
      setBindings(null);
      binding?.destroy();
    };
  }, [api, provider.awareness, yElements, yAssets]);

  return (
    <div style={{ width: "100vw", height: "100vh" }} ref={excalidrawRef}>
      <Excalidraw
        initialData={{
          elements: yjsToExcalidraw(yElements),
        }}
        excalidrawAPI={setApi}
        onPointerUpdate={binding?.onPointerUpdate}
      />
    </div>
  );
}
