export class UnsupportedCapabilityError extends Error {
  readonly capability: string;

  constructor(capability: string, detail: string) {
    super(`${capability}: ${detail}`);
    this.name = "UnsupportedCapabilityError";
    this.capability = capability;
  }
}

export class StaleDataError extends Error {
  constructor(component: string, lastMessageAgeMs: number) {
    super(`${component}: stale data, last message ${lastMessageAgeMs}ms ago`);
    this.name = "StaleDataError";
  }
}
