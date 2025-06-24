import { Suspense, useEffect, useState } from "react";
import { DocumentSwitcher } from "./document-switcher";
import { DocumentEditor } from "./editor-components";
import { useProviderManager } from "./utils/providers";
import { SubdocList, SubdocViewer } from "./subdoc-manager";
import { websocket } from "teleportal/providers";

export function Editor() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <Provider />
    </Suspense>
  );
}
function Provider() {
  const { provider, switchDocument, currentDocument } = useProviderManager();
  if (!provider) {
    return <div>Loading...</div>;
  }

  return (
    <EditorContent
      provider={provider}
      switchDocument={switchDocument}
      currentDocument={currentDocument}
    />
  );
}
function EditorContent({
  provider,
  switchDocument,
  currentDocument,
}: {
  provider: websocket.Provider;
  switchDocument: (documentName: string) => void;
  currentDocument: string;
}) {
  const [subdocs, setSubdocs] = useState<string[]>(() =>
    Array.from(provider.subdocs.keys()),
  );

  useEffect(() => {
    const handler = provider.on("load-subdoc", (subdoc) => {
      setSubdocs(Array.from(provider.subdocs.keys()));
    });
    return () => {
      provider.off("load-subdoc", handler);
    };
  }, [provider]);

  return (
    <div style={{ padding: "1rem" }}>
      <DocumentSwitcher
        currentDocument={currentDocument}
        onSwitchDocument={switchDocument}
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 300px",
          gap: "1rem",
        }}
      >
        <div>
          <DocumentEditor provider={provider} documentName={currentDocument} />
          <SubdocList provider={provider} subdocs={subdocs} />
        </div>

        <div>
          <SubdocViewer provider={provider} />
        </div>
      </div>
    </div>
  );
}
