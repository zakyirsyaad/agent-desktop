import { describe, it, expect, vi } from "vitest";
import { COMPOSER_PLACEHOLDERS, composerCommandsFor, composerPlaceholder, composerStateFor, type ComposerInputs } from "../lib/composer-state";
import { NO_CHOICES, withRewound, type AgentOptions } from "../lib/acp-draft";
import { TRANSPORT_ACP, type AgentProfile, type Session, type SlashCommand } from "../types";

const IDLE = { isRunning: false, isCreatingWorktree: false, isResumable: false, canStartSession: false };

describe("composerPlaceholder", () => {
  it("shows none in a running session, and says what the next message does otherwise", () => {
    expect(composerPlaceholder({ ...IDLE, isRunning: true, isCreatingWorktree: true })).toBeUndefined();
    expect(composerPlaceholder({ ...IDLE, isCreatingWorktree: true, isResumable: true })).toBe(
      COMPOSER_PLACEHOLDERS.creatingWorktree,
    );
    expect(composerPlaceholder({ ...IDLE, isResumable: true, canStartSession: true })).toBe(COMPOSER_PLACEHOLDERS.resume);
    expect(composerPlaceholder({ ...IDLE, canStartSession: true })).toBe(COMPOSER_PLACEHOLDERS.newSession);
    expect(composerPlaceholder(IDLE)).toBe(COMPOSER_PLACEHOLDERS.noWorkspace);
  });

  it("asks for the agent's install before a message can start or continue a session", () => {
    expect(composerPlaceholder({ ...IDLE, canStartSession: true, agentToInstall: "Codex" })).toBe(
      "Install Codex to start a session.",
    );
    expect(composerPlaceholder({ ...IDLE, isResumable: true, canStartSession: true, agentToInstall: "Codex" })).toBe(
      "Install Codex to continue this session.",
    );
    // An ended chat whose agent is not installed continues once it is, though it cannot yet.
    expect(
      composerPlaceholder({ ...IDLE, canStartSession: true, isEndedSession: true, agentToInstall: "Codex" }),
    ).toBe("Install Codex to continue this session.");
    expect(composerPlaceholder({ ...IDLE, agentToInstall: "Codex" })).toBe(COMPOSER_PLACEHOLDERS.noWorkspace);
    expect(composerPlaceholder({ ...IDLE, isCreatingWorktree: true, agentToInstall: "Codex" })).toBe(
      COMPOSER_PLACEHOLDERS.creatingWorktree,
    );
  });
});

describe("composerCommandsFor", () => {
  const live: SlashCommand[] = [{ name: "init", description: "Set up" }];
  const remembered: SlashCommand[] = [{ name: "review", description: "Review" }];
  const acpSession = { transport: TRANSPORT_ACP } as Session;
  const acpAgent = { id: "qwen" } as AgentProfile;
  const options = { qwen: { modes: null, configOptions: [], commands: remembered } };

  it("offers a live ACP session's own commands, and an old terminal session's none", () => {
    expect(composerCommandsFor({ session: acpSession, isRunning: true, liveCommands: live, draftAgent: acpAgent, agentOptions: options })).toBe(live);
    expect(
      composerCommandsFor({ session: { transport: "pty" } as Session, isRunning: true, liveCommands: live, draftAgent: acpAgent, agentOptions: options }),
    ).toBeUndefined();
  });

  it("offers the commands an ACP agent reported last time before it runs", () => {
    expect(composerCommandsFor({ session: undefined, isRunning: false, liveCommands: undefined, draftAgent: acpAgent, agentOptions: options })).toBe(
      remembered,
    );
    expect(
      composerCommandsFor({ session: undefined, isRunning: false, liveCommands: undefined, draftAgent: { id: "other" } as AgentProfile, agentOptions: options }),
    ).toBeUndefined();
  });
});

describe("withRewound", () => {
  const remembered: Record<string, AgentOptions> = {
    qwen: { modes: null, configOptions: [], preferredConfig: { model: "max" }, commands: [] },
  };
  const rewound = {
    configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "coder", options: [] }],
    preferredConfig: { model: "coder" },
  };

  it("puts a rewound session's own picks and lists in place of the agent's remembered ones", () => {
    const options = withRewound(remembered, "qwen", rewound);

    expect(options?.qwen.preferredConfig).toEqual({ model: "coder" });
    expect(options?.qwen.configOptions).toBe(rewound.configOptions);
    expect(options?.qwen.commands).toEqual([]);
    expect(remembered.qwen.preferredConfig).toEqual({ model: "max" });
  });

  it("leaves the remembered options as they are without a rewound session", () => {
    expect(withRewound(remembered, "qwen", undefined)).toBe(remembered);
    expect(withRewound(remembered, undefined, rewound)).toBe(remembered);
  });

  it("works for an agent with nothing remembered yet", () => {
    expect(withRewound(undefined, "qwen", rewound)?.qwen).toMatchObject({ modes: null, preferredConfig: { model: "coder" } });
  });
});

describe("composerStateFor", () => {
  const info = {
    modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] },
    configOptions: [],
  };
  const setMode = vi.fn();
  const acp = { info: { "s-1": info }, setMode, setConfigOption: vi.fn() } as unknown as ComposerInputs["acp"];
  const running = (transport: string) => ({ id: "s-1", status: "running", transport }) as Session;
  const draftAgent = { id: "qwen" } as AgentProfile;
  const inputs = (overrides: Partial<ComposerInputs>): ComposerInputs => ({
    session: undefined,
    draftAgent: undefined,
    acpChoices: NO_CHOICES,
    setAcpChoices: vi.fn(),
    agentOptions: undefined,
    acp,
    ...overrides,
  });

  it("offers an old terminal session no controls", () => {
    const state = composerStateFor(inputs({ session: running("pty"), draftAgent }));

    expect(state).toEqual({ controls: {}, locked: false });
  });

  it("builds a running ACP session's controls from what its agent reported", () => {
    const state = composerStateFor(inputs({ session: running(TRANSPORT_ACP) }));

    expect(state.locked).toBe(false);
    expect(state.controls.permission?.options.map((o) => o.label)).toEqual(["Default", "Plan"]);
    state.controls.permission?.onChange("plan");
    expect(setMode).toHaveBeenCalledWith("s-1", "plan");
  });

  it("offers no controls while a running ACP session has reported nothing", () => {
    const state = composerStateFor(inputs({ session: running(TRANSPORT_ACP), acp: { ...acp, info: {} } as ComposerInputs["acp"] }));

    expect(state).toEqual({ controls: {}, locked: false });
  });

  it("offers no controls without a draft agent", () => {
    expect(composerStateFor(inputs({}))).toEqual({ controls: {}, locked: false });
  });

  it("builds a draft agent's controls from the options it reported last time", () => {
    const setAcpChoices = vi.fn();
    const state = composerStateFor(
      inputs({ draftAgent, setAcpChoices, agentOptions: { qwen: { modes: info.modes, configOptions: [] } } }),
    );

    expect(state.locked).toBe(false);
    expect(state.controls.permission?.selected).toBe("default");
    state.controls.permission?.onChange("plan");
    expect(setAcpChoices).toHaveBeenCalledWith({ config: {}, modeId: "plan" });
  });

  it("offers a draft agent that reported nothing no controls", () => {
    expect(composerStateFor(inputs({ draftAgent, agentOptions: {} }))).toEqual({ controls: {}, locked: false });
  });
});
