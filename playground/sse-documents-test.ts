// Test demonstrating SSE endpoint with document subscription via URL query parameters
import { EventSource } from "eventsource";

const url = "http://localhost:3000";

// Example 1: Subscribe to a single document
console.log("=== Example 1: Single document subscription ===");
const singleDocUrl = `${url}/sse?documents=doc-1`;
console.log(`Connecting to: ${singleDocUrl}`);

const eventSource1 = new EventSource(singleDocUrl);
eventSource1.onmessage = (event) => {
  console.log("Single doc received:", event.data);
};
eventSource1.onerror = (error) => {
  console.error("Single doc error:", error);
};

// Example 2: Subscribe to multiple documents using multiple parameters
console.log("\n=== Example 2: Multiple documents (multiple parameters) ===");
const multiDocUrl = `${url}/sse?documents=doc-1&documents=doc-2&documents=doc-3`;
console.log(`Connecting to: ${multiDocUrl}`);

const eventSource2 = new EventSource(multiDocUrl);
eventSource2.onmessage = (event) => {
  console.log("Multi doc received:", event.data);
};
eventSource2.onerror = (error) => {
  console.error("Multi doc error:", error);
};

// Example 3: Subscribe to multiple documents using comma-separated values
console.log("\n=== Example 3: Multiple documents (comma-separated) ===");
const commaDocUrl = `${url}/sse?documents=doc-4,doc-5,doc-6`;
console.log(`Connecting to: ${commaDocUrl}`);

const eventSource3 = new EventSource(commaDocUrl);
eventSource3.onmessage = (event) => {
  console.log("Comma-separated docs received:", event.data);
};
eventSource3.onerror = (error) => {
  console.error("Comma-separated docs error:", error);
};

// Example 4: Mixed format (both multiple parameters and comma-separated)
console.log("\n=== Example 4: Mixed format ===");
const mixedDocUrl = `${url}/sse?documents=doc-7,doc-8&documents=doc-9&documents=doc-10,doc-11`;
console.log(`Connecting to: ${mixedDocUrl}`);

const eventSource4 = new EventSource(mixedDocUrl);
eventSource4.onmessage = (event) => {
  console.log("Mixed format docs received:", event.data);
};
eventSource4.onerror = (error) => {
  console.error("Mixed format docs error:", error);
};

// Example 5: No documents parameter (should work with no subscriptions)
console.log("\n=== Example 5: No document subscriptions ===");
const noDocUrl = `${url}/sse`;
console.log(`Connecting to: ${noDocUrl}`);

const eventSource5 = new EventSource(noDocUrl);
eventSource5.onmessage = (event) => {
  console.log("No docs received:", event.data);
};
eventSource5.onerror = (error) => {
  console.error("No docs error:", error);
};

// Example 6: Documents with special characters (URL encoded)
console.log("\n=== Example 6: Documents with special characters ===");
const specialDocUrl = `${url}/sse?documents=${encodeURIComponent("doc-with-spaces and symbols!")}&documents=${encodeURIComponent("doc/with/slashes")}`;
console.log(`Connecting to: ${specialDocUrl}`);

const eventSource6 = new EventSource(specialDocUrl);
eventSource6.onmessage = (event) => {
  console.log("Special chars docs received:", event.data);
};
eventSource6.onerror = (error) => {
  console.error("Special chars docs error:", error);
};

// Clean up after 30 seconds
setTimeout(() => {
  console.log("\n=== Cleaning up connections ===");
  eventSource1.close();
  eventSource2.close();
  eventSource3.close();
  eventSource4.close();
  eventSource5.close();
  eventSource6.close();
  console.log("All connections closed");
}, 30000);

console.log("\nTest will run for 30 seconds...");