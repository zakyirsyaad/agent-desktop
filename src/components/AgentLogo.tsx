import { Bot } from "lucide-react";
import claudeCodeLogo from "../assets/agents/claude-code.svg";
import qwenLogo from "../assets/agents/qwen.svg";
import codexLogo from "../assets/agents/codex.svg";

/** The agents with an official logo, by profile id; see assets/agents/README.md. */
const LOGOS: Readonly<Record<string, string>> = {
  "claude-code": claudeCodeLogo,
  qwen: qwenLogo,
  codex: codexLogo,
};

export interface AgentLogoProps {
  profileId: string;
  /** The agent's name, read out in place of the logo; "" when the name is written next to it. */
  name: string;
  size?: number;
  className?: string;
}

/** An agent's own logo, or a generic agent icon for one without an official logo. */
export function AgentLogo({ profileId, name, size = 13, className = "" }: AgentLogoProps) {
  const logo = LOGOS[profileId];
  if (!logo) {
    const label = name ? { role: "img", "aria-label": name } : { "aria-hidden": true };
    return <Bot size={size} {...label} className={`shrink-0 text-neutral-400 ${className}`} />;
  }
  return <img src={logo} alt={name} width={size} height={size} className={`shrink-0 rounded-[3px] ${className}`} />;
}
