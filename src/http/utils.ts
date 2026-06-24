import type { Message, ClientContext } from "teleportal";
import { fromMessageArrayStream } from "teleportal/transports";

/**
 * Default implementation that extracts document IDs from URL query parameters
 * Supports multiple 'documents' parameters: ?documents=id-1&documents=id-2
 * Also supports comma-separated values: ?documents=id-1,id-2
 *
 * End-to-end encryption is the default: every document is marked encrypted
 * unless it carries an explicit ":plaintext" (or ":unencrypted") opt-out
 * suffix, e.g. ?documents=id-1,id-2:plaintext,id-3
 * On conflict (the same id appears both ways) the encrypted entry wins.
 */
export function getDocumentsFromQueryParams(
  request: Request,
): { document: string; encrypted?: boolean }[] {
  const url = new URL(request.url);
  const documentParams = url.searchParams.getAll("documents");

  const documents: { document: string; encrypted?: boolean }[] = [];

  for (const param of documentParams) {
    // Handle both single IDs and comma-separated lists
    const ids = param
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    for (const id of ids) {
      // Documents are encrypted by default; an explicit ":plaintext" or
      // ":unencrypted" suffix opts a single document out.
      const plaintextSuffix = [":plaintext", ":unencrypted"].find((s) => id.endsWith(s));
      if (plaintextSuffix) {
        const documentName = id.slice(0, -plaintextSuffix.length);
        if (documentName.length > 0) {
          documents.push({ document: documentName, encrypted: false });
        }
      } else {
        documents.push({ document: id, encrypted: true });
      }
    }
  }

  // Remove duplicates based on document name (keep the one with encryption preference)
  const uniqueDocuments = new Map<string, { document: string; encrypted?: boolean }>();
  for (const doc of documents) {
    const existing = uniqueDocuments.get(doc.document);
    // If document already exists, prefer the encrypted version
    if (!existing || (doc.encrypted && !existing.encrypted)) {
      uniqueDocuments.set(doc.document, doc);
    }
  }

  return [...uniqueDocuments.values()];
}

/**
 * Decodes a {@link Response} containing a {@link ReadableStream} of {@link MessageArray}s
 * into a {@link ReadableStream} of {@link Message}s.
 */
export function decodeHTTPRequest(response: Response): ReadableStream<Message<ClientContext>> {
  return response.body!.pipeThrough(
    fromMessageArrayStream({
      clientId: response.headers.get("x-teleportal-client-id")!,
    }) as TransformStream<Uint8Array, Message<ClientContext>>,
  );
}
