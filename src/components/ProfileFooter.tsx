import { Settings, User } from "lucide-react";

export interface ProfileFooterProps {
  /** `git config --global user.name`, when the user has one set. */
  name?: string;
  /** `git config --global user.email`, when the user has one set. */
  email?: string;
  /** Bundled app version; the version line is omitted when unknown. */
  version?: string;
  onOpenSettings?: () => void;
}

const FALLBACK_DISPLAY_NAME = "Local user";

/** Uppercased initials taken from up to the first two words of `name`. */
function initialsFromName(name?: string): string | null {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

/** Uppercased first alphanumeric character of the email's local part. */
function initialFromEmail(email?: string): string | null {
  const localPart = (email ?? "").trim().split("@")[0] ?? "";
  const first = [...localPart].find((character) => /[A-Za-z0-9]/.test(character));
  return first ? first.toUpperCase() : null;
}

/**
 * The signed-in developer's identity, read from their global git config.
 *
 * Nothing here is invented: there is no plan or tier badge, and when git has
 * neither a name nor an email the footer says so with a neutral label rather
 * than showing a hardcoded person.
 */
export function ProfileFooter({
  name,
  email,
  version,
  onOpenSettings,
}: ProfileFooterProps) {
  const trimmedName = name?.trim() || undefined;
  const trimmedEmail = email?.trim() || undefined;
  const displayName = trimmedName ?? trimmedEmail ?? FALLBACK_DISPLAY_NAME;
  const initials = initialsFromName(trimmedName) ?? initialFromEmail(trimmedEmail);

  return (
    <footer className="flex items-center justify-between border-t border-neutral-800/80 bg-[#0a0a0a] p-3">
      <div className="flex min-w-0 items-center gap-2">
        <span
          role="img"
          aria-label={`${displayName} avatar`}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-neutral-700/60 bg-neutral-800 text-[11px] font-semibold text-neutral-200"
        >
          {initials ?? <User size={13} aria-hidden="true" />}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-neutral-200">{displayName}</span>
          {version && (
            <span className="text-[10px] text-neutral-500">
              Agent Desktop v{version}
            </span>
          )}
        </div>
      </div>

      {onOpenSettings && (
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="Settings"
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-700"
        >
          <Settings size={14} />
        </button>
      )}
    </footer>
  );
}
