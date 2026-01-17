// Simple cross-runtime Prometheus metrics implementation
export class Counter {
  private values = new Map<string, number>();

  constructor(
    private name: string,
    private help: string,
    private labelNames: string[] = [],
  ) {}

  inc(labels?: Record<string, string>): void {
    const key = labels ? JSON.stringify(labels) : "";
    const current = this.values.get(key) || 0;
    this.values.set(key, current + 1);
  }

  getValue(labels?: Record<string, string>): number {
    if (!labels) {
      // Return total across all label combinations
      return this.getTotalValue();
    }
    const key = JSON.stringify(labels);
    return this.values.get(key) || 0;
  }

  getTotalValue(): number {
    let total = 0;
    for (const value of this.values.values()) {
      total += value;
    }
    return total;
  }

  toString(): string {
    let output = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} counter\n`;

    if (this.values.size === 0) {
      output += `${this.name} 0\n`;
    } else {
      for (const [key, value] of this.values) {
        const labels = key ? JSON.parse(key) : {};
        const labelsStr =
          Object.keys(labels).length > 0
            ? `{${Object.entries(labels)
                .map(([k, v]) => `${k}="${v}"`)
                .join(",")}}`
            : "";
        output += `${this.name}${labelsStr} ${value}\n`;
      }
    }

    return output;
  }
}

export class Gauge {
  private values = new Map<string, number>();

  constructor(
    private name: string,
    private help: string,
    private labelNames: string[] = [],
  ) {}

  inc(labels?: Record<string, string>): void {
    const key = labels ? JSON.stringify(labels) : "";
    const current = this.values.get(key) || 0;
    this.values.set(key, current + 1);
  }

  dec(labels?: Record<string, string>): void {
    const key = labels ? JSON.stringify(labels) : "";
    const current = this.values.get(key) || 0;
    this.values.set(key, current - 1);
  }

  set(value: number, labels?: Record<string, string>): void {
    const key = labels ? JSON.stringify(labels) : "";
    this.values.set(key, value);
  }

  getValue(labels?: Record<string, string>): number {
    if (!labels) {
      // Return sum if no labels provided? Or just the value for empty labels?
      // For Gauge, usually getting a value without labels when it has labels is ambiguous.
      // But adhering to Counter implementation style:
      const key = "";
      return this.values.get(key) || 0;
    }
    const key = JSON.stringify(labels);
    return this.values.get(key) || 0;
  }

  getValues(): { labels: Record<string, string>; value: number }[] {
    const result: { labels: Record<string, string>; value: number }[] = [];
    for (const [key, value] of this.values) {
      result.push({
        labels: key ? JSON.parse(key) : {},
        value,
      });
    }
    return result;
  }

  toString(): string {
    let output = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} gauge\n`;

    if (this.values.size === 0) {
      output += `${this.name} 0\n`;
    } else {
      for (const [key, value] of this.values) {
        const labels = key ? JSON.parse(key) : {};
        const labelsStr =
          Object.keys(labels).length > 0
            ? `{${Object.entries(labels)
                .map(([k, v]) => `${k}="${v}"`)
                .join(",")}}`
            : "";
        output += `${this.name}${labelsStr} ${value}\n`;
      }
    }

    return output;
  }
}

export class Histogram {
  private series = new Map<
    string,
    {
      buckets: number[];
      sum: number;
      count: number;
    }
  >();

  constructor(
    private name: string,
    private help: string,
    private bucketValues: number[] = [
      0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
    ],
    private labelNames: string[] = [],
  ) {}

  observe(
    labelsOrValue: Record<string, string> | number,
    value?: number,
  ): void {
    let labels: Record<string, string>;
    let val: number;

    if (typeof labelsOrValue === "number") {
      labels = {};
      val = labelsOrValue;
    } else {
      labels = labelsOrValue;
      val = value!;
    }

    const key = JSON.stringify(labels);
    let series = this.series.get(key);

    if (!series) {
      series = {
        buckets: Array.from({ length: this.bucketValues.length + 1 }).fill(
          0,
        ) as number[],
        sum: 0,
        count: 0,
      };
      this.series.set(key, series);
    }

    series.count++;
    series.sum += val;

    for (let i = 0; i < this.bucketValues.length; i++) {
      if (val <= this.bucketValues[i]) {
        series.buckets[i]++;
      }
    }
    series.buckets[this.bucketValues.length]++; // +Inf bucket
  }

  toString(): string {
    let output = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} histogram\n`;

    if (this.series.size === 0) {
      // Output empty histogram
      for (let i = 0; i < this.bucketValues.length; i++) {
        output += `${this.name}_bucket{le="${this.bucketValues[i]}"} 0\n`;
      }
      output += `${this.name}_bucket{le="+Inf"} 0\n`;
      output += `${this.name}_count 0\n`;
      output += `${this.name}_sum 0\n`;
    } else {
      for (const [key, series] of this.series) {
        const labels = key ? JSON.parse(key) : {};
        const labelsStr =
          Object.keys(labels).length > 0
            ? `{${Object.entries(labels)
                .map(([k, v]) => `${k}="${v}"`)
                .join(",")}}`
            : "";

        for (let i = 0; i < this.bucketValues.length; i++) {
          output += `${this.name}_bucket${labelsStr}{le="${this.bucketValues[i]}"} ${series.buckets[i]}\n`;
        }
        output += `${this.name}_bucket${labelsStr}{le="+Inf"} ${series.buckets[this.bucketValues.length]}\n`;
        output += `${this.name}_count${labelsStr} ${series.count}\n`;
        output += `${this.name}_sum${labelsStr} ${series.sum}\n`;
      }
    }

    return output;
  }
}

// Simple registry to collect all metrics
export class Registry {
  private metrics: (Counter | Gauge | Histogram)[] = [];

  register(metric: Counter | Gauge | Histogram): void {
    this.metrics.push(metric);
  }

  format(): string {
    return this.metrics.map((m) => m.toString()).join("\n") + "\n";
  }
}

// Global registry instance
export const register = new Registry();
