/**
 * NSGA-II 遺傳算法引擎
 * 
 * 實作非支配排序遺傳算法 II (Non-dominated Sorting Genetic Algorithm II)
 * 用於交易策略多目標參數優化
 * 
 * 特性：
 * - 多目標優化（利潤、勝率、夏普比率、利潤因子、最大回撤）
 * - 非支配排序 + 擁擠度距離
 * - SBX 交叉 + 多項式變異
 * - 精英保留策略
 * - 差分進化 (DE) 精煉模組
 * - Walk-Forward 交叉驗證防過擬合
 */

import { backtestEngine, type BacktestRequest, type BacktestResult } from "./backtestEngine";
import type { PerformanceMetrics } from "./performanceCalculator";

// ============================================================
// 類型定義
// ============================================================

/** 參數空間定義（每個參數的範圍與步長） */
export interface ParameterSpace {
  name: string;
  min: number;
  max: number;
  step: number;
  /** 參數類型：continuous=連續, discrete=離散 */
  type: "continuous" | "discrete";
}

/** 個體（一組參數配置） */
export interface Individual {
  /** 基因（參數值） */
  genes: Record<string, number>;
  /** 目標函數值（多目標） */
  objectives: ObjectiveValues;
  /** 非支配排序等級（0=最優前沿） */
  rank: number;
  /** 擁擠度距離 */
  crowdingDistance: number;
  /** 回測績效指標 */
  metrics?: PerformanceMetrics;
  /** 所屬交易對 */
  symbol?: string;
}

/** 多目標函數值 */
export interface ObjectiveValues {
  totalReturn: number;      // 最大化
  winRate: number;          // 最大化
  sharpeRatio: number;      // 最大化
  profitFactor: number;     // 最大化
  maxDrawdown: number;      // 最小化（取絕對值）
}

/** 進化配置 */
export interface EvolutionConfig {
  /** 種群大小 */
  populationSize: number;
  /** 最大代數 */
  maxGenerations: number;
  /** 交叉概率 */
  crossoverRate: number;
  /** 變異概率 */
  mutationRate: number;
  /** SBX 分佈指數 */
  sbxEta: number;
  /** 多項式變異分佈指數 */
  mutationEta: number;
  /** 精英保留比例 */
  eliteRatio: number;
}

/** 掃描模式預設配置 */
export const SCAN_MODE_CONFIGS: Record<"fast" | "standard" | "deep", EvolutionConfig> = {
  fast: {
    populationSize: 12,
    maxGenerations: 5,
    crossoverRate: 0.9,
    mutationRate: 0.2,
    sbxEta: 20,
    mutationEta: 20,
    eliteRatio: 0.3,
  },
  standard: {
    populationSize: 16,
    maxGenerations: 8,
    crossoverRate: 0.9,
    mutationRate: 0.15,
    sbxEta: 15,
    mutationEta: 20,
    eliteRatio: 0.2,
  },
  deep: {
    populationSize: 24,
    maxGenerations: 15,
    crossoverRate: 0.85,
    mutationRate: 0.12,
    sbxEta: 10,
    mutationEta: 15,
    eliteRatio: 0.15,
  },
};

/** 進化進度回調 */
export interface EvolutionProgress {
  generation: number;
  maxGenerations: number;
  phase: "sensitivity" | "evolution" | "refinement" | "validation";
  phaseProgress: number;  // 0-100
  bestObjectives: ObjectiveValues;
  paretoFrontSize: number;
  evaluatedCount: number;
  totalEvaluations: number;
}

/** 進化結果 */
export interface EvolutionResult {
  /** Pareto 前沿個體 */
  paretoFront: Individual[];
  /** 綜合評分最高的個體 */
  bestIndividual: Individual;
  /** 所有代的最佳適應度歷史 */
  fitnessHistory: Array<{ generation: number; bestScore: number; avgScore: number; paretoSize: number }>;
  /** 參數重要性排名 */
  parameterImportance: Array<{ name: string; importance: number; bestValue: number }>;
  /** Walk-Forward 驗證結果 */
  walkForwardResult?: WalkForwardResult;
  /** 總評估次數 */
  totalEvaluations: number;
  /** 執行時間 (ms) */
  executionTimeMs: number;
}

/** Walk-Forward 驗證結果 */
export interface WalkForwardResult {
  /** 訓練期績效 */
  inSampleMetrics: PerformanceMetrics;
  /** 驗證期績效 */
  outOfSampleMetrics: PerformanceMetrics;
  /** 穩健性評分 (0-100) */
  robustnessScore: number;
  /** 過擬合指數 (0=無過擬合, 100=嚴重過擬合) */
  overfitIndex: number;
  /** 訓練/驗證期時間分割 */
  splitRatio: number;
}

// ============================================================
// NSGA-II 核心算法
// ============================================================

export class NSGAII {
  private paramSpace: ParameterSpace[];
  private config: EvolutionConfig;
  private progressCallback?: (progress: EvolutionProgress) => void;
  private aborted = false;

  constructor(
    paramSpace: ParameterSpace[],
    config: EvolutionConfig,
    progressCallback?: (progress: EvolutionProgress) => void,
  ) {
    this.paramSpace = paramSpace;
    this.config = config;
    this.progressCallback = progressCallback;
  }

  /** 中止進化 */
  abort(): void {
    this.aborted = true;
  }

  // ============================================================
  // 種群初始化
  // ============================================================

  /** 生成初始種群（拉丁超立方抽樣 + 隨機） */
  initializePopulation(): Individual[] {
    const pop: Individual[] = [];
    const n = this.config.populationSize;

    // 使用拉丁超立方抽樣確保初始覆蓋均勻
    for (let i = 0; i < n; i++) {
      const genes: Record<string, number> = {};
      for (const param of this.paramSpace) {
        // 拉丁超立方：將每個維度分成 n 等份，每份取一個隨機點
        const segment = (param.max - param.min) / n;
        const rawValue = param.min + segment * i + Math.random() * segment;
        genes[param.name] = this.snapToGrid(rawValue, param);
      }
      pop.push(this.createIndividual(genes));
    }

    // 打亂順序避免系統性偏差
    for (let i = pop.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pop[i], pop[j]] = [pop[j], pop[i]];
    }

    return pop;
  }

  // ============================================================
  // 非支配排序
  // ============================================================

  /** 快速非支配排序 */
  nonDominatedSort(population: Individual[]): Individual[][] {
    const n = population.length;
    const dominationCount = new Array(n).fill(0);
    const dominatedSet: number[][] = Array.from({ length: n }, () => []);
    const fronts: Individual[][] = [];

    // 計算支配關係
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dom = this.dominates(population[i], population[j]);
        if (dom === 1) {
          // i 支配 j
          dominatedSet[i].push(j);
          dominationCount[j]++;
        } else if (dom === -1) {
          // j 支配 i
          dominatedSet[j].push(i);
          dominationCount[i]++;
        }
      }
    }

    // 構建前沿
    let currentFront: number[] = [];
    for (let i = 0; i < n; i++) {
      if (dominationCount[i] === 0) {
        population[i].rank = 0;
        currentFront.push(i);
      }
    }

    let rank = 0;
    while (currentFront.length > 0) {
      fronts.push(currentFront.map((i) => population[i]));
      const nextFront: number[] = [];
      for (const i of currentFront) {
        for (const j of dominatedSet[i]) {
          dominationCount[j]--;
          if (dominationCount[j] === 0) {
            population[j].rank = rank + 1;
            nextFront.push(j);
          }
        }
      }
      currentFront = nextFront;
      rank++;
    }

    return fronts;
  }

  /** 判斷 a 是否支配 b：1=a支配b, -1=b支配a, 0=互不支配 */
  private dominates(a: Individual, b: Individual): number {
    let aBetter = false;
    let bBetter = false;

    // 最大化目標
    const maxObjectives: (keyof ObjectiveValues)[] = ["totalReturn", "winRate", "sharpeRatio", "profitFactor"];
    for (const obj of maxObjectives) {
      if (a.objectives[obj] > b.objectives[obj]) aBetter = true;
      else if (a.objectives[obj] < b.objectives[obj]) bBetter = true;
    }

    // 最小化目標（maxDrawdown）
    if (a.objectives.maxDrawdown < b.objectives.maxDrawdown) aBetter = true;
    else if (a.objectives.maxDrawdown > b.objectives.maxDrawdown) bBetter = true;

    if (aBetter && !bBetter) return 1;
    if (bBetter && !aBetter) return -1;
    return 0;
  }

  // ============================================================
  // 擁擠度距離
  // ============================================================

  /** 計算擁擠度距離 */
  calculateCrowdingDistance(front: Individual[]): void {
    const n = front.length;
    if (n <= 2) {
      front.forEach((ind) => (ind.crowdingDistance = Infinity));
      return;
    }

    front.forEach((ind) => (ind.crowdingDistance = 0));

    const objectives: (keyof ObjectiveValues)[] = [
      "totalReturn", "winRate", "sharpeRatio", "profitFactor", "maxDrawdown",
    ];

    for (const obj of objectives) {
      // 按目標值排序
      const sorted = [...front].sort((a, b) => a.objectives[obj] - b.objectives[obj]);
      const range = sorted[n - 1].objectives[obj] - sorted[0].objectives[obj];
      if (range === 0) continue;

      // 邊界個體設為無窮大
      sorted[0].crowdingDistance = Infinity;
      sorted[n - 1].crowdingDistance = Infinity;

      // 中間個體計算距離
      for (let i = 1; i < n - 1; i++) {
        sorted[i].crowdingDistance +=
          (sorted[i + 1].objectives[obj] - sorted[i - 1].objectives[obj]) / range;
      }
    }
  }

  // ============================================================
  // 遺傳操作
  // ============================================================

  /** 錦標賽選擇 */
  tournamentSelect(population: Individual[]): Individual {
    const size = Math.min(3, population.length);
    let best: Individual | null = null;

    for (let i = 0; i < size; i++) {
      const idx = Math.floor(Math.random() * population.length);
      const candidate = population[idx];
      if (!best || this.crowdedCompare(candidate, best) < 0) {
        best = candidate;
      }
    }

    return best!;
  }

  /** 擁擠度比較：rank 小優先，同 rank 則擁擠度大優先 */
  private crowdedCompare(a: Individual, b: Individual): number {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return b.crowdingDistance - a.crowdingDistance; // 擁擠度大的更好
  }

  /** SBX 交叉（模擬二進制交叉） */
  crossover(parent1: Individual, parent2: Individual): [Individual, Individual] {
    if (Math.random() > this.config.crossoverRate) {
      return [this.cloneIndividual(parent1), this.cloneIndividual(parent2)];
    }

    const child1Genes: Record<string, number> = {};
    const child2Genes: Record<string, number> = {};

    for (const param of this.paramSpace) {
      const p1 = parent1.genes[param.name];
      const p2 = parent2.genes[param.name];

      if (Math.abs(p1 - p2) < 1e-10) {
        child1Genes[param.name] = p1;
        child2Genes[param.name] = p2;
        continue;
      }

      const u = Math.random();
      let beta: number;
      if (u <= 0.5) {
        beta = Math.pow(2 * u, 1 / (this.config.sbxEta + 1));
      } else {
        beta = Math.pow(1 / (2 * (1 - u)), 1 / (this.config.sbxEta + 1));
      }

      const c1 = 0.5 * ((1 + beta) * p1 + (1 - beta) * p2);
      const c2 = 0.5 * ((1 - beta) * p1 + (1 + beta) * p2);

      child1Genes[param.name] = this.snapToGrid(
        Math.max(param.min, Math.min(param.max, c1)),
        param,
      );
      child2Genes[param.name] = this.snapToGrid(
        Math.max(param.min, Math.min(param.max, c2)),
        param,
      );
    }

    return [this.createIndividual(child1Genes), this.createIndividual(child2Genes)];
  }

  /** 多項式變異 */
  mutate(individual: Individual): Individual {
    const genes = { ...individual.genes };

    for (const param of this.paramSpace) {
      if (Math.random() > this.config.mutationRate) continue;

      const val = genes[param.name];
      const delta = param.max - param.min;
      const u = Math.random();

      let perturbation: number;
      if (u < 0.5) {
        const xy = 1 - 2 * u;
        perturbation = Math.pow(xy, 1 / (this.config.mutationEta + 1)) - 1;
      } else {
        const xy = 2 * (u - 0.5);
        perturbation = 1 - Math.pow(xy, 1 / (this.config.mutationEta + 1));
      }

      const newVal = val + perturbation * delta * 0.5;
      genes[param.name] = this.snapToGrid(
        Math.max(param.min, Math.min(param.max, newVal)),
        param,
      );
    }

    return this.createIndividual(genes);
  }

  // ============================================================
  // 差分進化精煉
  // ============================================================

  /** DE/rand/1/bin 精煉（在 Pareto 前沿附近做局部搜索） */
  differentialEvolutionRefine(
    paretoFront: Individual[],
    iterations: number = 20,
  ): Individual[] {
    if (paretoFront.length < 4) return paretoFront;

    const refined = [...paretoFront];
    const F = 0.8;  // 縮放因子
    const CR = 0.9; // 交叉概率

    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < refined.length; i++) {
        // 隨機選 3 個不同個體
        const candidates = refined.filter((_, idx) => idx !== i);
        if (candidates.length < 3) continue;

        const shuffled = [...candidates].sort(() => Math.random() - 0.5);
        const [r1, r2, r3] = shuffled.slice(0, 3);

        // 變異向量
        const trial: Record<string, number> = {};
        const jRand = Math.floor(Math.random() * this.paramSpace.length);

        for (let j = 0; j < this.paramSpace.length; j++) {
          const param = this.paramSpace[j];
          if (Math.random() < CR || j === jRand) {
            const mutant = r1.genes[param.name] + F * (r2.genes[param.name] - r3.genes[param.name]);
            trial[param.name] = this.snapToGrid(
              Math.max(param.min, Math.min(param.max, mutant)),
              param,
            );
          } else {
            trial[param.name] = refined[i].genes[param.name];
          }
        }

        refined.push(this.createIndividual(trial));
      }
    }

    return refined;
  }

  // ============================================================
  // 工具方法
  // ============================================================

  /** 將值對齊到參數網格 */
  private snapToGrid(value: number, param: ParameterSpace): number {
    if (param.step <= 0) return value;
    const steps = Math.round((value - param.min) / param.step);
    const snapped = param.min + steps * param.step;
    return Math.max(param.min, Math.min(param.max, Math.round(snapped * 1e8) / 1e8));
  }

  /** 創建個體 */
  private createIndividual(genes: Record<string, number>): Individual {
    return {
      genes,
      objectives: { totalReturn: 0, winRate: 0, sharpeRatio: 0, profitFactor: 0, maxDrawdown: 100 },
      rank: Infinity,
      crowdingDistance: 0,
    };
  }

  /** 克隆個體 */
  private cloneIndividual(ind: Individual): Individual {
    return {
      genes: { ...ind.genes },
      objectives: { ...ind.objectives },
      rank: ind.rank,
      crowdingDistance: ind.crowdingDistance,
      metrics: ind.metrics,
      symbol: ind.symbol,
    };
  }

  /** 計算參數重要性（基於 Pareto 前沿的方差分析） */
  calculateParameterImportance(
    allEvaluated: Individual[],
  ): Array<{ name: string; importance: number; bestValue: number }> {
    if (allEvaluated.length < 10) {
      return this.paramSpace.map((p) => ({ name: p.name, importance: 0, bestValue: p.min }));
    }

    const importance: Array<{ name: string; importance: number; bestValue: number }> = [];

    // 計算綜合評分
    const scores = allEvaluated.map((ind) => this.compositeScore(ind.objectives));
    const meanScore = scores.reduce((a: number, b: number) => a + b, 0) / scores.length;
    const totalVariance = scores.reduce((sum: number, s: number) => sum + (s - meanScore) ** 2, 0);

    for (const param of this.paramSpace) {
      // 按參數值分組
      const groups = new Map<number, number[]>();
      for (let i = 0; i < allEvaluated.length; i++) {
        const val = allEvaluated[i].genes[param.name];
        const rounded = Math.round(val * 100) / 100;
        if (!groups.has(rounded)) groups.set(rounded, []);
        groups.get(rounded)!.push(scores[i]);
      }

      // 計算組間方差（fANOVA 簡化版）
      let betweenGroupVariance = 0;
      for (const [, groupScores] of Array.from(groups.entries())) {
        if (groupScores.length < 2) continue;
        const groupMean = groupScores.reduce((a, b) => a + b, 0) / groupScores.length;
        betweenGroupVariance += groupScores.length * (groupMean - meanScore) ** 2;
      }

      const imp = totalVariance > 0 ? betweenGroupVariance / totalVariance : 0;

      // 找最佳值
      let bestVal = param.min;
      let bestScore = -Infinity;
      for (const [val, groupScores] of Array.from(groups.entries())) {
        const avg = groupScores.reduce((a: number, b: number) => a + b, 0) / groupScores.length;
        if (avg > bestScore) {
          bestScore = avg;
          bestVal = val;
        }
      }

      importance.push({ name: param.name, importance: Math.min(1, imp), bestValue: bestVal });
    }

    return importance.sort((a, b) => b.importance - a.importance);
  }

  /** 計算綜合評分（用於排序和比較） */
  compositeScore(obj: ObjectiveValues): number {
    const returnScore = Math.max(0, Math.min(1, (obj.totalReturn + 50) / 150));
    const winRateScore = Math.max(0, Math.min(1, obj.winRate / 100));
    const sharpeScore = Math.max(0, Math.min(1, (obj.sharpeRatio + 1) / 4));
    const pfScore = Math.max(0, Math.min(1, (obj.profitFactor - 0.5) / 3));
    const ddScore = Math.max(0, Math.min(1, 1 - obj.maxDrawdown / 50));

    return (
      0.35 * returnScore +
      0.25 * winRateScore +
      0.20 * sharpeScore +
      0.10 * pfScore +
      0.10 * ddScore
    );
  }

  /** 報告進度 */
  reportProgress(progress: EvolutionProgress): void {
    if (this.progressCallback) {
      this.progressCallback(progress);
    }
  }

  /** 檢查是否已中止 */
  isAborted(): boolean {
    return this.aborted;
  }

  /** 獲取參數空間 */
  getParamSpace(): ParameterSpace[] {
    return this.paramSpace;
  }

  /** 獲取配置 */
  getConfig(): EvolutionConfig {
    return this.config;
  }
}

// ============================================================
// Walk-Forward 驗證
// ============================================================

export function calculateWalkForwardSplit(
  startDate: number,
  endDate: number,
  splitRatio: number = 0.7,
): { trainStart: number; trainEnd: number; testStart: number; testEnd: number } {
  const totalDuration = endDate - startDate;
  const trainDuration = Math.floor(totalDuration * splitRatio);

  return {
    trainStart: startDate,
    trainEnd: startDate + trainDuration,
    testStart: startDate + trainDuration,
    testEnd: endDate,
  };
}

/** 計算穩健性評分 */
export function calculateRobustnessScore(
  inSample: PerformanceMetrics,
  outOfSample: PerformanceMetrics,
): { robustnessScore: number; overfitIndex: number } {
  // 比較訓練期和驗證期的績效差異
  const returnDegradation = inSample.totalReturn > 0
    ? Math.max(0, 1 - outOfSample.totalReturn / inSample.totalReturn)
    : 0;

  const winRateDegradation = inSample.winRate > 0
    ? Math.max(0, 1 - outOfSample.winRate / inSample.winRate)
    : 0;

  const sharpeDegradation = inSample.sharpeRatio > 0
    ? Math.max(0, 1 - outOfSample.sharpeRatio / inSample.sharpeRatio)
    : 0;

  // 過擬合指數：績效退化越大越過擬合
  const overfitIndex = Math.min(100, Math.round(
    (returnDegradation * 0.5 + winRateDegradation * 0.25 + sharpeDegradation * 0.25) * 100,
  ));

  // 穩健性評分：100 - 過擬合指數
  const robustnessScore = Math.max(0, 100 - overfitIndex);

  return { robustnessScore, overfitIndex };
}
