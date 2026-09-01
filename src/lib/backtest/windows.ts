export interface WalkForwardWindow {
  trainFrom: Date;
  trainTo: Date;
  testFrom: Date;
  testTo: Date;
}

const DAY_MS = 86_400_000;

export function walkForwardWindows(options: {
  from: Date;
  to: Date;
  trainDays: number;
  testDays: number;
  stepDays: number;
}): WalkForwardWindow[] {
  const windows: WalkForwardWindow[] = [];
  const end = options.to.getTime();
  let testStart = options.from.getTime() + options.trainDays * DAY_MS;

  while (testStart < end) {
    const testEnd = Math.min(testStart + options.testDays * DAY_MS, end);
    const trainTo = testStart;
    const trainFrom = trainTo - options.trainDays * DAY_MS;
    if (testEnd > testStart) {
      windows.push({
        trainFrom: new Date(trainFrom),
        trainTo: new Date(trainTo),
        testFrom: new Date(testStart),
        testTo: new Date(testEnd),
      });
    }
    testStart += options.stepDays * DAY_MS;
  }

  return windows;
}

export function historyStart(options: {
  trainFrom: Date | null;
  testFrom: Date;
  lookbackMinutes: number;
}): Date {
  const lookback = new Date(options.testFrom.getTime() - options.lookbackMinutes * 60_000);
  if (!options.trainFrom) return lookback;
  return options.trainFrom.getTime() < lookback.getTime() ? options.trainFrom : lookback;
}
