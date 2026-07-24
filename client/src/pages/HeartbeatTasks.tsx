import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import DashboardLayout from "@/components/DashboardLayout";
import {
  PlusCircle,
  Play,
  Pause,
  Trash2,
  Edit,
  RefreshCw,
  Activity,
  Bell,
  Zap,
  Clock,
} from "lucide-react";
import { toast } from "sonner";

const K_LINE_PERIODS = [
  { value: "1", label: "1 分鐘" },
  { value: "5", label: "5 分鐘" },
  { value: "15", label: "15 分鐘" },
  { value: "30", label: "30 分鐘" },
  { value: "60", label: "1 小時" },
  { value: "240", label: "4 小時" },
  { value: "1440", label: "1 天" },
];

export default function HeartbeatTasks() {
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [selectedTask, setSelectedTask] = useState<any>(null);
  const [createForm, setCreateForm] = useState({
    strategyId: "",
    kLinePeriod: "15",
  });

  // 獲取 Heartbeat 任務列表
  const {
    data: heartbeatStatus,
    isLoading,
    error,
    refetch,
  } = trpc.autoTrade.getHeartbeatStatus.useQuery();

  // 獲取策略列表（用於新增任務時選擇策略）
  const { data: strategiesData } = trpc.strategies.list.useQuery();

  // 創建任務
  const createTaskMutation = trpc.autoTrade.createHeartbeatTask.useMutation({
    onSuccess: () => {
      toast.success("Heartbeat 任務創建成功");
      setShowCreateDialog(false);
      setCreateForm({ strategyId: "", kLinePeriod: "15" });
      refetch();
    },
    onError: (err) => {
      toast.error(`創建失敗: ${err.message}`);
    },
  });

  // 切換任務狀態（啟用/暫停）
  const toggleTaskMutation = trpc.autoTrade.toggleHeartbeatTask.useMutation({
    onSuccess: (data) => {
      toast.success(data.enabled ? "任務已啟用" : "任務已暫停");
      refetch();
    },
    onError: (err) => {
      toast.error(`操作失敗: ${err.message}`);
    },
  });

  // 刪除任務
  const deleteTaskMutation = trpc.autoTrade.deleteHeartbeatTask.useMutation({
    onSuccess: () => {
      toast.success("任務已刪除");
      setShowDeleteDialog(false);
      setSelectedTask(null);
      refetch();
    },
    onError: (err) => {
      toast.error(`刪除失敗: ${err.message}`);
    },
  });

  // 手動觸發任務
  const triggerTaskMutation = trpc.autoTrade.triggerHeartbeatTask.useMutation({
    onSuccess: (data) => {
      if (data.success) {
        toast.success(`信號生成完成: ${data.signal?.action || "HOLD"}`);
      } else {
        toast.info(data.message || "無交易信號");
      }
      refetch();
    },
    onError: (err) => {
      toast.error(`觸發失敗: ${err.message}`);
    },
  });

  const handleCreate = () => {
    if (!createForm.strategyId) {
      toast.error("請選擇策略");
      return;
    }
    createTaskMutation.mutate({
      strategyId: parseInt(createForm.strategyId),
      kLinePeriod: parseInt(createForm.kLinePeriod),
    });
  };

  const handleToggle = (strategyId: number, currentEnabled: boolean) => {
    toggleTaskMutation.mutate({
      strategyId,
      enabled: !currentEnabled,
    });
  };

  const handleDelete = () => {
    if (!selectedTask) return;
    deleteTaskMutation.mutate({ strategyId: selectedTask.strategyId });
  };

  const handleTrigger = (strategyId: number, symbol: string) => {
    triggerTaskMutation.mutate({ strategyId, symbol });
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* 頁面標題和操作 */}
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold">Heartbeat 任務管理</h1>
            <p className="text-muted-foreground mt-1">
              管理 24/7 自動交易任務，每個任務綁定一個策略自動生成信號並執行交易
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="mr-2 h-4 w-4" /> 刷新
            </Button>
            <Button onClick={() => setShowCreateDialog(true)}>
              <PlusCircle className="mr-2 h-4 w-4" /> 新增任務
            </Button>
          </div>
        </div>

        {/* 核心功能概覽 */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4 pb-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-500/10">
                <Zap className="h-5 w-5 text-green-500" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">動態策略選擇</p>
                <p className="text-lg font-semibold">
                  {heartbeatStatus?.statuses?.filter((s) => s.status === "running").length || 0} 運行中
                </p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <Activity className="h-5 w-5 text-blue-500" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">實時信號生成</p>
                <p className="text-lg font-semibold">
                  {heartbeatStatus?.strategiesProcessed || 0} 策略監控
                </p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-500/10">
                <Bell className="h-5 w-5 text-purple-500" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Telegram 通知</p>
                <p className="text-lg font-semibold">已啟用</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-500/10">
                <Clock className="h-5 w-5 text-orange-500" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">上次執行</p>
                <p className="text-lg font-semibold">
                  {heartbeatStatus?.timestamp
                    ? new Date(heartbeatStatus.timestamp).toLocaleTimeString()
                    : "N/A"}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 任務列表 */}
        <Card>
          <CardHeader>
            <CardTitle>現有 Heartbeat 任務</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-muted-foreground">載入中...</p>
            ) : error ? (
              <p className="text-destructive">載入失敗: {error.message}</p>
            ) : heartbeatStatus &&
              heartbeatStatus.statuses &&
              heartbeatStatus.statuses.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>策略 ID</TableHead>
                    <TableHead>策略名稱</TableHead>
                    <TableHead>交易對</TableHead>
                    <TableHead>K 線週期</TableHead>
                    <TableHead>上次執行</TableHead>
                    <TableHead>狀態</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {heartbeatStatus.statuses.map((task) => (
                    <TableRow key={task.strategyId}>
                      <TableCell className="font-mono">
                        {task.strategyId}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate">
                        {task.strategyName}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{task.symbol}</Badge>
                      </TableCell>
                      <TableCell>{task.kLinePeriod} 分鐘</TableCell>
                      <TableCell>
                        {task.lastSignalTime
                          ? new Date(task.lastSignalTime).toLocaleString()
                          : "尚未執行"}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            task.status === "running" ? "default" : "secondary"
                          }
                          className={
                            task.status === "running"
                              ? "bg-green-500/20 text-green-400 border-green-500/30"
                              : ""
                          }
                        >
                          {task.status === "running" ? "運行中" : "已停止"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            title="手動觸發"
                            onClick={() =>
                              handleTrigger(task.strategyId, task.symbol)
                            }
                            disabled={triggerTaskMutation.isPending}
                          >
                            <Zap className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            title={
                              task.status === "running" ? "暫停" : "啟用"
                            }
                            onClick={() =>
                              handleToggle(
                                task.strategyId,
                                task.status === "running"
                              )
                            }
                            disabled={toggleTaskMutation.isPending}
                          >
                            {task.status === "running" ? (
                              <Pause className="h-4 w-4" />
                            ) : (
                              <Play className="h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            title="刪除"
                            className="text-destructive hover:text-destructive"
                            onClick={() => {
                              setSelectedTask(task);
                              setShowDeleteDialog(true);
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="text-center py-8">
                <Activity className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
                <p className="text-muted-foreground">目前沒有 Heartbeat 任務</p>
                <p className="text-sm text-muted-foreground mt-1">
                  點擊「新增任務」開始自動交易
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* 新增任務對話框 */}
        <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>新增 Heartbeat 任務</DialogTitle>
              <DialogDescription>
                選擇一個策略和 K 線週期，系統將自動按照設定的頻率生成信號並執行交易。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>選擇策略</Label>
                <Select
                  value={createForm.strategyId}
                  onValueChange={(v) =>
                    setCreateForm((f) => ({ ...f, strategyId: v }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="選擇要綁定的策略" />
                  </SelectTrigger>
                  <SelectContent>
                    {strategiesData?.map((s: any) => (
                      <SelectItem key={s.id} value={String(s.id)}>
                        {s.name} ({s.symbol})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>K 線週期</Label>
                <Select
                  value={createForm.kLinePeriod}
                  onValueChange={(v) =>
                    setCreateForm((f) => ({ ...f, kLinePeriod: v }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {K_LINE_PERIODS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowCreateDialog(false)}
              >
                取消
              </Button>
              <Button
                onClick={handleCreate}
                disabled={createTaskMutation.isPending}
              >
                {createTaskMutation.isPending ? "創建中..." : "創建任務"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 刪除確認對話框 */}
        <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>確認刪除任務？</AlertDialogTitle>
              <AlertDialogDescription>
                刪除後，策略「{selectedTask?.strategyName}」的自動交易將停止。此操作無法撤銷。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {deleteTaskMutation.isPending ? "刪除中..." : "確認刪除"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </DashboardLayout>
  );
}
