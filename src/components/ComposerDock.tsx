import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Plus, CornerDownLeft, Shield, ShieldAlert, Cpu, Gauge, Square } from "lucide-react";
import { OptionDropdown } from "./composer/OptionDropdown";
import { appendAttachments, withAttachments } from "../lib/attachments";
import { AttachmentChips } from "./composer/AttachmentChips";
import { ContextMeter } from "./composer/ContextMeter";
import { isRiskyMode, type ComposerControl, type ComposerControls } from "../lib/composer-controls";
import { matchingCommands, pendingHint, slashQuery } from "../lib/slash-commands";
import { SlashCommandMenu } from "./composer/SlashCommandMenu";
import type { ContextUsage, SlashCommand } from "../types";

const MAX_PROMPT_HEIGHT_PX = 180;
const PLACEHOLDER = "Prompt the agent...";
const PLACEHOLDER_WITH_COMMANDS = "Type / for commands, or prompt the agent...";
const LOCKED_OPTIONS_TITLE = "Applies to the next new session: CLI flags are set when an agent starts.";

type OpenDropdown = "permission" | "model" | "effort" | null;

/** What other parts of the window can do to the composer. */
export interface ComposerHandle {
  /** Adds paths to the prompt (quoted when needed) and focuses it. */
  insertPaths: (paths: readonly string[]) => void;
  /** Puts back a message that could not be sent, so it need not be typed again. */
  restore: (text: string, attachments?: readonly string[]) => void;
}

export interface ComposerDockProps {
  /** Dropdowns to show; each is omitted when the agent offers no real choice. */
  controls?: ComposerControls;
  /** True for a running terminal session: its flags were fixed when it started. */
  optionsLocked?: boolean;
  /** True while the agent is working on a turn. */
  isThinking?: boolean;
  /** Interrupts the agent's current turn; shown in place of Send while it works. */
  onStop?: () => void;
  placeholder?: string;
  disabled?: boolean;
  /** `attachments` are file paths, given only when `attachAsFiles` is set. */
  onSendMessage: (message: string, attachments?: string[]) => void;
  /** Opens a file picker and resolves with the chosen paths; hidden when absent. */
  onAttach?: () => Promise<string[]>;
  handleRef?: Ref<ComposerHandle>;
  /** The agent's slash commands; typing `/` lists them. */
  commands?: SlashCommand[];
  /**
   * True when the agent takes files with the message (ACP): attached files
   * show as chips and are sent apart from the text. Otherwise their paths
   * are typed into the prompt.
   */
  attachAsFiles?: boolean;
  /** How much of the agent's context window is used; the meter shows once the agent reports it. */
  contextUsage?: ContextUsage;
}

export function ComposerDock({
  controls = {},
  optionsLocked = false,
  isThinking = false,
  onStop,
  placeholder,
  disabled = false,
  onSendMessage,
  onAttach,
  handleRef,
  commands = [],
  attachAsFiles = false,
  contextUsage,
}: ComposerDockProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [isMenuDismissed, setIsMenuDismissed] = useState(false);
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

  const toggle = (name: Exclude<OpenDropdown, null>) =>
    setOpenDropdown((current) => (current === name ? null : name));
  const dropdownProps = (name: Exclude<OpenDropdown, null>, control: ComposerControl) => ({
    options: control.options,
    selected: control.selected,
    isOpen: openDropdown === name,
    onToggle: () => toggle(name),
    onSelect: (value: string | undefined) => {
      control.onChange(value);
      setOpenDropdown(null);
    },
    disabled: optionsLocked,
    disabledTitle: LOCKED_OPTIONS_TITLE,
  });

  // While the agent works, Stop takes Send's place; the draft waits for the turn to end.
  const canSend = !disabled && !(isThinking && onStop);

  const handleSend = () => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || !canSend) return;
    if (attachAsFiles) onSendMessage(trimmed, attachments);
    else onSendMessage(trimmed);
    setText("");
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const query = slashQuery(text);
  const menuCommands = query === null || isMenuDismissed ? [] : matchingCommands(commands, query);
  const hint = pendingHint(commands, text);

  const pickCommand = (command: SlashCommand) => {
    setText(`/${command.name} `);
    textareaRef.current?.focus();
  };

  /** Arrow keys, Enter/Tab and Escape drive the command menu while it is open. */
  const handleMenuKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (menuCommands.length === 0) return false;
    const last = menuCommands.length - 1;
    if (e.key === "ArrowDown") setHighlighted((i) => (i >= last ? 0 : i + 1));
    else if (e.key === "ArrowUp") setHighlighted((i) => (i <= 0 ? last : i - 1));
    else if (e.key === "Enter" || e.key === "Tab") pickCommand(menuCommands[Math.min(highlighted, last)]);
    else if (e.key === "Escape") setIsMenuDismissed(true);
    else return false;
    e.preventDefault();
    return true;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (handleMenuKey(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    setHighlighted(0);
    setIsMenuDismissed(false);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, MAX_PROMPT_HEIGHT_PX)}px`;
  };

  const insertPaths = (paths: readonly string[]) => {
    if (attachAsFiles) setAttachments((current) => withAttachments(current, paths));
    else setText((current) => appendAttachments(current, paths));
    textareaRef.current?.focus();
  };

  useImperativeHandle(handleRef, () => ({
    insertPaths,
    restore: (restoredText, restoredAttachments = []) => {
      setText(restoredText);
      if (attachAsFiles) setAttachments([...restoredAttachments]);
      textareaRef.current?.focus();
    },
  }));

  const handleAttach = async () => {
    if (!onAttach) return;
    insertPaths(await onAttach());
  };

  const { permission, model, effort } = controls;
  const isRiskyPermission = isRiskyMode(permission?.selected);

  return (
    <footer ref={containerRef} className="w-full max-w-3xl flex flex-col items-center px-4 select-none">
      <div
        className="relative w-full rounded-xl border border-[#262626] bg-[#121212] p-3 shadow-2xl transition-all focus-within:border-neutral-700 focus-within:ring-1 focus-within:ring-amber-500/20"
        style={{ boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }}
      >
        {attachments.length > 0 && (
          <div className="mb-2">
            <AttachmentChips
              paths={attachments}
              onRemove={(path) => setAttachments((current) => current.filter((p) => p !== path))}
            />
          </div>
        )}
        {menuCommands.length > 0 && (
          <SlashCommandMenu commands={menuCommands} highlighted={highlighted} onPick={pickCommand} />
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder ?? (commands.length > 0 ? PLACEHOLDER_WITH_COMMANDS : PLACEHOLDER)}
          aria-label="Prompt"
          className="w-full bg-transparent text-sm text-neutral-200 placeholder-neutral-500 outline-none resize-none leading-relaxed min-h-[26px] max-h-[180px]"
        />

        {hint && <p className="mt-1 text-[11px] text-neutral-500">{hint}</p>}

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

            {permission && (
              <OptionDropdown
                label="Permission mode"
                align="left"
                icon={
                  isRiskyPermission ? (
                    <ShieldAlert size={13} className="text-amber-500" data-testid="risky-permission-icon" />
                  ) : (
                    <Shield size={13} className="text-emerald-500" />
                  )
                }
                {...dropdownProps("permission", permission)}
              />
            )}
          </div>

          <div className="flex items-center gap-2">
            {contextUsage && <ContextMeter used={contextUsage.used} size={contextUsage.size} />}

            {model && (
              <OptionDropdown
                label="Model"
                icon={<Cpu size={12} className="text-neutral-400" />}
                {...dropdownProps("model", model)}
              />
            )}

            {effort && (
              <OptionDropdown
                label="Effort"
                icon={<Gauge size={12} className="text-neutral-400" />}
                {...dropdownProps("effort", effort)}
              />
            )}

            {isThinking && onStop ? (
              <button
                type="button"
                aria-label="Stop agent"
                title="Stop the agent's current turn"
                onClick={onStop}
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-neutral-200 text-neutral-900 hover:bg-white transition-all cursor-pointer"
              >
                <Square size={12} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Send message"
                onClick={handleSend}
                disabled={(!text.trim() && attachments.length === 0) || disabled}
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-neutral-200 text-neutral-900 hover:bg-white disabled:opacity-30 disabled:hover:bg-neutral-200 transition-all font-medium cursor-pointer"
              >
                <CornerDownLeft size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </footer>
  );
}
