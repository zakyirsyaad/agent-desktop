import { useState, useRef, useEffect } from "react";
import {
  Plus,
  Mic,
  ChevronDown,
  CornerDownLeft,
  X,
  Clock,
  Shield,
  ShieldAlert,
  Cpu,
  Gauge,
} from "lucide-react";
import type { AgentProfile, PermissionMode } from "../types";

export interface ComposerDockProps {
  activeAgent?: AgentProfile;
  selectedModel?: string;
  selectedEffort?: string;
  permissionMode?: PermissionMode;
  isThinking?: boolean;
  bannerMessage?: string;
  placeholder?: string;
  disabled?: boolean;
  onSendMessage: (message: string) => void;
  onModelChange?: (model: string) => void;
  onEffortChange?: (effort: string) => void;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  onDismissBanner?: () => void;
  onAttach?: () => void;
  onVoice?: () => void;
}

export function ComposerDock({
  activeAgent,
  selectedModel,
  selectedEffort = "Medium",
  permissionMode = "bypass",
  isThinking = false,
  bannerMessage,
  placeholder = "Type / for commands, or prompt the agent...",
  disabled = false,
  onSendMessage,
  onModelChange,
  onEffortChange,
  onPermissionModeChange,
  onDismissBanner,
  onAttach,
  onVoice,
}: ComposerDockProps) {
  const [text, setText] = useState("");
  const [isBannerDismissed, setIsBannerDismissed] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<"permission" | "model" | "effort" | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpenDropdown(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  // Available models and effort levels
  const availableModels = activeAgent?.models && activeAgent.models.length > 0
    ? activeAgent.models
    : ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"];

  const availableEfforts = activeAgent?.effort_levels && activeAgent.effort_levels.length > 0
    ? activeAgent.effort_levels
    : ["Low", "Medium", "High"];

  const currentModel = selectedModel || availableModels[0] || "claude-sonnet-5-5";
  const currentEffort = selectedEffort || availableEfforts[0] || "Medium";

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSendMessage(trimmed);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    // Auto-resize up to a max height
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
  };

  const handleDismissBanner = () => {
    setIsBannerDismissed(true);
    onDismissBanner?.();
  };

  const showBanner = !isBannerDismissed && Boolean(bannerMessage);

  return (
    <footer ref={containerRef} className="w-full max-w-3xl flex flex-col items-center px-4 select-none">
      {/* Usage / Token Banner */}
      {showBanner && (
        <div className="mb-2 flex w-full items-center justify-between rounded-lg border border-neutral-800/80 bg-[#161616]/95 px-3 py-1.5 text-xs text-neutral-300 shadow-lg backdrop-blur">
          <div className="flex items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap">
            <Clock size={13} className="text-amber-500 shrink-0" />
            <span className="truncate">{bannerMessage}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-2">
            <button
              type="button"
              aria-label="Upgrade"
              className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] font-medium text-amber-400 hover:bg-neutral-700 transition-colors cursor-pointer"
            >
              Upgrade
            </button>
            <button
              type="button"
              aria-label="Dismiss banner"
              onClick={handleDismissBanner}
              className="text-neutral-500 hover:text-neutral-300 transition-colors p-0.5 rounded cursor-pointer"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}

      {/* Floating Pill Composer */}
      <div
        className="w-full rounded-xl border border-[#262626] bg-[#121212] p-3 shadow-2xl transition-all focus-within:border-neutral-700 focus-within:ring-1 focus-within:ring-amber-500/20"
        style={{ boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }}
      >
        {/* Text Input Area */}
        <div className="w-full">
          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder={placeholder}
            className="w-full bg-transparent text-sm text-neutral-200 placeholder-neutral-500 outline-none resize-none leading-relaxed min-h-[26px] max-h-[180px]"
          />
        </div>

        {/* Controls Row */}
        <div className="mt-2 flex items-center justify-between border-t border-neutral-800/40 pt-2 text-xs">
          {/* Left Controls: Attach, Voice, Permission Mode */}
          <div className="flex items-center gap-1 relative">
            <button
              type="button"
              aria-label="Add attachment"
              onClick={onAttach}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors cursor-pointer"
            >
              <Plus size={15} />
            </button>

            <button
              type="button"
              aria-label="Voice dictation"
              onClick={onVoice}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors cursor-pointer"
            >
              <Mic size={15} />
            </button>

            {/* Permission Mode Dropdown Button */}
            <div className="relative">
              <button
                type="button"
                aria-label="Permission mode"
                onClick={() => setOpenDropdown(openDropdown === "permission" ? null : "permission")}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100 transition-colors cursor-pointer border border-neutral-800/60"
              >
                {permissionMode === "bypass" ? (
                  <ShieldAlert size={13} className="text-amber-500" />
                ) : (
                  <Shield size={13} className="text-emerald-500" />
                )}
                <span>{permissionMode === "bypass" ? "Bypass permissions" : "Ask every time"}</span>
                <ChevronDown size={11} className="text-neutral-500" />
              </button>

              {openDropdown === "permission" && (
                <div className="absolute bottom-full left-0 mb-2 w-48 rounded-lg border border-neutral-800 bg-[#181818] p-1 shadow-2xl z-50">
                  <button
                    type="button"
                    aria-label="Select bypass permissions"
                    onClick={() => {
                      onPermissionModeChange?.("bypass");
                      setOpenDropdown(null);
                    }}
                    className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-left transition-colors cursor-pointer ${
                      permissionMode === "bypass"
                        ? "bg-neutral-800 text-amber-400 font-medium"
                        : "text-neutral-300 hover:bg-neutral-800/60 hover:text-neutral-100"
                    }`}
                  >
                    <ShieldAlert size={13} className="text-amber-500 shrink-0" />
                    <div className="flex flex-col">
                      <span>Bypass permissions</span>
                      <span className="text-[10px] text-neutral-500 font-normal">Auto-approve bash/tools</span>
                    </div>
                  </button>

                  <button
                    type="button"
                    aria-label="Select ask every time"
                    onClick={() => {
                      onPermissionModeChange?.("ask");
                      setOpenDropdown(null);
                    }}
                    className={`mt-1 flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-left transition-colors cursor-pointer ${
                      permissionMode === "ask"
                        ? "bg-neutral-800 text-emerald-400 font-medium"
                        : "text-neutral-300 hover:bg-neutral-800/60 hover:text-neutral-100"
                    }`}
                  >
                    <Shield size={13} className="text-emerald-500 shrink-0" />
                    <div className="flex flex-col">
                      <span>Ask every time</span>
                      <span className="text-[10px] text-neutral-500 font-normal">Require action cards</span>
                    </div>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Right Controls: Thinking indicator, Model, Effort, Send */}
          <div className="flex items-center gap-2 relative">
            {/* Thinking Animated Ring */}
            {isThinking && (
              <div
                data-testid="thinking-indicator-ring"
                className="h-4 w-4 rounded-full border-2 border-amber-500/30 border-t-amber-500 animate-spin"
              />
            )}

            {/* Model Selector Dropdown */}
            <div className="relative">
              <button
                type="button"
                aria-label="Model selector"
                onClick={() => setOpenDropdown(openDropdown === "model" ? null : "model")}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100 transition-colors cursor-pointer border border-neutral-800/60"
              >
                <Cpu size={12} className="text-neutral-400" />
                <span className="max-w-[110px] truncate">{currentModel}</span>
                <ChevronDown size={11} className="text-neutral-500" />
              </button>

              {openDropdown === "model" && (
                <div className="absolute bottom-full right-0 mb-2 min-w-44 rounded-lg border border-neutral-800 bg-[#181818] p-1 shadow-2xl z-50">
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                    {activeAgent?.name || "Agent"} Models
                  </div>
                  {availableModels.map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-label={`Select model ${m.toLowerCase()}`}
                      onClick={() => {
                        onModelChange?.(m);
                        setOpenDropdown(null);
                      }}
                      className={`flex w-full items-center justify-between rounded px-2.5 py-1.5 text-xs text-left transition-colors cursor-pointer ${
                        currentModel === m
                          ? "bg-neutral-800 text-amber-400 font-medium"
                          : "text-neutral-300 hover:bg-neutral-800/60 hover:text-neutral-100"
                      }`}
                    >
                      <span className="truncate">{m}</span>
                      {currentModel === m && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Effort Selector Dropdown */}
            <div className="relative">
              <button
                type="button"
                aria-label="Effort selector"
                onClick={() => setOpenDropdown(openDropdown === "effort" ? null : "effort")}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100 transition-colors cursor-pointer border border-neutral-800/60"
              >
                <Gauge size={12} className="text-neutral-400" />
                <span>{currentEffort}</span>
                <ChevronDown size={11} className="text-neutral-500" />
              </button>

              {openDropdown === "effort" && (
                <div className="absolute bottom-full right-0 mb-2 w-32 rounded-lg border border-neutral-800 bg-[#181818] p-1 shadow-2xl z-50">
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                    Thinking Effort
                  </div>
                  {availableEfforts.map((e) => (
                    <button
                      key={e}
                      type="button"
                      aria-label={`Select effort ${e.toLowerCase()}`}
                      onClick={() => {
                        onEffortChange?.(e);
                        setOpenDropdown(null);
                      }}
                      className={`flex w-full items-center justify-between rounded px-2.5 py-1.5 text-xs text-left transition-colors cursor-pointer ${
                        currentEffort === e
                          ? "bg-neutral-800 text-amber-400 font-medium"
                          : "text-neutral-300 hover:bg-neutral-800/60 hover:text-neutral-100"
                      }`}
                    >
                      <span>{e}</span>
                      {currentEffort === e && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Send Button */}
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
