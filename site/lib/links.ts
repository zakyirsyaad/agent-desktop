/** Every place the site sends people. Downloads go to GitHub releases until the build is signed. */
const REPO = "https://github.com/zakyirsyaad/zorvo";

export const LINKS = {
  repo: REPO,
  releases: `${REPO}/releases`,
  installGuide: `${REPO}#install`,
  changelog: `${REPO}/blob/main/CHANGELOG.md`,
  security: `${REPO}/blob/main/SECURITY.md`,
} as const;
