export interface KamaParameters {
  erPeriod: number;
  fastEma: number;
  slowEma: number;
}

export type KamaValue = number | null;

function assertKamaParameters(parameters: KamaParameters): void {
  if (!Number.isInteger(parameters.erPeriod) || parameters.erPeriod < 2 || parameters.erPeriod > 500) {
    throw new RangeError("erPeriod must be an integer between 2 and 500");
  }
  if (!Number.isInteger(parameters.fastEma) || parameters.fastEma < 1 || parameters.fastEma > 500) {
    throw new RangeError("fastEma must be an integer between 1 and 500");
  }
  if (!Number.isInteger(parameters.slowEma) || parameters.slowEma < 1 || parameters.slowEma > 500) {
    throw new RangeError("slowEma must be an integer between 1 and 500");
  }
  if (parameters.fastEma > parameters.slowEma) {
    throw new RangeError("fastEma must not be greater than slowEma");
  }
}

function assertFiniteClose(close: number): void {
  if (!Number.isFinite(close)) throw new TypeError("KAMA close must be finite");
}

export class KamaAccumulator {
  private readonly parameters: KamaParameters;
  private readonly closes: number[] = [];
  private currentKama: number | null = null;

  constructor(parameters: KamaParameters) {
    assertKamaParameters(parameters);
    this.parameters = { ...parameters };
  }

  add(close: number): KamaValue {
    assertFiniteClose(close);
    this.closes.push(close);

    if (this.currentKama === null) {
      if (this.closes.length < this.parameters.erPeriod) return null;
      const seed = this.closes.reduce((sum, value) => sum + value, 0) / this.closes.length;
      this.currentKama = seed;
      return seed;
    }

    while (this.closes.length > this.parameters.erPeriod + 1) this.closes.shift();
    const change = Math.abs(this.closes[this.closes.length - 1] - this.closes[0]);
    let volatility = 0;
    for (let index = 1; index < this.closes.length; index += 1) {
      volatility += Math.abs(this.closes[index] - this.closes[index - 1]);
    }

    const efficiencyRatio = volatility === 0 ? 0 : change / volatility;
    const fastConstant = 2 / (this.parameters.fastEma + 1);
    const slowConstant = 2 / (this.parameters.slowEma + 1);
    const smoothingConstant = (efficiencyRatio * (fastConstant - slowConstant) + slowConstant) ** 2;
    this.currentKama += smoothingConstant * (close - this.currentKama);
    return this.currentKama;
  }

  get value(): KamaValue {
    return this.currentKama;
  }

  reset(): void {
    this.closes.length = 0;
    this.currentKama = null;
  }
}

export function calculateKamaSeries(closes: readonly number[], parameters: KamaParameters): KamaValue[] {
  const accumulator = new KamaAccumulator(parameters);
  return closes.map(close => accumulator.add(close));
}

export function latestReadyKamaPair(series: readonly KamaValue[]): { previous: number; current: number } | null {
  const ready = series.filter((value): value is number => value !== null);
  if (ready.length < 2) return null;
  return { previous: ready[ready.length - 2], current: ready[ready.length - 1] };
}
