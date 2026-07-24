/**
 * useBacktestWs - 前端 WebSocket hook
 * 訂閱回測任務進度，替代輪詢機制
 */

import { useEffect, useRef, useState, useCallback } from "react";

interface WsProgress {
  type: "progress" | "complete" | "error";
  jobId: string;
  progress?: number;
  status?: string;
  message?: string;
  result?: any;
  error?: string;
  timestamp?: number;
}

interface UseBacktestWsOptions {
  jobId: string | null;
  onProgress?: (data: WsProgress) => void;
  onComplete?: (data: WsProgress) => void;
  onError?: (data: WsProgress) => void;
}

export function useBacktestWs({ jobId, onProgress, onComplete, onError }: UseBacktestWsOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacksRef = useRef({ onProgress, onComplete, onError });
  callbacksRef.current = { onProgress, onComplete, onError };

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        // 訂閱當前 jobId
        if (jobId) {
          ws.send(JSON.stringify({ type: "subscribe", jobId }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const data: WsProgress = JSON.parse(event.data);
          if (data.type === "progress") {
            callbacksRef.current.onProgress?.(data);
          } else if (data.type === "complete") {
            callbacksRef.current.onComplete?.(data);
          } else if (data.type === "error") {
            callbacksRef.current.onError?.(data);
          }
        } catch {
          // 忽略無效消息
        }
      };

      ws.onclose = () => {
        setConnected(false);
        // 自動重連（3 秒後）
        if (jobId) {
          reconnectTimerRef.current = setTimeout(() => {
            connect();
          }, 3000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      // WebSocket 連接失敗，靜默處理（fallback 到輪詢）
    }
  }, [jobId]);

  // 當 jobId 變化時重新訂閱
  useEffect(() => {
    if (!jobId) return;

    connect();

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setConnected(false);
    };
  }, [jobId, connect]);

  // jobId 變化時發送訂閱
  useEffect(() => {
    if (jobId && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "subscribe", jobId }));
    }
  }, [jobId]);

  return { connected };
}
