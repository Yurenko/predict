import { describe, expect, it } from "vitest";
import { orderIntentLabel, orderNotionalUsd, signalIntentLabel } from "./intent-label";

describe("signalIntentLabel", () => {
  it("maps BUY to UP and SELL to buying DOWN", () => {
    expect(signalIntentLabel({ direction: "BUY" })).toBe("BUY UP");
    expect(signalIntentLabel({ direction: "SELL" })).toBe("BUY DOWN");
  });

  it("names EXIT from the token being closed", () => {
    expect(signalIntentLabel({ direction: "EXIT", outcomeName: "Up" })).toBe("EXIT BUY");
    expect(signalIntentLabel({ direction: "EXIT", outcomeName: "Down" })).toBe("EXIT SELL");
    expect(signalIntentLabel({ direction: "EXIT", outcomeName: "No" })).toBe("EXIT SELL");
    expect(signalIntentLabel({ direction: "EXIT" })).toBe("EXIT");
  });
});

describe("orderIntentLabel", () => {
  it("maps an open BUY to BUY UP / BUY DOWN", () => {
    expect(orderIntentLabel({ side: "BUY", outcomeName: "Up" })).toBe("BUY UP");
    expect(orderIntentLabel({ side: "BUY", outcomeName: "Down" })).toBe("BUY DOWN");
  });

  it("maps every SELL to EXIT BUY/SELL even after reconcile drops intent", () => {
    expect(orderIntentLabel({ side: "SELL", outcomeName: "Up" })).toBe("EXIT BUY");
    expect(orderIntentLabel({ side: "SELL", outcomeName: "Down" })).toBe("EXIT SELL");
    expect(orderIntentLabel({ side: "SELL", outcomeName: "Up", action: "EXIT" })).toBe("EXIT BUY");
    expect(orderIntentLabel({ side: "SELL", outcomeName: "Down", intent: "EXIT SELL" })).toBe(
      "EXIT SELL",
    );
  });
});

describe("orderNotionalUsd", () => {
  it("shows the requested flatten while a LIMIT EXIT is still SUBMITTED", () => {
    expect(
      orderNotionalUsd({ status: "SUBMITTED", filledUsdtAmount: 0, requestedAmount: 2 }),
    ).toBe(2);
  });

  it("shows the actual fill after FILLED", () => {
    expect(
      orderNotionalUsd({ status: "FILLED", filledUsdtAmount: 0.52, requestedAmount: 2 }),
    ).toBe(0.52);
  });
});
