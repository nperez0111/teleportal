import { describe, expect, test } from "bun:test";
import { Counter, Gauge, Histogram, Registry } from "./metrics";

describe("Counter", () => {
  test("increments value without labels", () => {
    const counter = new Counter("test_counter", "A test counter");
    expect(counter.getValue()).toBe(0);

    counter.inc();
    expect(counter.getValue()).toBe(1);

    counter.inc();
    expect(counter.getValue()).toBe(2);
  });

  test("increments value with labels", () => {
    const counter = new Counter("test_counter", "A test counter", ["method"]);
    counter.inc({ method: "GET" });
    counter.inc({ method: "POST" });
    counter.inc({ method: "GET" });

    expect(counter.getValue()).toBe(3);
  });

  test("formats correctly without labels", () => {
    const counter = new Counter("test_counter", "A test counter");
    counter.inc();

    const output = counter.toString();
    expect(output).toContain("# HELP test_counter A test counter");
    expect(output).toContain("# TYPE test_counter counter");
    expect(output).toContain("test_counter 1");
  });

  test("formats correctly with labels", () => {
    const counter = new Counter("test_counter", "A test counter", ["method"]);
    counter.inc({ method: "GET" });

    const output = counter.toString();
    expect(output).toContain('test_counter{method="GET"} 1');
  });
});

describe("Gauge", () => {
  test("increments and decrements", () => {
    const gauge = new Gauge("test_gauge", "A test gauge");
    expect(gauge.getValue()).toBe(0);

    gauge.inc();
    expect(gauge.getValue()).toBe(1);

    gauge.inc();
    expect(gauge.getValue()).toBe(2);

    gauge.dec();
    expect(gauge.getValue()).toBe(1);
  });

  test("sets value", () => {
    const gauge = new Gauge("test_gauge", "A test gauge");
    gauge.set(42);
    expect(gauge.getValue()).toBe(42);
  });

  test("formats correctly", () => {
    const gauge = new Gauge("test_gauge", "A test gauge");
    gauge.set(5);

    const output = gauge.toString();
    expect(output).toContain("# HELP test_gauge A test gauge");
    expect(output).toContain("# TYPE test_gauge gauge");
    expect(output).toContain("test_gauge 5");
  });
});

describe("Histogram", () => {
  test("observes values without labels", () => {
    const histogram = new Histogram(
      "test_histogram",
      "A test histogram",
      [1, 5, 10],
    );

    histogram.observe(0.5);
    histogram.observe(3);
    histogram.observe(7);
    histogram.observe(15);

    const output = histogram.toString();
    expect(output).toContain('test_histogram_bucket{le="1"} 1');
    expect(output).toContain('test_histogram_bucket{le="5"} 2');
    expect(output).toContain('test_histogram_bucket{le="10"} 3');
    expect(output).toContain('test_histogram_bucket{le="+Inf"} 4');
    expect(output).toContain("test_histogram_count 4");
    expect(output).toContain("test_histogram_sum 25.5");
  });

  test("observes values with labels", () => {
    const histogram = new Histogram(
      "test_histogram",
      "A test histogram",
      [1, 5],
      ["status"],
    );

    histogram.observe({ status: "success" }, 0.5);
    histogram.observe({ status: "success" }, 3);

    const output = histogram.toString();
    expect(output).toContain(
      'test_histogram_bucket{status="success"}{le="1"} 1',
    );
    expect(output).toContain(
      'test_histogram_bucket{status="success"}{le="5"} 2',
    );
  });

  test("formats correctly", () => {
    const histogram = new Histogram("test_histogram", "A test histogram");

    const output = histogram.toString();
    expect(output).toContain("# HELP test_histogram A test histogram");
    expect(output).toContain("# TYPE test_histogram histogram");
    expect(output).toContain("_bucket");
    expect(output).toContain("_count");
    expect(output).toContain("_sum");
  });
});

describe("Registry", () => {
  test("registers and formats metrics", () => {
    const registry = new Registry();
    const counter = new Counter("test_counter", "A counter");
    const gauge = new Gauge("test_gauge", "A gauge");

    counter.inc();
    gauge.set(42);

    registry.register(counter);
    registry.register(gauge);

    const output = registry.format();
    expect(output).toContain("test_counter 1");
    expect(output).toContain("test_gauge 42");
    expect(output.endsWith("\n")).toBe(true);
  });
});
