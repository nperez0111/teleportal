import { BinaryMessage, ServerContext, Sink, Source } from "teleportal";
import { getMessageReader } from "../utils";

/**
 * Transport which receives a single binary message from an HTTP request
 * It is single use, and will close the writer when the request is complete
 */
export function getHTTPSource<Context extends ServerContext>({
  context,
}: {
  context: Context;
}): Source<
  Context,
  {
    handleHTTPRequest: (request: Request) => Promise<void>;
  }
> {
  const reader = getMessageReader(context);
  const writer = reader.writable.getWriter();
  return {
    readable: reader.readable,
    handleHTTPRequest: async (request) => {
      const buffer = await request.arrayBuffer();
      await writer.write(new Uint8Array(buffer) as BinaryMessage);
      await writer.close();
      return;
    },
  };
}

/**
 * Transport which sends a single binary message as an HTTP request
 */
export function getHTTPSink({
  request,
}: {
  request: (ctx: {
    requestOptions: Pick<RequestInit, "method" | "headers" | "cache" | "body">;
  }) => Promise<void>;
}): Sink<any> {
  return {
    writable: new WritableStream({
      async write(chunk) {
        await request({
          requestOptions: {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "X-Teleportal-Message-Id": chunk.id,
              "x-powered-by": "teleportal",
            },
            cache: "no-store",
            body: chunk.encoded,
          },
        });
      },
    }),
  };
}
