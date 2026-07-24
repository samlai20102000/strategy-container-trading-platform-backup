/**
 * DynamicForm - Schema-Driven 動態表單組件（V4.5）
 * 根據策略的 schemaConfig 自動生成 UI 表單
 * 支持：number, string, boolean, select, conditional, array(json), martinLayers 類型
 * 使用 shadcn/ui 組件保持 UI 一致性
 * 新增：進階設定折疊區 + MartinLayersEditor 整合 + 倉位預覽
 */

import { useState, useEffect, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronRight, ChevronDown } from "lucide-react";

// ===== 類型定義 =====

export interface FieldSchema {
  key: string;
  type: "number" | "string" | "boolean" | "select" | "array" | "conditional" | "json" | "martinLayers";
  label: string;
  default?: any;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: any }[];
  description?: string;
  condition?: {
    field: string;
    operator: "eq" | "neq" | "gt" | "lt";
    value: any;
  };
  children?: FieldSchema[];
  /** 標記為進階欄位（預設隱藏在折疊區） */
  advanced?: boolean;
}

export interface SchemaConfig {
  groups?: { name: string; fields: string[] }[];
  fields: Record<string, FieldSchema> | FieldSchema[];
  /** 進階欄位 keys（會自動折疊隱藏） */
  advancedFields?: string[];
}

interface DynamicFormProps {
  schema: SchemaConfig | FieldSchema[] | null;
  values: Record<string, any>;
  onChange: (values: Record<string, any>) => void;
  mode?: "editable" | "readonly";
  showPreview?: boolean;
  compact?: boolean;
  onImportSnapshot?: () => void;
  /** 自定義 MartinLayers 編輯器（外部傳入） */
  martinLayersEditor?: React.ReactNode;
}

// ===== 工具函數 =====

/** 將 SchemaConfig 的 fields 統一轉為陣列格式 */
function normalizeFields(schema: SchemaConfig | FieldSchema[] | null): FieldSchema[] {
  if (!schema) return [];
  if (Array.isArray(schema)) return schema;

  const { fields } = schema;
  if (Array.isArray(fields)) return fields;

  // Record<string, FieldSchema> 格式
  return Object.entries(fields).map(([key, field]) => ({
    ...field,
    key,
  }));
}

/** 獲取分組信息 */
function getGroups(schema: SchemaConfig | FieldSchema[] | null): { name: string; fields: string[] }[] | null {
  if (!schema || Array.isArray(schema)) return null;
  return schema.groups ?? null;
}

/** 獲取進階欄位列表 */
function getAdvancedFields(schema: SchemaConfig | FieldSchema[] | null): string[] {
  if (!schema || Array.isArray(schema)) return [];
  return (schema as SchemaConfig).advancedFields ?? [];
}

// ===== 主組件 =====

export function DynamicForm({
  schema,
  values,
  onChange,
  mode = "editable",
  showPreview = false,
  compact = false,
  onImportSnapshot,
  martinLayersEditor,
}: DynamicFormProps) {
  const [formValues, setFormValues] = useState<Record<string, any>>(values || {});
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);

  // 同步外部值
  useEffect(() => {
    if (values) {
      setFormValues(values);
    }
  }, [values]);

  const fields = useMemo(() => normalizeFields(schema), [schema]);
  const groups = useMemo(() => getGroups(schema), [schema]);
  const advancedFieldKeys = useMemo(() => getAdvancedFields(schema), [schema]);

  // 處理欄位變更
  const handleFieldChange = (key: string, value: any) => {
    const newValues = { ...formValues, [key]: value };
    setFormValues(newValues);
    onChange(newValues);
  };

  // 檢查條件是否滿足
  const isConditionMet = (condition: FieldSchema["condition"]): boolean => {
    if (!condition) return true;
    const fieldValue = formValues[condition.field];
    switch (condition.operator) {
      case "eq": return fieldValue === condition.value;
      case "neq": return fieldValue !== condition.value;
      case "gt": return fieldValue > condition.value;
      case "lt": return fieldValue < condition.value;
      default: return true;
    }
  };

  // 判斷是否為進階欄位
  const isAdvancedField = (field: FieldSchema): boolean => {
    return field.advanced === true || advancedFieldKeys.includes(field.key);
  };

  // 渲染單個欄位
  const renderField = (field: FieldSchema) => {
    const value = formValues[field.key] ?? field.default ?? "";
    const disabled = mode === "readonly";

    // 條件顯示
    if (field.condition && !isConditionMet(field.condition)) {
      return null;
    }

    switch (field.type) {
      case "number":
        return (
          <div key={field.key} className={compact ? "space-y-1" : "space-y-2"}>
            <div className="flex items-center justify-between">
              <Label htmlFor={field.key} className="text-xs font-medium">
                {field.label}
              </Label>
              {field.min !== undefined && field.max !== undefined && (
                <Badge variant="outline" className="text-[10px] px-1 py-0">
                  {field.min} ~ {field.max}
                </Badge>
              )}
            </div>
            <Input
              id={field.key}
              type="number"
              step={field.step || "any"}
              min={field.min}
              max={field.max}
              value={value}
              disabled={disabled}
              onChange={(e) => handleFieldChange(field.key, parseFloat(e.target.value) || 0)}
              className="h-8 text-sm"
            />
            {field.description && (
              <p className="text-[10px] text-muted-foreground">{field.description}</p>
            )}
          </div>
        );

      case "string":
        return (
          <div key={field.key} className={compact ? "space-y-1" : "space-y-2"}>
            <Label htmlFor={field.key} className="text-xs font-medium">
              {field.label}
            </Label>
            <Input
              id={field.key}
              type="text"
              value={value}
              disabled={disabled}
              onChange={(e) => handleFieldChange(field.key, e.target.value)}
              className="h-8 text-sm"
            />
            {field.description && (
              <p className="text-[10px] text-muted-foreground">{field.description}</p>
            )}
          </div>
        );

      case "boolean":
        return (
          <div key={field.key} className="flex items-center justify-between py-1">
            <div>
              <Label htmlFor={field.key} className="text-xs font-medium">
                {field.label}
              </Label>
              {field.description && (
                <p className="text-[10px] text-muted-foreground">{field.description}</p>
              )}
            </div>
            <Switch
              id={field.key}
              checked={!!value}
              disabled={disabled}
              onCheckedChange={(checked) => handleFieldChange(field.key, checked)}
            />
          </div>
        );

      case "select":
        return (
          <div key={field.key} className={compact ? "space-y-1" : "space-y-2"}>
            <Label htmlFor={field.key} className="text-xs font-medium">
              {field.label}
            </Label>
            <Select
              value={String(value || field.default || "")}
              disabled={disabled}
              onValueChange={(v) => handleFieldChange(field.key, v)}
            >
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="請選擇..." />
              </SelectTrigger>
              <SelectContent>
                {field.options?.map((opt) => (
                  <SelectItem key={String(opt.value)} value={String(opt.value)}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {field.description && (
              <p className="text-[10px] text-muted-foreground">{field.description}</p>
            )}
          </div>
        );

      case "conditional":
        if (field.condition && !isConditionMet(field.condition)) return null;
        return (
          <div key={field.key} className="pl-3 border-l-2 border-muted space-y-3">
            {field.children?.map((child) => renderField(child))}
          </div>
        );

      case "martinLayers":
        // 使用外部傳入的 MartinLayersEditor
        if (field.condition && !isConditionMet(field.condition)) return null;
        return (
          <div key={field.key} className="col-span-2">
            <Label className="text-xs font-medium mb-2 block">{field.label}</Label>
            {martinLayersEditor || (
              <div className="text-xs text-muted-foreground bg-muted/50 rounded p-2 font-mono max-h-24 overflow-auto">
                {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
              </div>
            )}
            {field.description && (
              <p className="text-[10px] text-muted-foreground mt-1">{field.description}</p>
            )}
          </div>
        );

      case "json":
      case "array":
        return (
          <div key={field.key} className={compact ? "space-y-1" : "space-y-2"}>
            <Label htmlFor={field.key} className="text-xs font-medium">
              {field.label}
            </Label>
            <div className="text-xs text-muted-foreground bg-muted/50 rounded p-2 font-mono max-h-24 overflow-auto">
              {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
            </div>
            {field.description && (
              <p className="text-[10px] text-muted-foreground">{field.description}</p>
            )}
          </div>
        );

      default:
        return null;
    }
  };

  // 分離普通欄位和進階欄位
  const { normalFields, advancedFieldsList } = useMemo(() => {
    const normal: FieldSchema[] = [];
    const advanced: FieldSchema[] = [];
    for (const field of fields) {
      if (isAdvancedField(field)) {
        advanced.push(field);
      } else {
        normal.push(field);
      }
    }
    return { normalFields: normal, advancedFieldsList: advanced };
  }, [fields, advancedFieldKeys]);

  // 按分組渲染（只渲染普通欄位）
  const renderGrouped = () => {
    if (!groups || groups.length === 0) {
      return (
        <div className={compact ? "grid grid-cols-2 gap-3" : "grid grid-cols-1 md:grid-cols-2 gap-4"}>
          {normalFields.map((field) => renderField(field))}
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {groups.map((group, idx) => {
          const groupFields = group.fields
            .map((key) => normalFields.find((f) => f.key === key))
            .filter(Boolean) as FieldSchema[];

          if (groupFields.length === 0) return null;

          return (
            <div key={group.name}>
              {idx > 0 && <Separator className="my-3" />}
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                {group.name}
              </h4>
              <div className={compact ? "grid grid-cols-2 gap-3" : "grid grid-cols-1 md:grid-cols-2 gap-4"}>
                {groupFields.map((field) => renderField(field))}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // 進階設定折疊區
  const renderAdvanced = () => {
    if (advancedFieldsList.length === 0) return null;

    return (
      <Collapsible open={isAdvancedOpen} onOpenChange={setIsAdvancedOpen}>
        <Separator className="my-3" />
        <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer w-full">
          {isAdvancedOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <span className="font-medium">進階設定</span>
          <span className="text-[10px] ml-1">（0 = 不啟用）</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-3 p-3 bg-muted/30 rounded-lg">
            <div className={compact ? "grid grid-cols-2 gap-3" : "grid grid-cols-2 gap-4"}>
              {advancedFieldsList.map((field) => renderField(field))}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  };

  // 倉位預覽
  const renderPreview = () => {
    if (!showPreview) return null;

    const baseLot = formValues.Base_Lot_Size || 30;
    const stepPct = formValues.Martin_Step_Pct || 2.0;
    const martinMode = formValues.martin_mode || "fixed";
    const multiplier = formValues.Martin_Multiplier || 1.5;
    const maxLayers = Math.min(formValues.Max_Layers || 11, 11);
    const initialCapital = formValues.Initial_Capital || 10000;

    // 解析階梯式乘數
    let layeredMultipliers: number[] = [];
    if (martinMode === "layered") {
      try {
        const layersJson = formValues.martinLayersJson || formValues.Martin_Layers;
        if (typeof layersJson === "string" && layersJson) {
          const parsed = JSON.parse(layersJson);
          if (Array.isArray(parsed)) {
            // 展開規則為每層乘數
            for (const rule of parsed) {
              const from = rule.from || rule.startLayer || 1;
              const to = rule.to || rule.endLayer || from;
              const mult = rule.multiplier || 1.0;
              for (let i = from; i <= to && layeredMultipliers.length < maxLayers; i++) {
                layeredMultipliers.push(mult);
              }
            }
          }
        }
      } catch {}
    }

    const layers: { layer: number; lot: string; cumLot: string; triggerDrop: string; multiplier: string }[] = [];
    let cumulativeLot = 0;

    for (let i = 1; i <= Math.min(maxLayers, 6); i++) {
      let layerMultiplier: number;
      if (martinMode === "layered" && layeredMultipliers.length >= i) {
        layerMultiplier = layeredMultipliers[i - 1];
      } else {
        layerMultiplier = multiplier;
      }

      const lot = i === 1 ? baseLot : baseLot * Math.pow(layerMultiplier, i - 1);
      cumulativeLot += lot;
      const triggerDrop = (i * stepPct).toFixed(1);

      layers.push({
        layer: i,
        lot: lot.toFixed(2),
        cumLot: cumulativeLot.toFixed(2),
        triggerDrop: `-${triggerDrop}%`,
        multiplier: layerMultiplier.toFixed(1) + "x",
      });
    }

    const maxExposurePct = ((cumulativeLot / initialCapital) * 100).toFixed(1);

    return (
      <Card className="mt-4">
        <CardHeader className="py-3 px-4">
          <CardTitle className="text-xs flex items-center gap-2">
            倉位預覽
            <Badge variant="outline" className="text-[10px]">
              最大曝險 {maxExposurePct}%
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs h-7">層</TableHead>
                <TableHead className="text-xs h-7">乘數</TableHead>
                <TableHead className="text-xs h-7">本層 (USDT)</TableHead>
                <TableHead className="text-xs h-7">累計 (USDT)</TableHead>
                <TableHead className="text-xs h-7">觸發偏離</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {layers.map((l) => (
                <TableRow key={l.layer}>
                  <TableCell className="text-xs py-1 font-medium">{l.layer}</TableCell>
                  <TableCell className="text-xs py-1">{l.multiplier}</TableCell>
                  <TableCell className="text-xs py-1">{l.lot}</TableCell>
                  <TableCell className="text-xs py-1">{l.cumLot}</TableCell>
                  <TableCell className="text-xs py-1 text-red-400">{l.triggerDrop}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-[10px] text-muted-foreground mt-2">
            前 {Math.min(maxLayers, 6)} 層總投入 {cumulativeLot.toFixed(0)} USDT（本金 {initialCapital} 的 {maxExposurePct}%）
          </p>
        </CardContent>
      </Card>
    );
  };

  if (fields.length === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-4">
        此策略尚未定義參數結構（schemaConfig）
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {onImportSnapshot && (
        <button
          onClick={onImportSnapshot}
          className="text-sm text-blue-500 hover:text-blue-700 flex items-center gap-1"
        >
          📋 從快照導入參數
        </button>
      )}
      {renderGrouped()}
      {renderAdvanced()}
      {renderPreview()}
    </div>
  );
}

export default DynamicForm;
