import { useEffect, useRef, useState } from "react";
import { Plus, CornerDownLeft, Shield, ShieldAlert, Cpu, Gauge } from "lucide-react";
import type { AgentProfile, PermissionMode } from "../types";
import { DEFAULT_PERMISSION_MODE } from "../types";
import { OptionDropdown, type DropdownOption } from "./composer/OptionDropdown";
import { appendAttachments } from "../lib/attachments";

const MAX_PROMPT_HEIGHT_PX = 180;
const LOCKED_OPTIONS_TITLE = "Applies to the next new session: CLI flags are set when an agent starts.";

type OpenDropdown = "permission" | "model" | "effort" | null;

export interface ComposerDockProps {
  activeAgent?: AgentProfile;
  /** A model alias from the agent profile; undefined means the agent's default. */
  selectedModel?: string;
  /** An effort label from the agent profile; undefined means the agent's default. */
  selectedEffort?: string;
  permissionMode?: PermissionMode;
  /** True while a session runs: its flags were fixed when it started. */
  optionsLocked?: boolean;
  isThinking?: boolean;
  placeholder?: string;
  disabled?: boolean;
  onSendMessage: (message: string) => void;
  onModelChange?: (model: string | undefined) => void;
  onEffortChange?: (effort: string | undefined) => void;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  /** Opens a file picker and resolves with the chosen paths; hidden when absent. */
  onAttach?: () => Promise<string[]>;
}

function withDefault(defaultLabel: string, values: readonly string[]): DropdownOption[] {
  return [{ value: undefined, label: defaultLabel }, ...values.map((v) => ({ value: v, label: v }))];
}

export function ComposerDock({
  activeAgent,
  selectedModel,
  selectedEffort,
  permissionMode = DEFAULT_PERMISSION_MODE,
  optionsLocked = false,
  isThinking = false,
  placeholder = "Type / for commands, or prompt the agent...",
  disabled = false,
  onSendMessage,
  onModelChange,
  onEffortChange,
  onPermissionModeChange,
  onAttach,
}: ComposerDockProps) {
  const [text, setText] = useState("");
  const [openDropdown, setOpenDropdown] = useState<OpenDropdown>(null);
  const containerRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Close any open dropdown on a click outside the composer.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpenDropdown(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const permissionOptions: DropdownOption[] = (activeAgent?.permission_modes ?? []).map((m) => ({
    value: m.id,
    label: m.label,
  }));
  const modelOptions = withDefault("Default model", activeAgent?.models ?? []);
  const effortOptions = withDefault(
    "Default effort",
    (activeAgent?.effort_levels ?? []).map((e) => e.label),
  );

  const toggle = (name: Exclude<OpenDropdown, null>) =>
    setOpenDropdown((current) => (current === name ? null : name));
  const choose = <T,>(handler: ((value: T) => void) | undefined) => (value: T) => {
    handler?.(value);
    setOpenDropdown(null);
  };

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSendMessage(trimmed);
    setText("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, MAX_PROMPT_HEIGHT_PX)}px`;
  };

  const handleAttach = async () => {
    if (!onAttach) return;
    const paths = await onAttach();
    setText((current) => appendAttachments(current, paths));
    textareaRef.current?.focus();
  };

  const isRiskyPermission = permissionMode !== DEFAULT_PERMISSION_MODE;

  return (
    <footer ref={containerRef} className="w-full max-w-3xl flex flex-col items-center px-4 select-none">
      <div
        className="w-full rounded-xl border border-[#262626] bg-[#121212] p-3 shadow-2xl transition-all focus-within:border-neutral-700 focus-within:ring-1 focus-within:ring-amber-500/20"
        style={{ boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }}
      >
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          aria-label="Prompt"
          className="w-full bg-transparent text-sm text-neutral-200 placeholder-neutral-500 outline-none resize-none leading-relaxed min-h-[26px] max-h-[180px]"
        />

        <div className="mt-2 flex items-center justify-between border-t border-neutral-800/40 pt-2 text-xs">
          <div className="flex items-center gap-1">
            {onAttach && (
              <button
                type="button"
                aria-label="Add attachment"
                title="Attach files"
                onClick={() => void handleAttach()}
                disabled={disabled}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Plus size={15} />
              </button>
            )}

            {permissionOptions.length > 0 && (
              <OptionDropdown
                label="Permission mode"
                align="left"
                icon={
                  isRiskyPermission ? (
                    <ShieldAlert size={13} className="text-amber-500" />
                  ) : (
                    <Shield size={13} className="text-emerald-500" />
                  )
                }
                options={permissionOptions}
                selected={permissionMode}
                isOpen={openDropdown === "permission"}
                onToggle={() => toggle("permission")}
                onSelect={choose((value: string | undefined) =>
                  onPermissionModeChange?.(value ?? DEFAULT_PERMISSION_MODE),
                )}
                disabled={optionsLocked}
                disabledTitle={LOCKED_OPTIONS_TITLE}
              />
            )}
          </div>

          <div className="flex items-center gap-2">
            {isThinking && (
              <div
                data-testid="thinking-indicator-ring"
                className="h-4 w-4 rounded-full border-2 border-amber-500/30 border-t-amber-500 animate-spin"
              />
            )}

            {modelOptions.length > 1 && (
              <OptionDropdown
                label="Model"
                icon={<Cpu size={12} className="text-neutral-400" />}
                options={modelOptions}
                selected={selectedModel}
                isOpen={openDropdown === "model"}
                onToggle={() => toggle("model")}
                onSelect={choose(onModelChange)}
                disabled={optionsLocked}
                disabledTitle={LOCKED_OPTIONS_TITLE}
              />
            )}

            {effortOptions.length > 1 && (
              <OptionDropdown
                label="Effort"
                icon={<Gauge size={12} className="text-neutral-400" />}
                options={effortOptions}
                selected={selectedEffort}
                isOpen={openDropdown === "effort"}
                onToggle={() => toggle("effort")}
                onSelect={choose(onEffortChange)}
                disabled={optionsLocked}
                disabledTitle={LOCKED_OPTIONS_TITLE}
              />
            )}

            <button
              type="button"
              aria-label="Send message"
              onClick={handleSend}
              disabled={!text.trim() || disabled}
              className="flex h-7 w-7 items-center justify-center rounded-lg bg-neutral-200 text-neutral-900 hover:bg-white disabled:opacity-30 disabled:hover:bg-neutral-200 transition-all font-medium cursor-pointer"
            >
              <CornerDownLeft size={14} />
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
}
