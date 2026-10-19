# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately
with GitHub's
[private vulnerability reporting](https://github.com/zakyirsyaad/zorvo/security/advisories/new).

Please include:

- what an attacker could do;
- the steps or a proof of concept;
- the app version.

You will get an answer within a week. Once a fix is released, it is credited
to you unless you would rather not be named.

## Supported versions

Only the latest release gets security fixes.

## Scope

Zorvo runs coding agents on your machine with your permissions. These
are in scope:

- the app reading or running anything outside the folders you opened in it;
- a permission request answered without you;
- secrets leaking from the app;
- the web view running content it should not.

How an agent itself behaves (Qwen Code, Claude Code, Codex, Oh-My-Pi or Aider)
is a matter for that agent's own project.
