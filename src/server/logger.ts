import { getLogger as getBaseLogger } from "@logtape/logtape";

// function augmentLogger(base: BaseLogger): Logger {
//   if ((base as unknown as { [AUGMENTED]?: boolean })[AUGMENTED]) {
//     return base as Logger;
//   }

//   const handler: ProxyHandler<BaseLogger> = {
//     get(target, prop, receiver) {
//       if (prop === AUGMENTED) {
//         return true;
//       }
//       if (prop === "child") {
//         return () => augmentLogger(target);
//       }
//       if (prop === "withContext" || prop === "withMetadata") {
//         return (ctx: Record<string, unknown>) =>
//           augmentLogger(target.with(ctx));
//       }
//       if (prop === "withError") {
//         return (error: Error) =>
//           augmentLogger(target.with({ error: toErrorDetails(error) }));
//       }
//       if (prop === "with") {
//         return (properties: Record<string, unknown>) =>
//           augmentLogger(target.with(properties));
//       }
//       if (prop === "getChild") {
//         return (
//           subcategory: Parameters<BaseLogger["getChild"]>[0],
//         ) => augmentLogger(target.getChild(subcategory));
//       }
//       const value = Reflect.get(target, prop, receiver);
//       if (typeof value === "function") {
//         return value.bind(target);
//       }
//       return value;
//     },
//     set(target, prop, value, receiver) {
//       if (prop === AUGMENTED) {
//         return true;
//       }
//       return Reflect.set(target, prop, value, receiver);
//     },
//   };

//   return new Proxy(base, handler) as Logger;
// }

/**
 * Default logger for the Teleportal server package.
 *
 * Per LogTape's library guidelines we avoid configuring sinks here.
 * Applications embedding Teleportal can configure LogTape globally and
 * control how this logger (and its children) emit records.
 */
export const logger = getBaseLogger(["teleportal", "server"]);
