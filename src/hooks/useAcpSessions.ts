import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useLatest } from './useLatest';
import type { PermissionRequestPayload } from '../lib/acp-events';

/** The one event channel the backend emits ACP traffic on. */
export const ACP_EVENT = 'acp-event';

export interface AcpMode {
  id: string;
  name: string;
  description?: string;
}

export interface AcpModes {
  currentModeId: string;
  availableModes: AcpMode[];
}

export interface AcpConfigOption {
  id: string;
  name: string;
  category?: string;
  currentValue: string;
  options: { value: string; name: string; description?: string }[];
}

/** Live facts about one ACP session, as reported by its agent. */
export interface AcpSessionInfo {
  acpSessionId: string;
  modes: AcpModes | null;
  configOptions: AcpConfigOption[];
  canFork: boolean;
  isBusy: boolean;
}

export interface TurnResult {
  stopReason?: string;
  error?: string;
}

export interface AcpHandlers {
  onUpdate: (sessionId: string, update: unknown) => void;
  onPermission: (sessionId: string, request: PermissionRequestPayload) => void;
  onTurnEnd: (sessionId: string, result: TurnResult) => void;
  onExit: (sessionId: string, code: number | null) => void;
  /** Failures that would otherwise go unnoticed, e.g. not being able to listen for agent events. */
  onError?: (message: string) => void;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';

function toModes(raw: unknown): AcpModes | null {
  if (!isObject(raw) || !isString(raw.currentModeId) || !Array.isArray(raw.availableModes)) return null;
  const availableModes = raw.availableModes
    .filter(isObject)
    .filter((m) => isString(m.id) && isString(m.name))
    .map((m) => ({ id: m.id as string, name: m.name as string, description: isString(m.description) ? m.description : undefined }));
  return { currentModeId: raw.currentModeId, availableModes };
}

function toConfigOptions(raw: unknown): AcpConfigOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObject).flatMap((option) => {
    if (!isString(option.id) || !isString(option.name) || !isString(option.currentValue)) return [];
    if (!Array.isArray(option.options)) return [];
    const choices = option.options
      .filter(isObject)
      .filter((c) => isString(c.value) && isString(c.name))
      .map((c) => ({ value: c.value as string, name: c.name as string }));
    return [{ id: option.id, name: option.name, category: isString(option.category) ? option.category : undefined, currentValue: option.currentValue, options: choices }];
  });
}

function toInfo(raw: unknown): AcpSessionInfo {
  const started = isObject(raw) ? raw : {};
  const capabilities = isObject(started.agentCapabilities) ? started.agentCapabilities : {};
  const sessionCaps = isObject(capabilities.sessionCapabilities) ? capabilities.sessionCapabilities : {};
  return {
    acpSessionId: isString(started.acpSessionId) ? started.acpSessionId : '',
    modes: toModes(started.modes),
    configOptions: toConfigOptions(started.configOptions),
    canFork: isObject(sessionCaps.fork),
    isBusy: false,
  };
}

/**
 * ACP sessions in the backend: starting, prompting, permissions, modes and
 * config, plus the busy state of each turn (busy from prompt to turn end).
 */
export function useAcpSessions(handlers: AcpHandlers) {
  const [info, setInfo] = useState<Record<string, AcpSessionInfo>>({});
  const handlersRef = useLatest(handlers);

  const patch = useCallback((sessionId: string, change: (current: AcpSessionInfo) => AcpSessionInfo) => {
    setInfo((prev) => (prev[sessionId] ? { ...prev, [sessionId]: change(prev[sessionId]) } : prev));
  }, []);

  const setBusy = useCallback(
    (sessionId: string, isBusy: boolean) => patch(sessionId, (current) => ({ ...current, isBusy })),
    [patch],
  );

  useEffect(() => {
    let isCancelled = false;
    let unlisten: UnlistenFn | null = null;
    listen<Json>(ACP_EVENT, ({ payload }) => {
      if (!isObject(payload) || !isString(payload.sessionId)) return;
      const sessionId = payload.sessionId;
      const h = handlersRef.current;
      switch (payload.kind) {
        case 'update': {
          const update = payload.update;
          if (isObject(update) && update.sessionUpdate === 'current_mode_update' && isString(update.currentModeId)) {
            const modeId = update.currentModeId;
            patch(sessionId, (c) => (c.modes ? { ...c, modes: { ...c.modes, currentModeId: modeId } } : c));
          }
          if (isObject(update) && update.sessionUpdate === 'config_option_update') {
            const options = toConfigOptions(update.configOptions);
            patch(sessionId, (c) => ({ ...c, configOptions: options }));
          }
          h.onUpdate(sessionId, update);
          break;
        }
        case 'permission':
          h.onPermission(sessionId, {
            requestId: payload.requestId as string | number,
            toolCall: payload.toolCall,
            options: payload.options,
          });
          break;
        case 'turn-end':
          setBusy(sessionId, false);
          h.onTurnEnd(
            sessionId,
            isString(payload.error)
              ? { error: payload.error }
              : { stopReason: isString(payload.stopReason) ? payload.stopReason : undefined },
          );
          break;
        case 'exit':
          setBusy(sessionId, false);
          h.onExit(sessionId, typeof payload.code === 'number' ? payload.code : null);
          break;
      }
    })
      .then((stop) => {
        if (isCancelled) stop();
        else unlisten = stop;
      })
      .catch((error) => {
        handlersRef.current.onError?.(`Cannot receive agent events: ${String(error)}`);
      });
    return () => {
      isCancelled = true;
      unlisten?.();
    };
  }, [handlersRef, patch, setBusy]);

  const remember = useCallback((sessionId: string, raw: unknown) => {
    const started = toInfo(raw);
    setInfo((prev) => ({ ...prev, [sessionId]: started }));
    return started;
  }, []);

  const start = useCallback(
    async (sessionId: string, cwd: string, profileId: string) =>
      remember(sessionId, await invoke('acp_start_session', { sessionId, cwd, profileId })),
    [remember],
  );

  const fork = useCallback(
    async (sourceSessionId: string, sessionId: string, cwd: string) =>
      remember(sessionId, await invoke('acp_fork_session', { sourceSessionId, sessionId, cwd })),
    [remember],
  );

  const prompt = useCallback(
    async (sessionId: string, text: string) => {
      setBusy(sessionId, true);
      try {
        await invoke('acp_prompt', { sessionId, text });
      } catch (error) {
        setBusy(sessionId, false);
        throw error;
      }
    },
    [setBusy],
  );

  const cancel = useCallback((sessionId: string) => invoke<void>('acp_cancel', { sessionId }), []);

  const respondPermission = useCallback(
    (sessionId: string, requestId: string | number, optionId: string | null) =>
      invoke<void>('acp_respond_permission', { sessionId, requestId, optionId }),
    [],
  );

  const setMode = useCallback(
    async (sessionId: string, modeId: string) => {
      await invoke('acp_set_mode', { sessionId, modeId });
      patch(sessionId, (c) => (c.modes ? { ...c, modes: { ...c.modes, currentModeId: modeId } } : c));
    },
    [patch],
  );

  const setConfigOption = useCallback(
    async (sessionId: string, configId: string, value: string) => {
      const options = toConfigOptions(await invoke('acp_set_config_option', { sessionId, configId, value }));
      patch(sessionId, (c) => ({ ...c, configOptions: options.length > 0 ? options : c.configOptions }));
    },
    [patch],
  );

  const stop = useCallback((sessionId: string) => {
    setInfo((prev) => {
      const { [sessionId]: _removed, ...rest } = prev;
      return rest;
    });
    return invoke<void>('acp_stop_session', { sessionId });
  }, []);

  const isBusy = useCallback((sessionId: string) => info[sessionId]?.isBusy ?? false, [info]);
  const canFork = useCallback((sessionId: string) => info[sessionId]?.canFork ?? false, [info]);

  return { info, start, fork, prompt, cancel, respondPermission, setMode, setConfigOption, stop, isBusy, canFork };
}
