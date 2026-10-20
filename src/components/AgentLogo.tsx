import { Bot } from "lucide-react";
import { canonicalAgentId } from "../lib/persistence";
import { useAgentIcon } from "../lib/agent-icons";
import claudeCodeLogo from "../assets/agents/claude-code.svg";
import qwenLogo from "../assets/agents/qwen.svg";
import codexLogo from "../assets/agents/codex.svg";

/** The agents with an official logo, by profile id; see assets/agents/README.md. */
const LOGOS: Readonly<Record<string, string>> = {
  "claude-acp": claudeCodeLogo,
  "qwen-code": qwenLogo,
  "codex-acp": codexLogo,
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
  const id = canonicalAgentId(profileId);
  const logo = LOGOS[id];
  const registryIcon = useAgentIcon(id);
  const label = name ? { role: "img", "aria-label": name } : { "aria-hidden": true };
  if (!logo && registryIcon) {
    const mask = `url("${registryIcon}")`;
    return (
      <span
        {...label}
        className={`inline-block shrink-0 bg-fg-muted ${className}`}
        style={{
          maskImage: mask,
          WebkitMaskImage: mask,
          maskSize: "contain",
          maskRepeat: "no-repeat",
          maskPosition: "center",
          width: size,
          height: size,
        }}
      />
    );
  }
  if (!logo) {
    return <Bot size={size} {...label} className={`shrink-0 text-fg-muted ${className}`} />;
  }
  return <img src={logo} alt={name} width={size} height={size} className={`shrink-0 rounded-[3px] ${className}`} />;
}
