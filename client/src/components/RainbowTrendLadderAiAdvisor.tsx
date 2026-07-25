import { useState } from "react";
import { BrainCircuit, CheckCircle2, Loader2, ShieldCheck, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import type { RainbowTrendLadderConfig } from "@shared/strategies/rainbowTrendLadder";

interface RainbowTrendLadderAiAdvisorProps {
  config: RainbowTrendLadderConfig;
  onApply: (config: RainbowTrendLadderConfig) => void;
  disabled?: boolean;
}

interface RainbowTrendLadderAiProposalResult {
  model: string;
  summary: string;
  rationale: string[];
  riskWarnings: string[];
  safetyEnforced: string[];
  changedFields: Array<{ path: string; before: string; after: string }>;
  proposedConfig: RainbowTrendLadderConfig;
}

export function RainbowTrendLadderAiAdvisor({ config, onApply, disabled }: RainbowTrendLadderAiAdvisorProps) {
  const [objective, setObjective] = useState("");
  const [result, setResult] = useState<RainbowTrendLadderAiProposalResult | null>(null);
  const mutation = trpc.rainbowTrendLadderAi.proposeConfig.useMutation({
    onSuccess: (data) => setResult(data),
    onError: (error) => toast.error(error.message),
  });

  const generate = () => {
    if (objective.trim().length < 10) {
      toast.error("請至少輸入 10 個字的優化目標");
      return;
    }
    setResult(null);
    mutation.mutate({ objective: objective.trim(), currentConfig: config });
  };

  return (
    <div className="space-y-4 rounded-xl border border-cyan-500/20 bg-[#050b11]/80 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-3">
          <div className="rounded-lg border border-cyan-400/20 bg-cyan-400/10 p-2 text-cyan-200"><BrainCircuit className="h-5 w-5" /></div>
          <div>
            <h4 className="text-sm font-black text-slate-100">AI 風險優先參數顧問</h4>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">只產生此新策略的表單提案，不會儲存、啟用、送單、解除 KILL 或讀寫 20415。服務端會再次套用 V1 驗證與風險上限。</p>
          </div>
        </div>
        <Badge variant="outline" className="w-fit border-emerald-500/30 bg-emerald-500/5 text-emerald-200">提案固定未武裝</Badge>
      </div>

      <Textarea
        value={objective}
        onChange={(event) => setObjective(event.target.value)}
        disabled={disabled || mutation.isPending}
        maxLength={2_000}
        placeholder="例如：在不增加總手數、不縮短加倉距離的前提下，降低震盪市連續加倉與回撤；請列出需要回測驗證的假設。"
        className="min-h-24 border-slate-700 bg-slate-950/70 text-sm text-slate-100 placeholder:text-slate-600"
      />
      <Button type="button" onClick={generate} disabled={disabled || mutation.isPending} className="bg-cyan-400 text-slate-950 hover:bg-cyan-300">
        {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
        生成安全研究提案
      </Button>

      {result ? (
        <div className="space-y-4 border-t border-slate-800 pt-4">
          <div>
            <div className="flex flex-wrap items-center gap-2"><h5 className="text-sm font-bold text-slate-100">提案摘要</h5><Badge variant="secondary" className="font-mono text-[10px]">{result.model}</Badge></div>
            <p className="mt-2 text-xs leading-6 text-slate-300">{result.summary}</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-bold text-cyan-100"><CheckCircle2 className="h-4 w-4" />研究理由</div>
              <ul className="space-y-1.5 text-xs leading-5 text-slate-400">{result.rationale.map((item, index) => <li key={`${index}-${item}`}>• {item}</li>)}</ul>
            </div>
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-bold text-amber-100"><ShieldCheck className="h-4 w-4" />風險與驗證要求</div>
              <ul className="space-y-1.5 text-xs leading-5 text-amber-100/70">{result.riskWarnings.map((item, index) => <li key={`${index}-${item}`}>• {item}</li>)}</ul>
            </div>
          </div>
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
            <p className="text-xs font-bold text-emerald-100">服務端已強制執行</p>
            <div className="mt-2 flex flex-wrap gap-2">{result.safetyEnforced.map((item) => <Badge key={item} variant="outline" className="border-emerald-500/20 text-[10px] text-emerald-200">{item}</Badge>)}</div>
          </div>
          <div className="flex flex-col gap-3 rounded-lg border border-slate-800 p-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-slate-400">共 {result.changedFields.length} 個欄位與目前表單不同；套用後仍需人工檢查及另行儲存。</p>
            <Button type="button" variant="outline" disabled={disabled} onClick={() => { onApply(result.proposedConfig as RainbowTrendLadderConfig); toast.success("已套用到新策略表單；尚未儲存，實盤武裝保持關閉"); }} className="border-cyan-500/30 bg-cyan-500/5 text-cyan-100">
              套用到表單（不儲存）
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
