interface BatchOptions {
  maxSize?: number;
  wait?: number;
}

export function batch<T>(
  fn: (items: T[]) => void,
  options: BatchOptions = {},
): (item: T) => void {
  const maxSize = options.maxSize ?? Infinity;
  const wait = options.wait ?? Infinity;
  const items: T[] = [];
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const execute = () => {
    if (items.length === 0) return;
    const batch = [...items];
    items.length = 0;
    timeoutId = null;
    fn(batch);
  };

  const trigger = () => {
    if (items.length >= maxSize) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      execute();
    } else if (wait !== Infinity && !timeoutId) {
      timeoutId = setTimeout(execute, wait);
    }
  };

  return (item: T) => {
    items.push(item);
    trigger();
  };
}
