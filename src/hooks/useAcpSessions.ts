import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useLatest } from './useLatest';
import type { PermissionRequestPayload } from '../lib/acp-events';
import { toElicitationCard } from '../lib/acp-elicitation';
import { toListedSessions, type ListedSessions } from '../lib/session-list';
import { orphanSweepDone } from '../lib/orphan-sweep';
import type { ContextUsage, ElicitationAnswer, ElicitationCard, SlashCommand } from '../types';

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
  /** The agent's slash commands, from its latest available_commands_update. */
  commands: SlashCommand[];
  /** Context window use, from the agent's latest usage_update. */
  usage?: ContextUsage;
  canFork: boolean;
  /** The agent can reopen a session of its own (session/resume or session/load). */
  canReopen: boolean;
  /** How the backend reopened an earlier session; absent for a start or a fork. */
  reopenedWith?: 'resume' | 'load';
  isBusy: boolean;
}

export interface TurnResult {
  stopReason?: string;
  error?: string;
}

export interface AcpHandlers {
  onUpdate: (sessionId: string, update: unknown) => void;
  onPermission: (sessionId: string, request: PermissionRequestPayload) => void;
  /** The agent asks the user for input, or to open a page; a malformed request is never passed on. */
  onElicitation: (sessionId: string, card: ElicitationCard) => void;
  /** The agent reports a page it sent the user to as done. */
  onElicitationComplete: (sessionId: string, key: string) => void;
  onTurnEnd: (sessionId: string, result: TurnResult) => void;
  onExit: (sessionId: string, code: number | null) => void;
  /** Failures that would otherwise go unnoticed, e.g. not being able to listen for agent events. */
  onError?: (message: string) => void;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';

/** Validates modes an agent reported; null when malformed. */
export function toModes(raw: unknown): AcpModes | null {
  if (!isObject(raw) || !isString(raw.currentModeId) || !Array.isArray(raw.availableModes)) return null;
  const availableModes = raw.availableModes
    .filter(isObject)
    .filter((m) => isString(m.id) && isString(m.name))
    .map((m) => ({ id: m.id as string, name: m.name as string, description: isString(m.description) ? m.description : undefined }));
  return { currentModeId: raw.currentModeId, availableModes };
}

/** Validates config options an agent reported, dropping malformed ones. */
export function toConfigOptions(raw: unknown): AcpConfigOption[] {
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

/** Validates an agent's command list, dropping malformed entries. */
export function toCommands(raw: unknown): SlashCommand[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObject).flatMap((command) => {
    if (!isString(command.name)) return [];
    const input = isObject(command.input) ? command.input : {};
    return [
      {
        name: command.name,
        description: isString(command.description) ? command.description : '',
        ...(isString(input.hint) ? { hint: input.hint } : {}),
      },
    ];
  });
}

function toInfo(raw: unknown): AcpSessionInfo {
  const started = isObject(raw) ? raw : {};
  const capabilities = isObject(started.agentCapabilities) ? started.agentCapabilities : {};
  const sessionCaps = isObject(capabilities.sessionCapabilities) ? capabilities.sessionCapabilities : {};
  const reopenedWith =
    started.reopenedWith === 'resume' || started.reopenedWith === 'load' ? started.reopenedWith : undefined;
  return {
    acpSessionId: isString(started.acpSessionId) ? started.acpSessionId : '',
    modes: toModes(started.modes),
    configOptions: toConfigOptions(started.configOptions),
    commands: [],
    canFork: isObject(sessionCaps.fork),
    canReopen: capabilities.loadSession === true || isObject(sessionCaps.resume),
    ...(reopenedWith ? { reopenedWith } : {}),
    isBusy: false,
  };
}

/**
 * ACP sessions in the backend: starting, prompting, permissions, modes and
 * config, plus the busy state of each turn (busy from prompt to turn end).
 */
export function useAcpSessions(handlers: AcpHandlers) {
  const [info, setInfo] = useState<Record<string, AcpSessionInfo>>({});
  // When each busy session's current turn started.
  const [busySince, setBusySince] = useState<Record<string, number>>({});
  const handlersRef = useLatest(handlers);
  // Commands an agent announces once its session exists but before the start
  // call has returned; they are announced once, so they must not be lost.
  const knownRef = useRef(new Set<string>());
  const earlyCommandsRef = useRef(new Map<string, SlashCommand[]>());

  const patch = useCallback((sessionId: string, change: (current: AcpSessionInfo) => AcpSessionInfo) => {
    setInfo((prev) => (prev[sessionId] ? { ...prev, [sessionId]: change(prev[sessionId]) } : prev));
  }, []);

  const setBusy = useCallback(
    (sessionId: string, isBusy: boolean) => {
      patch(sessionId, (current) => ({ ...current, isBusy }));
      setBusySince((prev) => {
        if (isBusy) return { ...prev, [sessionId]: Date.now() };
        const { [sessionId]: _ended, ...rest } = prev;
        return sessionId in prev ? rest : prev;
      });
    },
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
          if (isObject(update) && update.sessionUpdate === 'available_commands_update') {
            const commands = toCommands(update.availableCommands);
            if (knownRef.current.has(sessionId)) patch(sessionId, (c) => ({ ...c, commands }));
            else earlyCommandsRef.current.set(sessionId, commands);
          }
          if (isObject(update) && update.sessionUpdate === 'usage_update') {
            const { used, size, cost } = update;
            const amount = isObject(cost) && typeof cost.amount === 'number' ? cost.amount : undefined;
            const currency = isObject(cost) && isString(cost.currency) ? cost.currency : undefined;
            if (typeof used === 'number' && typeof size === 'number') {
              const usage = { used, size, ...(amount !== undefined && currency ? { cost: { amount, currency } } : {}) };
              patch(sessionId, (c) => ({ ...c, usage }));
            }
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
        case 'elicitation': {
          const card = toElicitationCard(sessionId, payload.key, payload.request, Date.now());
          if (card) h.onElicitation(sessionId, card);
          break;
        }
        case 'elicitation-complete':
          if (isString(payload.key)) h.onElicitationComplete(sessionId, payload.key);
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
          // A later resume opens it afresh; its first commands must be kept again.
          knownRef.current.delete(sessionId);
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
    const early = earlyCommandsRef.current.get(sessionId);
    earlyCommandsRef.current.delete(sessionId);
    knownRef.current.add(sessionId);
    const started = { ...toInfo(raw), commands: early ?? [] };
    setInfo((prev) => ({ ...prev, [sessionId]: started }));
    return started;
  }, []);

  // The startup orphan sweep stops every agent it finds, so a session started
  // before it ran would be stopped with the rest: each start waits for it.
  const start = useCallback(
    async (sessionId: string, cwd: string, profileId: string) => {
      await orphanSweepDone();
      return remember(sessionId, await invoke('acp_start_session', { sessionId, cwd, profileId }));
    },
    [remember],
  );

  const reopen = useCallback(
    async (sessionId: string, cwd: string, profileId: string, acpSessionId: string) => {
      await orphanSweepDone();
      return remember(sessionId, await invoke('acp_reopen_session', { sessionId, cwd, profileId, acpSessionId }));
    },
    [remember],
  );

  const importSession = useCallback(
    async (sessionId: string, cwd: string, profileId: string, acpSessionId: string) => {
      await orphanSweepDone();
      return remember(sessionId, await invoke('acp_import_session', { sessionId, cwd, profileId, acpSessionId }));
    },
    [remember],
  );

  /** The agent's sessions in `cwd`, as the backend validated them. */
  const listSessions = useCallback(
    async (profileId: string, cwd: string): Promise<ListedSessions> =>
      toListedSessions(await invoke('acp_list_sessions', { profileId, cwd })),
    [],
  );

  const fork = useCallback(
    async (sourceSessionId: string, sessionId: string, cwd: string) => {
      await orphanSweepDone();
      return remember(sessionId, await invoke('acp_fork_session', { sourceSessionId, sessionId, cwd }));
    },
    [remember],
  );

  const prompt = useCallback(
    async (sessionId: string, text: string, attachments: readonly string[] = []) => {
      setBusy(sessionId, true);
      try {
        await invoke('acp_prompt', { sessionId, text, attachments });
      } catch (error) {
        setBusy(sessionId, false);
        throw error;
      }
    },
    [setBusy],
  );

  /** Resolves with the keys of the elicitations the backend answered `cancel`. */
  const cancel = useCallback(
    async (sessionId: string) => (await invoke<string[] | null>('acp_cancel', { sessionId })) ?? [],
    [],
  );

  const respondPermission = useCallback(
    (sessionId: string, requestId: string | number, optionId: string | null) =>
      invoke<void>('acp_respond_permission', { sessionId, requestId, optionId }),
    [],
  );

  /** Only the answer's action and content go out; nothing of it is kept here. */
  const respondElicitation = useCallback(
    (sessionId: string, key: string, answer: ElicitationAnswer) =>
      invoke<void>('acp_respond_elicitation', {
        sessionId,
        key,
        action: answer.action,
        content: answer.action === 'accept' ? (answer.content ?? null) : null,
      }),
    [],
  );

  const reopenElicitationUrl = useCallback(
    (sessionId: string, key: string) => invoke<void>('acp_reopen_elicitation_url', { sessionId, key }),
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
    /** Resolves with the options the agent reports after the change, which may be none. */
    async (sessionId: string, configId: string, value: string): Promise<AcpConfigOption[]> => {
      const options = toConfigOptions(await invoke('acp_set_config_option', { sessionId, configId, value }));
      patch(sessionId, (c) => ({ ...c, configOptions: options.length > 0 ? options : c.configOptions }));
      return options;
    },
    [patch],
  );

  const stop = useCallback((sessionId: string) => {
    knownRef.current.delete(sessionId);
    earlyCommandsRef.current.delete(sessionId);
    setInfo((prev) => {
      const { [sessionId]: _removed, ...rest } = prev;
      return rest;
    });
    return invoke<void>('acp_stop_session', { sessionId });
  }, []);

  const isBusy = useCallback((sessionId: string) => info[sessionId]?.isBusy ?? false, [info]);
  const busySinceOf = useCallback((sessionId: string): number | undefined => busySince[sessionId], [busySince]);
  const canFork = useCallback((sessionId: string) => info[sessionId]?.canFork ?? false, [info]);

  return {
    info,
    start,
    reopen,
    importSession,
    listSessions,
    fork,
    prompt,
    cancel,
    respondPermission,
    respondElicitation,
    reopenElicitationUrl,
    setMode,
    setConfigOption,
    stop,
    isBusy,
    busySinceOf,
    canFork,
  };
}
